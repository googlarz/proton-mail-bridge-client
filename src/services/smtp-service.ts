import { randomUUID } from "node:crypto";
import nodemailer, { type SentMessageInfo, type Transporter } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import sanitizeHtml from "sanitize-html";
import type { ProtonMailConfig, SendEmailInput } from "../types/index.js";
import { logger } from "../utils/logger.js";

export function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n\0]/g, " ").trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// PROTONMAIL_SIGNATURE is plain text; appended to both the text body and,
// for HTML mail, as a <br><br> separated block escaped into the markup
// (kept simple — not itself HTML, so no separate sanitization concern).
//
// Exported so callers that wrap the user's own text in something else (a
// reply's quoted original, a forward's "---------- Forwarded message
// ---------" block) can apply the signature to their own text BEFORE
// wrapping it, instead of buildMailOptions appending it to the very end —
// after the quote — which reads as if it were part of the quoted material.
export function applySignature(
  body: string,
  htmlBody: string | undefined,
  appendSignature: boolean | undefined,
): { body: string; htmlBody: string | undefined } {
  const signature = process.env.PROTONMAIL_SIGNATURE?.trim();
  const shouldAppend = appendSignature !== false && Boolean(signature);
  if (!shouldAppend) {
    return { body, htmlBody };
  }
  return {
    body: `${body}\n\n${signature}`,
    htmlBody: htmlBody ? `${htmlBody}<br><br>${escapeHtml(signature as string).replace(/\n/g, "<br>")}` : htmlBody,
  };
}

export class SMTPService {
  private transporter?: Transporter;

  constructor(private readonly config: ProtonMailConfig) {}

  async verifyConnection(): Promise<void> {
    const transporter = this.getTransporter();
    await transporter.verify();
  }

  async sendEmail(input: SendEmailInput): Promise<SentMessageInfo> {
    const transporter = this.getTransporter();
    return transporter.sendMail(this.buildMailOptions(input));
  }

  async buildRawMessage(input: SendEmailInput): Promise<Buffer> {
    const composer = new MailComposer(this.buildMailOptions(input));
    return new Promise<Buffer>((resolve, reject) => {
      composer.compile().build((error, message) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(message);
      });
    });
  }

  async sendTestEmail(to: string, customMessage?: string): Promise<SentMessageInfo> {
    const message =
      customMessage ??
      [
        "This is a ProtonMail MCP connectivity test.",
        "",
        `Sent at ${new Date().toISOString()}.`,
      ].join("\n");

    return this.sendEmail({
      to: [to],
      subject: "ProtonMail MCP test email",
      body: message,
      isHtml: false,
    });
  }

  async close(): Promise<void> {
    if (!this.transporter) {
      return;
    }

    this.transporter.close();
    this.transporter = undefined;
  }

  private getTransporter(): Transporter {
    if (!this.transporter) {
      const host = this.config.smtp.host.trim().toLowerCase();
      const isLocalhost = host === "127.0.0.1" || host === "localhost" || host === "::1";

      this.transporter = nodemailer.createTransport({
        host: this.config.smtp.host,
        port: this.config.smtp.port,
        secure: this.config.smtp.secure,
        auth: {
          user: this.config.smtp.username,
          pass: this.config.smtp.password,
        },
        tls: isLocalhost ? { rejectUnauthorized: false } : undefined,
      });
    }

    return this.transporter;
  }

  private sanitizeHtmlContent(html: string): string {
    return sanitizeHtml(html, {
      allowedTags: [
        "p",
        "br",
        "b",
        "i",
        "u",
        "strong",
        "em",
        "a",
        "ul",
        "ol",
        "li",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "blockquote",
        "code",
        "pre",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "span",
        "div",
      ],
      allowedAttributes: {
        a: ["href"],
        "*": [],
      },
      allowedSchemes: ["http", "https", "mailto"],
      allowedSchemesAppliedToAttributes: ["href", "src"],
    });
  }

  private buildMailOptions(input: SendEmailInput): Record<string, unknown> {
    const attachments = (input.attachments ?? []).map((attachment) => {
      const contentDisposition: "attachment" | "inline" | undefined =
        attachment.contentDisposition === "inline"
          ? "inline"
          : attachment.contentDisposition === "attachment"
            ? "attachment"
            : undefined;

      return {
        filename: attachment.filename,
        content: Buffer.from(attachment.content, "base64"),
        contentType: attachment.contentType,
        cid: attachment.cid,
        contentDisposition,
        encoding: "base64",
      };
    });

    const fromAddress = this.config.smtp.username;
    const fromName = input.fromName ? sanitizeHeader(input.fromName).replace(/"/g, "") : undefined;
    const subject = sanitizeHeader(input.subject);
    const replyTo = input.replyTo ? sanitizeHeader(input.replyTo) : undefined;
    const messageId = input.messageId
      ? sanitizeHeader(input.messageId)
      : `<${randomUUID()}@protonmail.local>`;
    const inReplyTo = input.inReplyTo ? sanitizeHeader(input.inReplyTo) : undefined;
    const references = Array.isArray(input.references)
      ? input.references.map((reference) => sanitizeHeader(reference))
      : input.references
        ? sanitizeHeader(input.references)
        : undefined;
    const from = fromName
      ? `"${fromName}" <${fromAddress}>`
      : fromAddress;

    const unsafeHtmlAllowed = process.env.PROTONMAIL_ALLOW_UNSAFE_HTML === "true";
    if (input.sanitizeHtml === false && !unsafeHtmlAllowed) {
      logger.warn(
        "sanitizeHtml=false was suppressed because PROTONMAIL_ALLOW_UNSAFE_HTML is not true.",
        "SMTPService",
      );
    }
    const shouldSanitize = (input.sanitizeHtml !== false || !unsafeHtmlAllowed)
      && (input.isHtml || input.htmlBody !== undefined);
    const htmlContent = input.htmlBody ?? (input.isHtml ? input.body : undefined);
    const sanitizedHtml = shouldSanitize && htmlContent
      ? this.sanitizeHtmlContent(htmlContent)
      : htmlContent;

    // Sanitization can legitimately reduce a body to nothing (e.g. it was only a
    // <script> tag or other disallowed markup with no surviving visible text).
    // If we let that through, applySignature treats an empty htmlBody as "leave
    // unchanged" so it's never restored, and `text` below falls back to undefined
    // because isHtml is true — the result is a completely blank send with no
    // warning to the caller. Fail loudly instead so the caller can fix their input.
    if (input.isHtml && shouldSanitize && htmlContent && !sanitizedHtml?.trim()) {
      throw new Error(
        "The email body was empty after removing disallowed HTML content (scripts, unsafe markup). Provide plain text or valid HTML content.",
      );
    }

    const { body: finalBody, htmlBody: finalHtml } = applySignature(input.body, sanitizedHtml, input.appendSignature);

    return {
      from,
      to: input.to.join(", "),
      cc: input.cc?.join(", "),
      bcc: input.bcc?.join(", "),
      subject,
      text: finalHtml ? finalBody : (input.isHtml ? undefined : finalBody),
      html: finalHtml,
      replyTo,
      inReplyTo,
      references,
      messageId,
      attachments,
      priority: input.priority ?? "normal",
      // Requests an MDN (read receipt) from the recipient's mail client — most
      // clients ask the user before honoring it, this is a request not a guarantee.
      headers: input.requestReadReceipt ? { "Disposition-Notification-To": fromAddress } : undefined,
    };
  }
}
