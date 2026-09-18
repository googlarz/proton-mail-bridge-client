import { randomUUID } from "node:crypto";
import nodemailer, { type SentMessageInfo, type Transporter } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import sanitizeHtml from "sanitize-html";
import type { ProtonMailConfig, SendEmailInput } from "../types/index.js";
import { htmlToMarkdown, isValidEmail } from "../utils/helpers.js";
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

// Plain-text sends (isHtml: false, no explicit htmlBody) used to go out with NO html
// part at all — a real mail client renders that as "plain text", not "normal text",
// and applySignature's html branch never fires because there's no htmlBody for it to
// append the (HTML-escaped, <br>-joined) signature block to. So a plain-text send's
// signature only ever reached the text/plain part, and any client preferring the html
// part just... didn't show one. Auto-deriving an html alternative from the same text
// (escaped, newlines as <br>) means every send is multipart/alternative like a normal
// mail client, and the signature gets its HTML treatment on this path too.
// Exported so callers building their own HTML quote/forward blocks from plain
// text (see buildReplyHtml/buildForwardHtml in index.ts) can reuse the exact
// same escape-then-<br> conversion instead of a second, parallel implementation.
export function plainTextToHtml(text: string): string {
  return escapeHtml(text).replace(/\n/g, "<br>");
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
  // When isHtml is true and there's no separate htmlBody, `body` itself IS the
  // HTML source (see buildMailOptions's htmlContent derivation: `input.htmlBody ??
  // (input.isHtml ? input.body : ...)`) — but reply_to_email/reply_all_email/
  // forward_email call this BEFORE that point, to insert the signature ahead of
  // the quoted/forwarded content rather than after it, and used to always treat
  // `body` as plain text regardless of isHtml. That glued a literal `\n\n` (which
  // HTML collapses, so multiple lines visually ran together) and an UNESCAPED
  // signature onto raw HTML — sanitizeHtmlContent then stripped anything in the
  // signature that looked like a disallowed tag (e.g. a signature containing
  // literal "<Sales>" vanished outright instead of rendering as text). Passing
  // isHtml lets this branch the same way the separate-htmlBody case already does:
  // escape the signature and join with <br> instead of a raw newline.
  isHtml?: boolean,
): { body: string; htmlBody: string | undefined } {
  const signature = process.env.PROTONMAIL_SIGNATURE?.trim();
  const shouldAppend = appendSignature !== false && Boolean(signature);
  if (!shouldAppend) {
    return { body, htmlBody };
  }
  if (isHtml && htmlBody === undefined) {
    return {
      body: `${body}<br><br>${escapeHtml(signature as string).replace(/\n/g, "<br>")}`,
      htmlBody,
    };
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

  async sendTestEmail(to: string, customMessage?: string, from?: string): Promise<SentMessageInfo> {
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
      from,
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
        "img",
      ],
      allowedAttributes: {
        a: ["href"],
        // width/height are cosmetic sizing hints for an inline image (e.g. a
        // signature logo), not something that can carry an exfiltration risk
        // the way src's scheme can.
        img: ["src", "alt", "width", "height"],
        "*": [],
      },
      allowedSchemes: ["http", "https", "mailto"],
      // Found live (external review): a signature configured with an inline
      // logo (attached with a Content-ID, referenced as <img src="cid:...">,
      // the standard way a mail client embeds a signature image) survived as
      // an attachment but its <img> tag was stripped entirely — img wasn't in
      // allowedTags at all — so the logo was never displayed. Allowed now, but
      // ONLY for the "cid" scheme (via allowedSchemesByTag, overriding the
      // general allowedSchemes above for this one tag) — not http/https. This
      // is OUTBOUND content sanitization: an img src reaching an external
      // http(s) URL would let a prompt-injected "signature" or quoted
      // original exfiltrate data through the URL when the recipient's client
      // loads it. cid: only ever resolves to this message's own attached
      // parts, so it carries none of that risk.
      allowedSchemesByTag: {
        img: ["cid"],
      },
      allowedSchemesAppliedToAttributes: ["href", "src"],
      // Found live (external review): allowedSchemesByTag only checks a URL that
      // HAS an explicit scheme — a protocol-relative URL like
      // "//tracking.example/pixel?token=..." has none, so sanitize-html's own
      // default (allowProtocolRelative: true) let it straight through even
      // though img is scoped to "cid" above, reopening the exact remote-image
      // exfiltration risk the cid-only restriction exists to close. Any
      // recipient client that resolves it and loads remote images fires a
      // request to that host.
      allowProtocolRelative: false,
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

    // input.from lets a caller send as any of the account's own aliases/additional
    // addresses rather than always the one Bridge happens to be logged in as — Proton's
    // outgoing MTA accepts any address verified on the account regardless of Bridge's
    // login identity. Only validated for shape here; an address not on the account is
    // rejected by Proton at send time, same as it would be from any other mail client.
    const fromAddress = input.from && isValidEmail(input.from) ? input.from : this.config.smtp.username;
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
    // Plain-text case (isHtml false, no htmlBody supplied): derive an html
    // alternative from the same text instead of sending text-only — see
    // plainTextToHtml's comment. Already escaped, so it's excluded from
    // shouldSanitize above (sanitizing it again would be a no-op anyway).
    const htmlContent = input.htmlBody ?? (input.isHtml ? input.body : (input.body ? plainTextToHtml(input.body) : undefined));
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

    // When isHtml is true and the caller didn't supply a separate htmlBody, input.body IS the
    // HTML source — the normal send_email/reply/forward/send_draft shape when an agent
    // supplies HTML. finalBody is that same raw, PRE-sanitization HTML (applySignature only
    // appends a signature; it doesn't sanitize), so using it as the text/plain part put
    // whatever sanitizeHtmlContent had just stripped (script tags, javascript: URIs) back into
    // the message verbatim, and showed literal HTML markup to any plain-text-preferring
    // client. Only this case needs a real conversion; when htmlBody was supplied separately,
    // input.body is genuine author-provided plain text and must be left exactly as before.
    const isRawHtmlBody = Boolean(input.isHtml) && input.htmlBody === undefined;
    const textBody = isRawHtmlBody ? htmlToMarkdown(finalHtml) : finalBody;

    return {
      from,
      to: input.to.join(", "),
      cc: input.cc?.join(", "),
      bcc: input.bcc?.join(", "),
      subject,
      text: finalHtml ? textBody : (input.isHtml ? undefined : finalBody),
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
