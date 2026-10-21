import { join, resolve as pathResolve, sep as pathSep } from "node:path";
import { writeAttachmentToDownloadDir } from "./drafts-support.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { attachmentSource } from "./resources.js";
import { createTextResult } from "./results.js";
import { normalizeBoolean, sanitizeFileName, isPathInside } from "../utils/helpers.js";
import { requireString, optionalString } from "./args.js";
import type { ToolContext } from "./context.js";
import type { ToolResult } from "./results.js";
// The attachment tools: list, read as data or text, and save to the download directory.

export async function handleAttachmentTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { config, resolveAccountForEmailId, prefixedIdFor } = ctx;
  switch (name) {
    case "list_attachments":
    {
      const rawEmailId = requireString(args, "emailId");
      const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
      const attachmentList = await bundle.imapService.listAttachments(emailId);
      const includeInline = normalizeBoolean(args.includeInline, true);
      const filenameContains = optionalString(args, "filenameContains");
      const contentType = optionalString(args, "contentType");
      const filtered = attachmentList.attachments.filter((attachment) => {
        if (!includeInline && attachment.isInline) {
          return false;
        }
        if (
          filenameContains &&
          !(attachment.filename || "").toLowerCase().includes(filenameContains.toLowerCase())
        ) {
          return false;
        }
        if (
          contentType &&
          (attachment.contentType || "").toLowerCase() !== contentType.toLowerCase()
        ) {
          return false;
        }
        return true;
      });
      const result = {
        emailId: prefixedIdFor(bundle, attachmentList.emailId),
        attachments: filtered,
      };
      return createTextResult(
        result,
        false,
        result.attachments.map((attachment) => attachmentSource(result.emailId, attachment)),
      );
    }

    case "get_attachment_content":
    {
      const rawEmailId = requireString(args, "emailId");
      const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
      const saveTo = optionalString(args, "saveTo");
      if (saveTo) {
        // A save writes to disk: it needs the download directory, and the inline-size limit (which bounds
        // what is returned in the reply) does not apply. Checked before the attachment is fetched.
        const downloadDir = config.runtime.allowFileDownloadDir;
        if (!downloadDir) {
          throw new McpError(ErrorCode.InvalidParams, "PROTONMAIL_ALLOW_FILE_DOWNLOAD_DIR env var is not set.");
        }
        const saving = await bundle.imapService.getAttachmentContent(emailId, requireString(args, "attachmentId"), { forSave: true });
        const buf = Buffer.from(saving.base64 ?? "", "base64");
        const target = /[\\/]$/.test(saveTo) ? saveTo + sanitizeFileName(saving.attachment?.filename, "attachment") : saveTo;
        const savedPath = await writeAttachmentToDownloadDir(downloadDir, target, buf);
        return createTextResult({ saved: true, path: savedPath, bytes: buf.length, filename: saving.attachment?.filename });
      }
      const result = await bundle.imapService.getAttachmentContent(
        emailId,
        requireString(args, "attachmentId"),
        normalizeBoolean(args.includeBase64, false) || normalizeBoolean(args.asImage, false),
      );
      result.emailId = prefixedIdFor(bundle, result.emailId);
      if (result.base64) {
        const MAX_INLINE_BYTES = (config.runtime.maxInlineBytes ?? 40) * 1024;
        const decodedSize = Math.floor(result.base64.length * 0.75);
        if (decodedSize > MAX_INLINE_BYTES) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Attachment is ~${Math.round(decodedSize / 1024)}KB decoded. Inline limit is ${config.runtime.maxInlineBytes ?? 40}KB. Set PROTONMAIL_ALLOW_FILE_DOWNLOAD_DIR and pass saveTo to write to disk instead, or increase the limit with PROTONMAIL_MAX_INLINE_KB.`,
          );
        }
      }
      const imageType = String(result.attachment?.contentType ?? "").toLowerCase();
      if (normalizeBoolean(args.asImage, false) && result.base64 && /^image\/(png|jpeg|gif|webp)$/.test(imageType)) {
        const { base64, ...metadata } = result;
        const text = createTextResult({ ...metadata, returnedAs: "image" }, false, [attachmentSource(result.emailId, result.attachment)]);
        text.content.push({ type: "image", data: base64, mimeType: imageType });
        return text;
      }
      return createTextResult(result, false, [attachmentSource(result.emailId, result.attachment)]);
    }

    case "get_attachment_text": {
      const rawEmailId = requireString(args, "emailId");
      const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
      const result = await bundle.imapService.getAttachmentText(
        emailId,
        requireString(args, "attachmentId"),
      );
      result.emailId = prefixedIdFor(bundle, result.emailId);
      return createTextResult(result, false, [attachmentSource(result.emailId, result.attachment)]);
    }

    case "save_attachment":
    {
      const rawEmailId = requireString(args, "emailId");
      const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
      const saveTo = optionalString(args, "saveTo");
      const outputPath = optionalString(args, "outputPath");
      let resolvedPath = outputPath;
      if (saveTo) {
        const allowDir = config.runtime.allowFileDownloadDir;
        if (!allowDir) throw new McpError(ErrorCode.InvalidParams, "PROTONMAIL_ALLOW_FILE_DOWNLOAD_DIR must be set to use saveTo.");
        const absDir = pathResolve(allowDir);
        const absTarget = pathResolve(join(absDir, saveTo));
        // See the identical fix/comment in get_attachment_content above —
        // hardcoded "/" never matched a real subdirectory path on win32.
        if (!isPathInside(absDir, absTarget, pathSep)) {
          throw new McpError(ErrorCode.InvalidParams, "saveTo path escapes the allowed directory.");
        }
        // pathResolve drops a trailing slash; keep it so the service saves into the folder under the file's own name.
        resolvedPath = /[\\/]$/.test(saveTo) ? absTarget + pathSep : absTarget;
      }
      const result = await bundle.imapService.saveAttachment(
        emailId,
        requireString(args, "attachmentId"),
        resolvedPath,
      );
      result.emailId = prefixedIdFor(bundle, result.emailId);
      return createTextResult(result, false, [attachmentSource(result.emailId, result.attachment)]);
    }

    case "save_attachments":
    {
      const rawEmailId = requireString(args, "emailId");
      const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
      const result = await bundle.imapService.saveAttachments({
        emailId,
        outputPath: optionalString(args, "outputPath"),
        includeInline: normalizeBoolean(args.includeInline, false),
        filenameContains: optionalString(args, "filenameContains"),
        contentType: optionalString(args, "contentType"),
      });
      result.emailId = prefixedIdFor(bundle, result.emailId);
      return createTextResult(
        result,
        false,
        result.saved.map((entry) => attachmentSource(result.emailId, entry.attachment)),
      );
    }

    default:
      throw new Error(`handleAttachmentTool: unexpected tool ${name}`);
  }
}
