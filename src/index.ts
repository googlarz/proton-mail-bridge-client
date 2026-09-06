#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { isMainModule } from "./is-main.js";
import { AnalyticsService } from "./services/analytics-service.js";
import { AuditService } from "./services/audit-service.js";
import { BackgroundSyncService } from "./services/background-sync-service.js";
import { DeliveryQueueService } from "./services/delivery-queue-service.js";
import { DraftStoreService } from "./services/draft-store-service.js";
import { LocalIndexService } from "./services/local-index-service.js";
import { BULK_ITEM_TIMEOUT_MS, describeImapError, isLikelyAuthenticationError, isLikelyConnectionError, SimpleIMAPService } from "./services/simple-imap-service.js";
import { applySignature, SMTPService } from "./services/smtp-service.js";
import { SnoozeService } from "./services/snooze-service.js";
import { TemplateService } from "./services/template-service.js";
import type {
  BatchActionEntry,
  BatchActionResult,
  BulkMatchCriteria,
  BulkOperationResult,
  CitationSource,
  DraftRecord,
  EmailAction,
  EmailAddress,
  EmailAttachmentInput,
  EmailDetail,
  EmailSummary,
  ProtonMailConfig,
  SendEmailInput,
} from "./types/index.js";
import {
  ensureValidEmails,
  foldQuotedHistory,
  isTextLikeMimeType,
  isValidEmail,
  lowerCaseAddress,
  normalizeBoolean,
  normalizeLimit,
  normalizeJsonValue,
  parseEmailId,
  parseEmails,
  projectFields,
  renderMarkdown,
  stringifyForJson,
} from "./utils/helpers.js";
import { logger } from "./utils/logger.js";
import {
  ensureDestructiveConfirmed,
  ensureEmailActionAllowed,
  ensureMailboxWriteAllowed,
  ensureOutboundRecipientsAllowed,
  ensureRemoteDraftSyncAllowed,
  ensureSendAllowed,
  resolveRemoteDraftSync,
  sanitizeRuntimeConfig,
} from "./utils/runtime-policy.js";

type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | {
        type: "resource_link";
        uri: string;
        name: string;
        title?: string;
        description?: string;
        mimeType?: string;
      }
  >;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: string };
const PACKAGE_VERSION = packageJson.version ?? process.env.npm_package_version ?? "0.0.0";
const RESOURCE_SCHEME = "protonmail";
const ALL_EMAIL_ACTIONS: EmailAction[] = [
  "mark_read",
  "mark_unread",
  "star",
  "unstar",
  "archive",
  "trash",
  "restore",
  "move",
  "delete",
];

const TOOLS = [
  {
    name: "send_email",
    description: "Compose and send a new outbound email through Proton Bridge SMTP. Use for one-shot messages that need no review. Prefer create_draft when you want to save and review before sending, or reply_to_email when responding to an existing message. Fails if PROTONMAIL_ALLOW_SEND is false or if Bridge SMTP is unreachable. If PROTONMAIL_SEND_DELAY_SECONDS is set, this queues the send instead of sending immediately and returns a cancelable id — call cancel_send within the window to abort. Otherwise returns delivery confirmation immediately.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email addresses, comma-separated." },
        cc: { type: "string", description: "CC recipient email addresses, comma-separated." },
        bcc: { type: "string", description: "BCC recipient email addresses, comma-separated." },
        subject: { type: "string", description: "Email subject." },
        body: { type: "string", description: "Email body content (plain text). Required unless markdownBody is provided." },
        markdownBody: { type: "string", description: "Email body in Markdown. When provided, rendered to HTML with body as plain-text fallback; takes precedence over body+isHtml." },
        isHtml: { type: "boolean", description: "Whether body should be sent as HTML (ignored when markdownBody is provided).", default: false },
        priority: {
          type: "string",
          enum: ["high", "normal", "low"],
          description: "SMTP priority header.",
        },
        fromName: { type: "string", description: "Optional display name for the From header (e.g. 'Alice'). Does not change the sending address." },
        sanitizeHtml: { type: "boolean", description: "Strip scripts, event handlers, and remote image beacons from HTML before delivery. Defaults to true when body is HTML.", default: true },
        replyTo: { type: "string", description: "Optional reply-to email address." },
        requestReadReceipt: { type: "boolean", description: "Request a read receipt (MDN) via a Disposition-Notification-To header. Most mail clients ask the recipient before honoring it — this is a request, not a guarantee.", default: false },
        appendSignature: { type: "boolean", description: "Append PROTONMAIL_SIGNATURE (if configured) to the body. Set false to send without it for this one message.", default: true },
        attachments: {
          type: "array",
          description: "Attachments with base64 encoded content.",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              content: { type: "string", description: "Base64 content." },
              contentType: { type: "string" },
              cid: { type: "string" },
              contentDisposition: { type: "string" },
            },
            required: ["filename", "content"],
          },
        },
        confirmed: { type: "boolean", description: "Set to true to confirm this irreversible send when PROTONMAIL_CONFIRM_DESTRUCTIVE is enabled." },
        dryRun: { type: "boolean", description: "Preview the full recipient set and validate without sending.", default: false },
        undoWindowSeconds: { type: "number", description: "Override PROTONMAIL_SEND_DELAY_SECONDS for this one send: queue it for this many seconds (cancelable via cancel_send) instead of the server's configured default. 0 sends immediately even if the server has a default window configured. Same caveat as the server default: only fires while this server process stays running." },
      },
      required: ["to", "subject"],
    },
  },
  {
    name: "cancel_send",
    description: "Cancel a send_email call that was queued because PROTONMAIL_SEND_DELAY_SECONDS is set. Only works while the item is still pending — once it has actually sent, this returns canceled: false. No effect (throws) if PROTONMAIL_SEND_DELAY_SECONDS is 0, since nothing is ever queued in that case.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The id returned by a queued send_email call." },
      },
      required: ["id"],
    },
  },
  {
    name: "list_scheduled_sends",
    description: "List every item in the local undo-send / scheduled-send queue (from send_email with PROTONMAIL_SEND_DELAY_SECONDS set, or schedule_draft), including its id, status, and sendAt — use this to rediscover the id needed for cancel_send if it was lost with the conversation.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "sending", "sent", "canceled", "failed"], description: "Filter to one status. Omit to list everything." },
      },
    },
  },
  {
    name: "get_unsubscribe_info",
    description: "Read the List-Unsubscribe header of a message and report how to unsubscribe from it — a mailto address, an https link, or both. Does not take any action. Use before unsubscribe_sender to see what's available, or to hand an https link to the user/agent to open manually (this server never auto-fetches unsubscribe URLs).",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Composite email id from previous tool output." },
      },
      required: ["emailId"],
    },
  },
  {
    name: "unsubscribe_sender",
    description: "Execute the mailto: variant of a message's List-Unsubscribe header by sending a minimal unsubscribe email through Proton Bridge SMTP. Only works when the header includes a mailto address — if it only has an https link, this throws and returns that link for you to open manually instead (this server never auto-fetches unsubscribe URLs, to avoid firing an unreviewed request from mail content). Call get_unsubscribe_info first to see what's available.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Composite email id from previous tool output." },
        confirmed: { type: "boolean", description: "Set to true to confirm this send when PROTONMAIL_CONFIRM_DESTRUCTIVE is enabled." },
      },
      required: ["emailId"],
    },
  },
  {
    name: "send_test_email",
    description: "Send a minimal diagnostic email to confirm Proton Bridge SMTP credentials and connectivity. Use before relying on send_email in a new environment. Prefer get_connection_status for a connectivity check that does not actually send mail. Returns transport debug info and delivery status.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address." },
        customMessage: { type: "string", description: "Optional custom test body." },
      },
      required: ["to"],
    },
  },
  {
    name: "reply_to_email",
    description: "Immediately send a reply to an existing email, threading it correctly via In-Reply-To and References headers. Use when you have an emailId and want to send the reply right away. Prefer create_reply_draft to save the reply for review first, or create_thread_reply_draft when replying from a threadId. Use reply_all_email to reply to all original recipients. Requires PROTONMAIL_ALLOW_SEND.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Original email id." },
        body: { type: "string", description: "Reply body to prepend (plain text). Required unless markdownBody is provided." },
        markdownBody: { type: "string", description: "Reply body in Markdown. Rendered to HTML with body as plain-text fallback; takes precedence over body+isHtml." },
        replyAll: { type: "boolean", description: "Reply to all original recipients.", default: false },
        isHtml: { type: "boolean", description: "Send body as HTML (ignored when markdownBody is provided).", default: false },
        cc: { type: "string", description: "Additional CC recipients, comma-separated." },
        bcc: { type: "string", description: "Additional BCC recipients, comma-separated." },
        fromName: { type: "string", description: "Optional display name for the From header." },
        sanitizeHtml: { type: "boolean", description: "Strip scripts and remote image beacons from HTML before delivery. Defaults to true.", default: true },
        attachments: {
          type: "array",
          description: "Attachments with base64 encoded content.",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              content: { type: "string" },
              contentType: { type: "string" },
              cid: { type: "string" },
              contentDisposition: { type: "string" },
            },
            required: ["filename", "content"],
          },
        },
        confirmed: { type: "boolean", description: "Set to true to confirm this irreversible send when PROTONMAIL_CONFIRM_DESTRUCTIVE is enabled." },
        dryRun: { type: "boolean", description: "Preview recipient set and threading headers without sending.", default: false },
        includeQuote: { type: "boolean", description: "Append the quoted original message to the reply body.", default: true },
        appendSignature: { type: "boolean", description: "Append PROTONMAIL_SIGNATURE (if configured) after your reply text and before the quoted original. Set false to send without it for this one message.", default: true },
      },
      required: ["emailId", "body"],
    },
  },
  {
    name: "reply_all_email",
    description: "Immediately reply to all original recipients (sender + all To/CC addresses) of an existing email. Identical to reply_to_email with replyAll enabled. Use when the conversation involves multiple parties and all should receive the reply. Threading headers (In-Reply-To, References) are preserved. Requires PROTONMAIL_ALLOW_SEND.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Original email id." },
        body: { type: "string", description: "Reply body to prepend (plain text). Required unless markdownBody is provided." },
        markdownBody: { type: "string", description: "Reply body in Markdown. Rendered to HTML with body as plain-text fallback; takes precedence over body+isHtml." },
        isHtml: { type: "boolean", description: "Send body as HTML (ignored when markdownBody is provided).", default: false },
        cc: { type: "string", description: "Additional CC recipients, comma-separated." },
        bcc: { type: "string", description: "Additional BCC recipients, comma-separated." },
        fromName: { type: "string", description: "Optional display name for the From header." },
        sanitizeHtml: { type: "boolean", description: "Strip scripts and remote image beacons from HTML before delivery. Defaults to true.", default: true },
        attachments: {
          type: "array",
          description: "Attachments with base64 encoded content.",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              content: { type: "string" },
              contentType: { type: "string" },
              cid: { type: "string" },
              contentDisposition: { type: "string" },
            },
            required: ["filename", "content"],
          },
        },
        confirmed: { type: "boolean", description: "Set to true to confirm this irreversible send when PROTONMAIL_CONFIRM_DESTRUCTIVE is enabled." },
        dryRun: { type: "boolean", description: "Preview full reply-all fan-out without sending.", default: false },
        includeQuote: { type: "boolean", description: "Append the quoted original message to the reply body.", default: true },
        appendSignature: { type: "boolean", description: "Append PROTONMAIL_SIGNATURE (if configured) after your reply text and before the quoted original. Set false to send without it for this one message.", default: true },
      },
      required: ["emailId"],
    },
  },
  {
    name: "forward_email",
    description: "Immediately forward an existing email to new recipients, preserving original attachments and prepending an optional note. Use when you have an emailId and want to re-route the message without review. Prefer create_forward_draft to stage a forward for review first. Requires PROTONMAIL_ALLOW_SEND.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Original email id." },
        to: { type: "string", description: "Forward recipient list, comma-separated." },
        body: { type: "string", description: "Optional message before the forwarded content (plain text)." },
        markdownBody: { type: "string", description: "Optional introductory note in Markdown. Rendered to HTML with body as plain-text fallback; takes precedence over body+isHtml." },
        isHtml: { type: "boolean", description: "Send body as HTML (ignored when markdownBody is provided).", default: false },
        cc: { type: "string", description: "CC recipients, comma-separated." },
        bcc: { type: "string", description: "BCC recipients, comma-separated." },
        fromName: { type: "string", description: "Optional display name for the From header." },
        sanitizeHtml: { type: "boolean", description: "Strip scripts and remote image beacons from HTML before delivery. Defaults to true.", default: true },
        attachments: {
          type: "array",
          description: "Attachments with base64 encoded content.",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              content: { type: "string" },
              contentType: { type: "string" },
              cid: { type: "string" },
              contentDisposition: { type: "string" },
            },
            required: ["filename", "content"],
          },
        },
        confirmed: { type: "boolean", description: "Set to true to confirm this irreversible send when PROTONMAIL_CONFIRM_DESTRUCTIVE is enabled." },
        dryRun: { type: "boolean", description: "Preview recipients without sending.", default: false },
        includeAttachments: { type: "boolean", description: "Include original attachments in the forward.", default: true },
        attachmentParts: { type: "array", items: { type: "string" }, description: "Forward only specific MIME part numbers, e.g. [\"2\", \"3.1\"]. Mutually exclusive with includeAttachments:false." },
        appendSignature: { type: "boolean", description: "Append PROTONMAIL_SIGNATURE (if configured) after your note and before the forwarded content. Set false to send without it for this one message.", default: true },
      },
      required: ["emailId", "to"],
    },
  },
  {
    name: "create_draft",
    description: "Save a new outbound message as a local draft in SQLite, optionally syncing it to the Proton Drafts IMAP folder. Use to compose and review before sending. Prefer create_reply_draft when replying to a specific emailId, or create_forward_draft when forwarding. Returns a draftId for later update, sync, or send via send_draft.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email addresses, comma-separated." },
        cc: { type: "string", description: "CC recipient email addresses, comma-separated." },
        bcc: { type: "string", description: "BCC recipient email addresses, comma-separated." },
        subject: { type: "string", description: "Draft subject." },
        body: { type: "string", description: "Draft body." },
        isHtml: { type: "boolean", description: "Whether the body should be HTML.", default: false },
        priority: { type: "string", enum: ["high", "normal", "low"] },
        replyTo: { type: "string", description: "Optional reply-to email address." },
        notes: { type: "string", description: "Optional local note for the draft." },
        syncToRemote: {
          type: "boolean",
          description: "Whether to sync the draft to the Proton Drafts mailbox when IMAP is available.",
          default: true,
        },
        attachments: {
          type: "array",
          description: "Attachments with base64 encoded content.",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              content: { type: "string", description: "Base64 content." },
              contentType: { type: "string" },
              cid: { type: "string" },
              contentDisposition: { type: "string" },
            },
            required: ["filename", "content"],
          },
        },
      },
      required: ["subject", "body"],
    },
  },
  {
    name: "create_reply_draft",
    description: "Create a reply draft for a specific email, pre-filling To, Subject, and quoted body from the original message. Use when you have an emailId and want to stage the reply for review before sending. Prefer create_thread_reply_draft when you only have a threadId. Prefer reply_to_email to send immediately. Returns a draftId.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Original email id." },
        body: { type: "string", description: "Reply body to prepend." },
        replyAll: { type: "boolean", description: "Reply to all original recipients.", default: false },
        isHtml: { type: "boolean", description: "Store body as HTML.", default: false },
        cc: { type: "string", description: "Additional CC recipients, comma-separated." },
        bcc: { type: "string", description: "Additional BCC recipients, comma-separated." },
        notes: { type: "string", description: "Optional local note for the draft." },
        syncToRemote: {
          type: "boolean",
          description: "Whether to sync the draft to the Proton Drafts mailbox when IMAP is available.",
          default: true,
        },
        attachments: {
          type: "array",
          description: "Attachments with base64 encoded content.",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              content: { type: "string", description: "Base64 content." },
              contentType: { type: "string" },
              cid: { type: "string" },
              contentDisposition: { type: "string" },
            },
            required: ["filename", "content"],
          },
        },
      },
      required: ["emailId", "body"],
    },
  },
  {
    name: "create_forward_draft",
    description: "Create a forward draft for an existing email, pre-filling the original message as quoted body and preserving its attachments. Use when you have an emailId and want to stage a forward for review before sending. Prefer forward_email to send immediately without saving. Returns a draftId for later update or send via send_draft.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Original email id." },
        to: { type: "string", description: "Forward recipient list, comma-separated." },
        body: { type: "string", description: "Optional message before the forwarded content." },
        isHtml: { type: "boolean", description: "Store body as HTML.", default: false },
        cc: { type: "string", description: "CC recipients, comma-separated." },
        bcc: { type: "string", description: "BCC recipients, comma-separated." },
        notes: { type: "string", description: "Optional local note for the draft." },
        syncToRemote: {
          type: "boolean",
          description: "Whether to sync the draft to the Proton Drafts mailbox when IMAP is available.",
          default: true,
        },
        includeAttachments: { type: "boolean", description: "Include the original email's attachments in the draft.", default: true },
        attachments: {
          type: "array",
          description: "Attachments with base64 encoded content.",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              content: { type: "string", description: "Base64 content." },
              contentType: { type: "string" },
              cid: { type: "string" },
              contentDisposition: { type: "string" },
            },
            required: ["filename", "content"],
          },
        },
      },
      required: ["emailId", "to"],
    },
  },
  {
    name: "list_drafts",
    description: "List all locally saved drafts with their status, subject, and timestamps. Use to review in-progress or unsent messages. Does NOT list drafts stored only on the Proton server — use list_remote_drafts for those. Prefer get_draft when you already have a draftId and need the full content.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        includeSent: { type: "boolean", description: "Include drafts already sent.", default: false },
      },
    },
  },
  {
    name: "list_remote_drafts",
    description: "List draft messages currently stored in the Proton Drafts IMAP folder on the server. Use to see drafts created via Proton webmail or mobile app that have not been synced locally. Prefer list_drafts to see drafts managed by this server. Requires an active IMAP connection.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum drafts to return.", default: 50 },
        offset: { type: "number", description: "Pagination offset.", default: 0 },
      },
    },
  },
  {
    name: "get_draft",
    description: "Fetch the full content of a single locally saved draft by its draftId. Use to read or verify a draft before sending or updating. Prefer list_drafts to discover draftIds first. Does NOT fetch drafts from the Proton server — use list_remote_drafts for those.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        draftId: { type: "string", description: "Draft id returned by create_draft, list_drafts, or a create_*_draft call." },
      },
      required: ["draftId"],
    },
  },
  {
    name: "update_draft",
    description: "Update an existing locally saved draft's recipients, subject, body, or other fields. Use to edit a draft before sending. Only provided fields are updated — omitted fields retain their current values. After updating, call send_draft to send or sync_draft_to_remote to push to Proton Drafts.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        draftId: { type: "string", description: "Draft id returned by create_draft, list_drafts, or a create_*_draft call." },
        to: { type: "string", description: "Recipient email addresses, comma-separated." },
        cc: { type: "string", description: "CC recipient email addresses, comma-separated." },
        bcc: { type: "string", description: "BCC recipient email addresses, comma-separated." },
        subject: { type: "string", description: "Draft subject." },
        body: { type: "string", description: "Draft body." },
        isHtml: { type: "boolean", description: "Whether the body should be HTML." },
        priority: { type: "string", enum: ["high", "normal", "low"] },
        replyTo: { type: "string", description: "Optional reply-to email address." },
        notes: { type: "string", description: "Optional local note for the draft." },
        syncToRemote: {
          type: "boolean",
          description: "Whether to sync the updated draft to the Proton Drafts mailbox when IMAP is available.",
          default: true,
        },
        attachments: {
          type: "array",
          description: "Attachments with base64 encoded content.",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              content: { type: "string", description: "Base64 content." },
              contentType: { type: "string" },
              cid: { type: "string" },
              contentDisposition: { type: "string" },
            },
            required: ["filename", "content"],
          },
        },
      },
      required: ["draftId"],
    },
  },
  {
    name: "sync_draft_to_remote",
    description: "Force-push a locally saved draft to the Proton Drafts IMAP folder and return the remote UID. Use when a draft was created with syncToRemote:false or when the automatic sync failed. Do NOT use this if PROTONMAIL_ALLOW_REMOTE_DRAFT_SYNC is false — the call will be rejected.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        draftId: { type: "string", description: "Draft id returned by create_draft, list_drafts, or a create_*_draft call." },
      },
      required: ["draftId"],
    },
  },
  {
    name: "send_draft",
    description: "Send a previously saved local draft through Proton Bridge SMTP. Use as the final step in a draft-review-send workflow after create_draft and optional update_draft. Marks the draft as sent in the local store but does not delete it. Refuses if this draft has a still-pending scheduled send (from schedule_draft) — cancel that with cancel_send first, otherwise sending now would deliver the draft twice. Requires PROTONMAIL_ALLOW_SEND.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        draftId: { type: "string", description: "Draft id returned by create_draft, list_drafts, or a create_*_draft call." },
        confirmed: { type: "boolean", description: "Set to true to confirm this irreversible send when PROTONMAIL_CONFIRM_DESTRUCTIVE is enabled." },
        dryRun: { type: "boolean", description: "Preview recipients and draft content without sending. Returns what would be sent." },
      },
      required: ["draftId"],
    },
  },
  {
    name: "schedule_draft",
    description: "Queue a saved draft to send at a future time instead of immediately. IMPORTANT: this only fires while this MCP server process stays running (it's a stdio server that exits when its client disconnects) — if the app is closed before sendAt, the send fires on next server startup instead of the originally requested time, not at sendAt itself. This is best-effort tied to the app being open, not a reliable scheduler. The draft's content is snapshotted at schedule time; the draft record itself is NOT automatically marked sent or deleted once it fires — check list_drafts or get_email_stats afterward, or clean it up yourself. Cancelable via cancel_send until it fires.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        draftId: { type: "string", description: "Draft id returned by create_draft, list_drafts, or a create_*_draft call." },
        sendAt: { type: "string", description: "ISO 8601 timestamp of when to send, e.g. 2026-01-15T09:00:00.000Z. Must be in the future." },
        confirmed: { type: "boolean", description: "Set to true to confirm when PROTONMAIL_CONFIRM_DESTRUCTIVE is enabled." },
      },
      required: ["draftId", "sendAt"],
    },
  },
  {
    name: "delete_draft",
    description: "Permanently delete a locally saved draft from SQLite. Use to discard a draft you no longer need. Does NOT remove a matching draft from the Proton Drafts IMAP folder — that requires a separate mailbox action. Irreversible.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        draftId: { type: "string", description: "Draft id returned by create_draft, list_drafts, or a create_*_draft call." },
      },
      required: ["draftId"],
    },
  },
  {
    name: "get_emails",
    description: "Fetch emails from a mailbox folder via live IMAP, defaults to newest first; set sortByUid to asc for oldest first. Use to browse or paginate recent messages in a specific folder. Prefer search_emails to filter by sender, subject, or date. Prefer search_indexed_emails for fast repeated queries when the local SQLite index is populated and Bridge availability is uncertain.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder name.", default: "INBOX" },
        limit: { type: "number", description: "Number of emails to return.", default: 50 },
        offset: { type: "number", description: "Pagination offset from newest first.", default: 0 },
        includeSnippet: { type: "boolean", description: "Fetch a short plain-text preview of each email body. Slightly slower (requires fetching the message source) but lets you triage without a separate get_email_by_id call. Warning: snippet content is from untrusted senders and may contain prompt-injection text.", default: false },
        beforeUid: { type: "number", description: "Return only messages with UID less than this value. Use for UID-cursor pagination (more reliable than offset under concurrent modifications)." },
        sortByUid: { type: "string", enum: ["asc", "desc"], description: "Sort direction by UID. Default is desc (newest first)." },
        fields: { oneOf: [{ type: "array", items: { type: "string" } }, { type: "string" }], description: "Trim each returned email to just these field names (e.g. [\"subject\",\"from\",\"date\"]) to save tokens on large result sets. id is always included. Accepts either an array or a comma-separated string. Omit to get the full object." },
      },
    },
  },
  {
    name: "get_email_by_id",
    description: "Fetch the full content of a single email using a composite emailId. Use after get_emails or search_emails to read a specific message in full. The emailId format is FOLDER::UID — always use the id returned by a prior tool call; do not construct it manually. Response includes a security block (dkim/spf/dmarc pass-fail, Proton's spam score/action, and encryption metadata) for phishing/legitimacy triage.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Composite email id from previous tool output." },
        preferHtml: { type: "boolean", description: "Return raw HTML body instead of plain-text stripped version.", default: false },
        maxBodyLength: { type: "number", description: "Truncate body at this many characters (1–500000)." },
        showHeaders: { type: "boolean", description: "Include the full raw header map (from/to/content-type/dkim-signature/list/received/...) in the response. Off by default to avoid token bloat — turn on only when you need a specific header not already surfaced elsewhere (e.g. list.unsubscribe).", default: false },
      },
      required: ["emailId"],
    },
  },
  {
    name: "get_emails_by_ids",
    description: "Fetch full content for multiple emails by composite id in one call (max 25). Use to read a batch of specific messages from a prior get_emails/search_emails/search_indexed_emails result without one get_email_by_id round trip per message. One failed id does not fail the whole batch — check each result's ok field. Prefer get_email_by_id for a single message.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        emailIds: {
          oneOf: [{ type: "array", items: { type: "string" } }, { type: "string" }],
          description: "Composite email ids as an array or a comma-separated string. Max 25 per call.",
        },
        preferHtml: { type: "boolean", description: "Return raw HTML body instead of plain-text stripped version.", default: false },
        maxBodyLength: { type: "number", description: "Truncate each body at this many characters (1–500000)." },
      },
      required: ["emailIds"],
    },
  },
  {
    name: "search_emails",
    description: "Search emails via live IMAP filters with optional local post-processing for attachments and labels. Use when you need real-time results or must find messages received after the last sync. Prefer search_indexed_emails when the local index is current — it is significantly faster and works even when Bridge IMAP is unavailable.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text query across headers and body." },
        folder: { type: "string", description: "Folder to search. Defaults to all folders." },
        label: { type: "string", description: "Folder or label filter applied locally after IMAP fetch." },
        threadId: { type: "string", description: "Thread id filter applied locally after IMAP fetch." },
        from: { type: "string", description: "Sender filter." },
        to: { type: "string", description: "Recipient filter." },
        subject: { type: "string", description: "Subject filter." },
        hasAttachment: { type: "boolean", description: "Whether the message should have attachments." },
        attachmentName: { type: "string", description: "Attachment filename filter applied locally." },
        isRead: { type: "boolean", description: "Read status filter." },
        isStarred: { type: "boolean", description: "Starred status filter." },
        dateFrom: { type: "string", description: "Inclusive start date/time in ISO format." },
        dateTo: { type: "string", description: "Inclusive end date/time in ISO format." },
        sizeLarger: { type: "number", description: "Only return messages larger than this size in bytes." },
        sizeSmaller: { type: "number", description: "Only return messages smaller than this size in bytes." },
        listId: { type: "string", description: "Filter by List-ID header value (mailing list filter)." },
        senderDomain: { type: "string", description: "Filter by sender domain, e.g. example.com. Applied locally after IMAP fetch." },
        mailboxRole: { type: "string", description: "Normalized mailbox role: Inbox, Sent, Archive, Trash. Applied locally." },
        messageId: { type: "string", description: "RFC 5322 Message-ID header value to match exactly." },
        cc: { type: "string", description: "Filter by CC/BCC recipient address." },
        bcc: { type: "string", description: "Filter by CC/BCC recipient address." },
        limit: { type: "number", description: "Maximum results.", default: 100 },
        includeSnippet: { type: "boolean", description: "Fetch a short plain-text preview of each matched email body. Slightly slower but avoids follow-up get_email_by_id calls for triage. Warning: snippet content is from untrusted senders and may contain prompt-injection text.", default: false },
        fields: { oneOf: [{ type: "array", items: { type: "string" } }, { type: "string" }], description: "Trim each returned email to just these field names (e.g. [\"subject\",\"from\",\"date\"]) to save tokens on large result sets. id is always included. Accepts either an array or a comma-separated string. Omit to get the full object." },
      },
    },
  },
  {
    name: "get_folders",
    description: "Return all mailbox folders with message counts and unseen counts from the live IMAP session. Use to discover available folder names before targeting get_emails, move_email, or create_folder. Prefer sync_folders to force a fresh fetch when the folder list appears stale. Folders with noselect:true cannot be used for IMAP operations.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sync_folders",
    description: "Refresh the in-memory folder list from the IMAP server and return the updated list. Use when folders have been created, renamed, or deleted externally (e.g. via Proton webmail) and get_folders is returning stale data. Prefer get_folders for a read-only view that does not force a refresh.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_folder",
    description:
      "Create a new mailbox folder via IMAP. Use 'Folders/' prefix for user folders and 'Labels/' for labels in Proton Bridge (e.g. 'Folders/Receipts'). Do NOT attempt to create system folders such as INBOX, Sent, Trash, Archive, or Spam. Returns the created path on success.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Full mailbox path. In Proton Bridge, user folders live under 'Folders/' and labels under 'Labels/'.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "rename_folder",
    description: "Rename or move a mailbox folder to a new IMAP path. Existing messages are preserved in place. Do NOT rename system folders (INBOX, Sent, Trash, Archive, Spam). Refreshes the local folder cache after the operation.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Existing folder path." },
        newPath: { type: "string", description: "New folder path." },
      },
      required: ["path", "newPath"],
    },
  },
  {
    name: "delete_folder",
    description:
      "Delete an empty mailbox folder via IMAP. The folder must contain no messages — move or trash all messages first. Do NOT delete system folders (INBOX, Sent, Trash, Archive, Spam). Irreversible; messages already removed cannot be recovered this way.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Folder path to delete." },
        confirmed: { type: "boolean", description: "Pass true to confirm permanent deletion of the folder and all its messages. Required when PROTONMAIL_CONFIRM_DESTRUCTIVE is enabled." },
      },
      required: ["path"],
    },
  },
  {
    name: "mark_email_read",
    description: "Mark a single email as read or unread by setting the IMAP Seen flag. Use for individual triage or to reset read state. Prefer batch_email_action with action 'mark_read' or 'mark_unread' when updating multiple emails at once.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Composite email id in FOLDER::UID format, as returned by get_emails or search_emails." },
        isRead: { type: "boolean", default: true },
      },
      required: ["emailId"],
    },
  },
  {
    name: "star_email",
    description: "Star or unstar a single email using the IMAP Flagged flag. Use to bookmark an important message for later follow-up. Prefer batch_email_action with action 'star' or 'unstar' when flagging multiple emails at once.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Composite email id in FOLDER::UID format, as returned by get_emails or search_emails." },
        isStarred: { type: "boolean", default: true },
      },
      required: ["emailId"],
    },
  },
  {
    name: "move_email",
    description: "Move a single email to any specified mailbox folder. Use when routing a message to a custom folder. Prefer archive_email to move to the standard Archive folder, or trash_email to move to Trash. Use get_folders first to confirm the target folder path.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Composite email id in FOLDER::UID format, as returned by get_emails or search_emails." },
        targetFolder: { type: "string" },
      },
      required: ["emailId", "targetFolder"],
    },
  },
  {
    name: "archive_email",
    description: "Move a single email to the standard Archive folder. Use for messages that are resolved but worth keeping long-term. Prefer trash_email when the message is no longer needed. Prefer move_email to route to a custom folder. Prefer batch_email_action for archiving multiple emails at once.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Composite email id in FOLDER::UID format, as returned by get_emails or search_emails." },
      },
      required: ["emailId"],
    },
  },
  {
    name: "trash_email",
    description: "Move a single email to the Trash folder. Messages in Trash can be recovered with restore_email. Use instead of delete_email when you may want to recover the message later. Prefer batch_email_action with action 'trash' for multiple emails at once.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Composite email id in FOLDER::UID format, as returned by get_emails or search_emails." },
      },
      required: ["emailId"],
    },
  },
  {
    name: "restore_email",
    description: "Move an email from Trash back to INBOX or to a specified folder. Use to undo a trash_email operation. Does not work on permanently deleted messages — only messages currently in Trash can be restored.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Composite email id in FOLDER::UID format, as returned by get_emails or search_emails." },
        targetFolder: { type: "string", description: "Optional restore destination. Defaults to INBOX." },
      },
      required: ["emailId"],
    },
  },
  {
    name: "snooze_email",
    description: "Move an email out of sight into Folders/MCP-Snoozed and bring it back to its original folder at wakeAt. IMPORTANT: like scheduled sends, wake only fires while this MCP server process stays running — if the app is closed before wakeAt, the email wakes on next server startup instead of at the requested time, not reliably at wakeAt itself. Cancelable via cancel_snooze, which wakes it immediately.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Composite email id in FOLDER::UID format." },
        wakeAt: { type: "string", description: "ISO 8601 timestamp of when to bring it back, e.g. 2026-01-15T09:00:00.000Z. Must be in the future." },
      },
      required: ["emailId", "wakeAt"],
    },
  },
  {
    name: "cancel_snooze",
    description: "Wake a snoozed email immediately, moving it back to its original folder before wakeAt. No effect (throws) if the snooze has already woken or was already canceled.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The id returned by snooze_email." },
      },
      required: ["id"],
    },
  },
  {
    name: "list_snoozed",
    description: "List every snoozed email, including its id, status, and wakeAt — use this to rediscover the id needed for cancel_snooze if it was lost with the conversation.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "woken", "canceled", "failed"], description: "Filter to one status. Omit to list everything." },
      },
    },
  },
  {
    name: "create_template",
    description: "Save a reusable email template. Subject and body may contain {{variable}} placeholders (e.g. {{firstName}}), auto-detected and stored on the template. Fails if a template with the same name already exists — delete it first to replace it.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Unique template name." },
        subject: { type: "string", description: "Subject line, may contain {{variable}} placeholders." },
        body: { type: "string", description: "Body text, may contain {{variable}} placeholders." },
        isHtml: { type: "boolean", description: "Whether body is HTML.", default: false },
      },
      required: ["name", "subject", "body"],
    },
  },
  {
    name: "list_templates",
    description: "List all saved email templates.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_template",
    description: "Get a single saved email template by id.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The template id, as returned by create_template or list_templates." } },
      required: ["id"],
    },
  },
  {
    name: "delete_template",
    description: "Delete a saved email template.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The template id." } },
      required: ["id"],
    },
  },
  {
    name: "render_template",
    description: "Render a saved template's subject and body, substituting {{variable}} placeholders with the given values. Placeholders left unfilled stay literal (e.g. {{firstName}}) and are listed in missingVariables — check that field is empty before passing the rendered subject/body to send_email, or the recipient will see literal {{placeholder}} text in the message.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The template id." },
        variables: {
          type: "object",
          description: "Map of variable name to replacement value, e.g. { \"firstName\": \"Alex\" }.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_email",
    description: "Permanently delete a single email via IMAP expunge. Use only when certain the message is no longer needed. Prefer trash_email if recovery may be required. Prefer bulk_delete to delete multiple emails at once. Prefer delete_thread to delete all messages in a conversation. Irreversible.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Composite email id in FOLDER::UID format, as returned by get_emails or search_emails." },
        confirmed: { type: "boolean", description: "Set to true to confirm this permanent deletion when PROTONMAIL_CONFIRM_DESTRUCTIVE is enabled. Cannot be undone." },
      },
      required: ["emailId"],
    },
  },
  {
    name: "update_message_labels",
    description: "Add or remove Proton labels on a single message without moving it. Labels live under the Labels/ namespace (e.g. 'Labels/Work'). Use for one message at a time. Prefer bulk_update_labels to apply label changes across multiple messages. Create missing labels first with create_folder using a 'Labels/' prefix.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Composite email id in FOLDER::UID format." },
        labelsToAdd: {
          type: "array",
          items: { type: "string" },
          description: "Label paths to add, e.g. [\"Labels/Work\", \"Labels/Receipts\"]. The 'Labels/' prefix is optional and will be prepended if missing.",
        },
        labelsToRemove: {
          type: "array",
          items: { type: "string" },
          description: "Label paths to remove. Idempotent — silently ignored if the label is not applied.",
        },
      },
      required: ["emailId"],
    },
  },
  {
    name: "update_message_flags",
    description: "Add or remove arbitrary IMAP flags on a single message, then verify the server applied them. Returns notApplied[] listing flags the server silently dropped. Use for custom IMAP flags (e.g. \\\\Answered) or when mark_email_read / star_email don't cover the flag you need. Prefer bulk_update_flags to update flags across multiple messages at once.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Composite email id in FOLDER::UID format." },
        flagsToAdd: {
          type: "array",
          items: { type: "string" },
          description: "IMAP flags to set, e.g. [\"\\\\Seen\", \"\\\\Flagged\", \"\\\\Answered\"].",
        },
        flagsToRemove: {
          type: "array",
          items: { type: "string" },
          description: "IMAP flags to clear.",
        },
      },
      required: ["emailId"],
    },
  },
  {
    name: "count_messages",
    description: "Count messages matching live IMAP search criteria without fetching message data. Use to preview how many results a search would return before running it. Prefer folder_stats for a simple unread/total count on one folder without filters.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder to count in. Defaults to INBOX." },
        query: { type: "string", description: "Free-text filter." },
        from: { type: "string", description: "Sender filter." },
        to: { type: "string", description: "Filter by recipient address." },
        subject: { type: "string", description: "Subject filter." },
        hasAttachment: { type: "boolean", description: "Filter by attachment presence." },
        label: { type: "string", description: "Filter by folder label applied locally." },
        threadId: { type: "string", description: "Filter by thread id, applied locally." },
        senderDomain: { type: "string", description: "Filter by sender domain, applied locally." },
        isRead: { type: "boolean", description: "Read status filter." },
        isStarred: { type: "boolean", description: "Starred status filter." },
        dateFrom: { type: "string", description: "Inclusive start date in ISO format." },
        dateTo: { type: "string", description: "Inclusive end date in ISO format." },
        sizeLarger: { type: "number", description: "Only count messages larger than this size in bytes." },
        sizeSmaller: { type: "number", description: "Only count messages smaller than this size in bytes." },
      },
    },
  },
  {
    name: "folder_stats",
    description: "Return live message count, unseen count, uidNext, and uidValidity for a single mailbox folder. Use to check unread counts or folder health without fetching messages. Prefer count_messages when you need to apply filters (sender, subject, date). Prefer get_email_stats for an aggregate summary across all folders.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder path. Defaults to INBOX.", default: "INBOX" },
        scanLimit: { type: "number", description: "Maximum messages to scan (1–20000, default 5000). Lower = faster but less accurate." },
      },
    },
  },
  {
    name: "empty_folder",
    description: "Permanently delete ALL messages in a folder at once. Use only when the goal is to clear an entire folder (e.g. emptying Trash or Spam). Only available when PROTONMAIL_ALLOW_EMPTY_FOLDER=true. Irreversible. Prefer bulk_delete when removing a subset of messages rather than everything in the folder.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder path to empty (e.g. 'Trash', 'Spam')." },
        confirmed: { type: "boolean", description: "Must be true to execute. Call with confirmed:false first to see a preview of what would be deleted." },
      },
      required: ["folder"],
    },
  },
  {
    name: "bulk_move",
    description: "Move multiple emails to a target folder in one IMAP pass. Accepts either explicit emailIds[] or a match criteria object (XOR). Supports dryRun to preview. For single-message moves use move_email.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailIds: { type: "array", items: { type: "string" }, description: "Explicit email IDs (FOLDER::UID format). XOR with match." },
        match: { type: "object", description: "Search criteria to select messages. XOR with emailIds.", properties: { from: { type: "string" }, subject: { type: "string" }, text: { type: "string" }, since: { type: "string" }, before: { type: "string" }, isRead: { type: "boolean" }, isStarred: { type: "boolean" } } },
        folder: { type: "string", description: "Source folder (required when using match)." },
        targetFolder: { type: "string", description: "Destination folder." },
        dryRun: { type: "boolean", description: "Preview without moving.", default: false },
        maxBatchSize: { type: "number", description: "Maximum number of messages to process. Defaults to 500. Use to prevent runaway operations." },
      },
      required: ["targetFolder"],
    },
  },
  {
    name: "bulk_delete",
    description: "Delete multiple emails by explicit ID list or by search criteria (from/subject/date/flags). Use when you have specific IDs to delete or want to filter by sender, subject, or date range. Accepts emailIds[] OR match criteria (XOR). permanent:true permanently expunges; false moves to Trash. Use dryRun to preview. Prefer empty_folder to clear an entire folder. Prefer delete_email for a single message. Prefer batch_email_action when the same set of IDs needs a mix of actions, not just deletion.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        emailIds: { type: "array", items: { type: "string" }, description: "Explicit email IDs. XOR with match." },
        match: { type: "object", description: "Search criteria. XOR with emailIds.", properties: { from: { type: "string" }, subject: { type: "string" }, text: { type: "string" }, since: { type: "string" }, before: { type: "string" }, isRead: { type: "boolean" }, isStarred: { type: "boolean" } } },
        folder: { type: "string", description: "Source folder (required with match)." },
        permanent: { type: "boolean", description: "Permanently expunge (irreversible). False = move to Trash.", default: false },
        dryRun: { type: "boolean", default: false },
        confirmed: { type: "boolean", description: "Required when permanent:true and PROTONMAIL_CONFIRM_DESTRUCTIVE is enabled." },
        maxBatchSize: { type: "number", description: "Maximum number of messages to process. Defaults to 500. Use to prevent runaway operations." },
      },
    },
  },
  {
    name: "bulk_update_flags",
    description: "Add or remove IMAP flags on multiple messages simultaneously. Use when the same flag change (e.g. \\\\Seen, \\\\Flagged) should apply to several messages. Accepts emailIds[] OR match+folder (XOR). Returns notApplied[] per message for flags the server silently dropped. Prefer update_message_flags for a single message when you need per-flag server verification.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailIds: { type: "array", items: { type: "string" }, description: "Explicit email IDs. XOR with match." },
        match: { type: "object", description: "Search criteria. XOR with emailIds.", properties: { from: { type: "string" }, subject: { type: "string" }, text: { type: "string" }, since: { type: "string" }, before: { type: "string" }, isRead: { type: "boolean" }, isStarred: { type: "boolean" } } },
        folder: { type: "string", description: "Source folder (required with match)." },
        flagsToAdd: { type: "array", items: { type: "string" }, description: 'IMAP flags to set, e.g. ["\\\\Seen", "\\\\Flagged"].' },
        flagsToRemove: { type: "array", items: { type: "string" }, description: "IMAP flags to clear." },
        dryRun: { type: "boolean", default: false },
        maxBatchSize: { type: "number", description: "Maximum number of messages to process. Defaults to 500. Use to prevent runaway operations." },
      },
    },
  },
  {
    name: "bulk_update_labels",
    description: "Add or remove Proton labels on multiple messages simultaneously. Use when the same label change should apply to several messages. Labels are IMAP folders under Labels/ namespace. Accepts emailIds[] OR match+folder (XOR).",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailIds: { type: "array", items: { type: "string" }, description: "Explicit email IDs. XOR with match." },
        match: { type: "object", description: "Search criteria. XOR with emailIds.", properties: { from: { type: "string" }, subject: { type: "string" }, text: { type: "string" }, since: { type: "string" }, before: { type: "string" }, isRead: { type: "boolean" }, isStarred: { type: "boolean" } } },
        folder: { type: "string", description: "Source folder (required with match)." },
        labelsToAdd: { type: "array", items: { type: "string" }, description: 'Labels to add, e.g. ["Labels/Work"].' },
        labelsToRemove: { type: "array", items: { type: "string" }, description: "Labels to remove." },
        dryRun: { type: "boolean", default: false },
        maxBatchSize: { type: "number", description: "Maximum number of messages to process. Defaults to 500. Use to prevent runaway operations." },
      },
    },
  },
  {
    name: "top_senders",
    description: "Return a frequency table of the top senders in a folder over a date range. Keyed on the sender address, not the display name, so display-name spoofing does not conflate different senders. Use for inbox analytics, unsubscribe triage, and contact discovery.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder to analyse. Defaults to INBOX." },
        since: { type: "string", description: "ISO date lower bound." },
        before: { type: "string", description: "ISO date upper bound." },
        limit: { type: "number", description: "Max senders to return.", default: 20 },
        scanLimit: { type: "number", description: "Max messages to scan.", default: 5000 },
        excludeSelf: { type: "boolean", description: "Exclude messages sent by your own address.", default: true },
      },
    },
  },
  {
    name: "move_thread",
    description: "Move all messages in a thread to a destination folder, identified by its RFC 5322 Message-ID header. Use when you have the raw Message-ID (e.g. from email headers) and want to move the full conversation. Prefer apply_thread_action with action 'move' when you have a local threadId from get_threads or get_actionable_threads.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "RFC 5322 Message-ID, e.g. <abc@mail.example.com>." },
        destination: { type: "string", description: "Destination folder." },
        acrossFolders: { type: "boolean", description: "Also search Sent and All Mail.", default: false },
        dryRun: { type: "boolean", default: false },
      },
      required: ["messageId", "destination"],
    },
  },
  {
    name: "delete_thread",
    description: "Delete all messages in a thread, identified by RFC 5322 Message-ID header. permanent:true permanently expunges; false moves to Trash. Use when you have the raw Message-ID. Prefer apply_thread_action with action 'trash' or 'delete' when you have a local threadId from get_threads or get_actionable_threads.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "RFC 5322 Message-ID." },
        permanent: { type: "boolean", default: false },
        acrossFolders: { type: "boolean", default: false },
        dryRun: { type: "boolean", default: false },
        confirmed: { type: "boolean" },
      },
      required: ["messageId"],
    },
  },
  {
    name: "flag_thread",
    description: "Add or remove IMAP flags across all messages in a thread, identified by RFC 5322 Message-ID header. Use when you have the raw Message-ID and want to flag an entire conversation at once. Prefer apply_thread_action with action 'mark_read', 'mark_unread', 'star', or 'unstar' when you have a local threadId from get_threads.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "RFC 5322 Message-ID." },
        flagsToAdd: { type: "array", items: { type: "string" } },
        flagsToRemove: { type: "array", items: { type: "string" } },
        acrossFolders: { type: "boolean", default: false },
        dryRun: { type: "boolean", default: false },
      },
      required: ["messageId"],
    },
  },
  {
    name: "create_label",
    description: "Create a Proton label (IMAP folder under Labels/ namespace). Idempotent — safe to call if the label may already exist. For folder creation use create_folder with a Folders/ prefix.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Label name. The Labels/ prefix is optional and will be added automatically." },
      },
      required: ["name"],
    },
  },
  {
    name: "rename_label",
    description: "Rename a Proton label (IMAP folder under Labels/ namespace). Messages keep the label, just under the new name. For renaming a folder use rename_folder with a Folders/ prefix.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Existing label name. The Labels/ prefix is optional and will be added automatically." },
        newName: { type: "string", description: "New label name. The Labels/ prefix is optional and will be added automatically." },
      },
      required: ["name", "newName"],
    },
  },
  {
    name: "delete_label",
    description: "Delete a Proton label (IMAP folder under Labels/ namespace). Deletes the label itself, not the messages — they remain in their other folders/labels. Irreversible. For deleting a folder use delete_folder with a Folders/ prefix.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Label name to delete. The Labels/ prefix is optional and will be added automatically." },
        confirmed: { type: "boolean", description: "Pass true to confirm permanent deletion of the label. Required when PROTONMAIL_CONFIRM_DESTRUCTIVE is enabled." },
      },
      required: ["name"],
    },
  },
  {
    name: "batch_email_action",
    description: "Apply one action to a known list of email IDs in a single IMAP pass. Use when you already have the IDs and want to archive, trash, move, mark-read/unread, star/unstar, restore, or permanently delete them. Actions: mark_read, mark_unread, star, unstar, archive, trash, restore, move (requires targetFolder), delete (permanent expunge). Supports dryRun. Prefer bulk_delete when selecting messages by search criteria (from/subject/date) rather than by ID. Prefer apply_thread_action when acting on a thread by threadId. Prefer empty_folder to clear an entire folder.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        emailIds: {
          oneOf: [
            {
              type: "array",
              items: { type: "string" },
            },
            {
              type: "string",
            },
          ],
          description: "Composite email ids as an array or a comma-separated string.",
        },
        action: {
          type: "string",
          enum: ["mark_read", "mark_unread", "star", "unstar", "archive", "trash", "restore", "move", "delete"],
        },
        targetFolder: {
          type: "string",
          description: "Destination folder. Required when action is 'move'; optional for 'restore' (defaults to INBOX).",
        },
        continueOnError: {
          type: "boolean",
          description: "Continue applying the action after an individual failure.",
          default: true,
        },
        dryRun: {
          type: "boolean",
          description: "Preview the impact without mutating the mailbox.",
          default: false,
        },
      },
      required: ["emailIds", "action"],
    },
  },
  {
    name: "apply_thread_action",
    description:
      "Apply a reversible mailbox action to every message in a normalized thread at once. Use when you want to act on a full thread identified by threadId (e.g. archive or mark-read an entire conversation). Supports dryRun, unreadOnly to scope impact, and syncBefore to refresh the index first. Prefer batch_email_action when you have explicit emailIds rather than a threadId.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Thread id from get_threads or get_actionable_threads." },
        action: {
          type: "string",
          enum: ["mark_read", "mark_unread", "star", "unstar", "archive", "trash", "restore", "move", "delete"],
        },
        targetFolder: {
          type: "string",
          description: "Required when action is move.",
        },
        unreadOnly: {
          type: "boolean",
          description: "Only apply the action to unread messages in the thread.",
          default: false,
        },
        continueOnError: {
          type: "boolean",
          description: "Continue applying the action after an individual failure.",
          default: true,
        },
        dryRun: {
          type: "boolean",
          description: "Preview the impact without mutating the mailbox.",
          default: false,
        },
        syncBefore: {
          type: "boolean",
          description: "Refresh the local mailbox index from IMAP before resolving the thread.",
          default: false,
        },
      },
      required: ["threadId", "action"],
    },
  },
  {
    name: "get_email_stats",
    description: "Return aggregate mailbox statistics: folder message counts, total unread counts, and a brief analytics sample. Use for a quick mailbox health overview. Prefer get_email_analytics for richer breakdowns such as top senders and hourly patterns. Prefer get_volume_trends for time-series daily volume data. Reads from the local index (auto-refreshed if stale or empty), not live IMAP — reflects the last sync, so read/unread counts can lag a change made from another client. Unread counts specifically can also lag a flag change (e.g. \\Seen set shortly after send) until that message's folder is next fully synced.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Trailing days window.", default: 30 },
        limit: { type: "number", description: "Maximum messages to sample.", default: 2000 },
      },
    },
  },
  {
    name: "get_email_analytics",
    description: "Generate sampled mailbox analytics including top senders, busiest hours of day, and volume breakdown by folder. Use for productivity insights and communication pattern analysis. Prefer get_email_stats for a fast aggregate count summary. Prefer get_volume_trends for per-day message volume history. Reads from the local index (auto-refreshed if stale or empty), not live IMAP — reflects the last sync.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Trailing days window.", default: 30 },
        limit: { type: "number", description: "Maximum messages to sample.", default: 2000 },
      },
    },
  },
  {
    name: "get_contacts",
    description: "Return the most frequently contacted email addresses ranked by interaction volume within the analytics sample window. Use to identify key correspondents or to pre-populate recipient lists. Reads from the local index (auto-refreshed if stale or empty) — reflects the last sync. Note: results are frequency-derived from recent email history, not a Proton contacts address book.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum contacts to return.", default: 100 },
      },
    },
  },
  {
    name: "get_volume_trends",
    description: "Return daily inbound and outbound message counts for a trailing window. Use to spot volume spikes, identify quiet periods, or track communication trends over time. Prefer get_email_analytics for sender-level breakdowns and hourly patterns. Reads from the local index (auto-refreshed if stale or empty), not live IMAP — reflects the last sync.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Number of trailing days to include.", default: 30 },
      },
    },
  },
  {
    name: "get_connection_status",
    description: "Check whether Proton Bridge SMTP and IMAP are reachable and return authentication status for each. Use to diagnose connectivity before sending or syncing, or when tools return connection errors. Returns individual pass/fail for each protocol, plus this server's own version and entrypoint path — check these first if behavior doesn't match the latest release notes; an old/orphaned install elsewhere on disk can silently shadow an upgrade. Prefer run_doctor for a full end-to-end health check including index integrity.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_runtime_status",
    description: "Return the server's current runtime state: policy flags (read-only, allow-send, allowed actions), background sync schedule and last-run time, IMAP IDLE watch state, draft store statistics, and local index freshness. Use to understand how the server is configured and whether sync is actively running. Prefer get_connection_status for protocol reachability only.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "run_doctor",
    description: "Run a comprehensive production health check covering SMTP auth, IMAP auth, optional IMAP IDLE probe, SQLite index integrity, sync-failed drafts, runtime policy validation, and what this server can/cannot do (capabilities). Also reports this server's own version and entrypoint path — worth checking first when behavior doesn't match the changelog, since an old/orphaned install elsewhere on disk can silently shadow an upgrade and every other field here would still report healthy. Connection failures include a classified diagnosis (authentication_failed vs bridge_unreachable) with a specific fix. Use to fully diagnose or validate the setup. Prefer get_connection_status for a quick protocol-only reachability check.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        includeSmtp: { type: "boolean", description: "Verify SMTP connectivity.", default: true },
        includeImap: { type: "boolean", description: "Verify IMAP connectivity.", default: true },
        includeIdleProbe: {
          type: "boolean",
          description: "Run a short IMAP IDLE wait to confirm the watch path is operational.",
          default: false,
        },
        idleTimeoutSeconds: {
          type: "number",
          description: "IDLE probe timeout in seconds when includeIdleProbe is true.",
          default: 5,
        },
      },
    },
  },
  {
    name: "run_background_sync",
    description: "Immediately trigger the configured background mailbox sync cycle outside its normal schedule and return its updated status. Use to force a sync when the index may be stale. Does nothing useful if PROTONMAIL_AUTO_SYNC is disabled. Prefer sync_emails for an on-demand, configurable sync with folder and depth options.",
    annotations: { destructiveHint: false },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "wait_for_mailbox_changes",
    description: "Open an IMAP IDLE session and block until a mailbox change event arrives or the timeout expires. Use to detect real-time inbox activity without polling. Returns whether a change was observed. Always returns within timeoutSeconds plus a few seconds' grace, even if the underlying IDLE session gets stuck — do not use in fire-and-forget pipelines. A change that arrives may not always wake the call early; it is still detected and reported correctly, just not necessarily before the timeout.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Mailbox to watch during IDLE.", default: "INBOX" },
        timeoutSeconds: { type: "number", description: "Maximum watch duration in seconds.", default: 15 },
      },
    },
  },
  {
    name: "sync_emails",
    description: "Incrementally sync email metadata from IMAP into the local SQLite index, using stored checkpoints to avoid re-fetching already-indexed messages. Use before calling search_indexed_emails or get_threads when the index may be stale. The default incremental sync only ever adds/updates recent messages — it never notices a message that was archived, trashed, or moved out of the synced folder by any client, so search/thread/digest tools can keep showing a message as still present indefinitely. Set full:true (per folder — sync each folder you want cleaned up) to also detect and prune those, in addition to fetching a larger sample. Prefer run_background_sync to trigger the scheduled sync cycle (also incremental-only by default; see PROTONMAIL_AUTO_SYNC_FULL).",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder to sync. Defaults to all folders." },
        full: { type: "boolean", description: "Fetch a larger per-folder sample, and detect/prune messages no longer present in this folder (moved, archived, trashed, or deleted by any client) that the default incremental sync would otherwise leave stale in the index forever.", default: false },
        limitPerFolder: { type: "number", description: "Override the per-folder fetch limit." },
        includeAttachmentText: {
          type: "boolean",
          description: "Extract searchable text from text-like attachments while syncing.",
          default: true,
        },
      },
    },
  },
  {
    name: "get_index_status",
    description: "Return metadata about the local SQLite email index: row count, last sync timestamp, index schema version, and per-folder coverage. Use to verify the index is fresh and complete before querying it with search_indexed_emails or get_threads. If the index is empty or stale, call sync_emails first.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search_indexed_emails",
    description:
      "Search the local SQLite mailbox index without making any IMAP connection. Supports free-text and field shortcuts inline: from:alice@example.com, to:bob, subject:invoice, label:Archive, domain:acme.com. Use for fast, offline-capable searches when the index is populated. Prefer search_emails when you need live IMAP results or when the index is stale or empty. Prefer this over search_emails when the index is current. Use search_emails if messages were received after the last sync.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text query across indexed metadata." },
        folder: { type: "string", description: "Folder filter." },
        label: { type: "string", description: "Folder or label filter." },
        threadId: { type: "string", description: "Thread id filter." },
        from: { type: "string", description: "Sender filter." },
        to: { type: "string", description: "Recipient filter." },
        senderDomain: { type: "string", description: "Sender domain filter such as example.com." },
        subject: { type: "string", description: "Subject filter." },
        hasAttachment: { type: "boolean", description: "Attachment filter." },
        attachmentName: { type: "string", description: "Attachment filename filter." },
        isRead: { type: "boolean", description: "Read status filter." },
        isStarred: { type: "boolean", description: "Starred status filter." },
        mailboxRole: { type: "string", description: "Normalized mailbox role like Inbox, Sent, Archive, or Trash." },
        dateFrom: { type: "string", description: "Inclusive start date/time in ISO format." },
        dateTo: { type: "string", description: "Inclusive end date/time in ISO format." },
        limit: { type: "number", description: "Maximum results.", default: 100 },
        fields: { oneOf: [{ type: "array", items: { type: "string" } }, { type: "string" }], description: "Trim each returned email to just these field names (e.g. [\"subject\",\"from\",\"date\"]) to save tokens on large result sets. id is always included. Accepts either an array or a comma-separated string. Omit to get the full object." },
      },
    },
  },
  {
    name: "get_labels",
    description: "Return normalized Proton folders and labels from the local mailbox index, including message counts per label. Use to enumerate available labels before filtering with search_indexed_emails or get_threads. Prefer get_folders for live IMAP folder counts when the index may be stale.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum labels to return. Capped at 250; use get_folders for the complete live folder list.", default: 250 },
      },
    },
  },
  {
    name: "get_threads",
    description: "Return normalized email threads from the local mailbox index, grouping individual messages into conversations by subject and participants. Use to view mail as threads rather than individual messages. Note: searches subject and participants only — use search_indexed_emails to search body content. Prefer get_actionable_threads when you want threads prioritized by reply urgency. Prefer get_inbox_digest for an executive-summary view.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text filter across subject, participants, and labels." },
        label: { type: "string", description: "Require a normalized label on the thread." },
        limit: { type: "number", description: "Maximum threads to return.", default: 100 },
      },
    },
  },
  {
    name: "get_actionable_threads",
    description:
      "Return mailbox threads ranked by reply urgency, filtered to those requiring action. Use for daily triage to surface what needs a response from you. Supports pendingOn filter to distinguish threads waiting on you vs. them. Prefer get_inbox_digest for a broader summary including stale items. Prefer get_threads for an unranked thread list.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text filter across subject, latest preview, senders, and labels." },
        label: { type: "string", description: "Require a normalized label on the thread." },
        pendingOn: {
          type: "string",
          enum: ["you", "them", "any"],
          description: "Filter by who the thread is currently waiting on.",
          default: "any",
        },
        unreadOnly: {
          type: "boolean",
          description: "Prefer threads with unread messages only.",
          default: true,
        },
        limit: { type: "number", description: "Maximum threads to return.", default: 50 },
        syncBefore: {
          type: "boolean",
          description: "Refresh the local mailbox index from IMAP before ranking threads.",
          default: false,
        },
      },
    },
  },
  {
    name: "get_inbox_digest",
    description: "Return a structured inbox summary: unread counts, top actionable threads, and overdue threads where a reply is pending from you. Use as the starting point for an inbox review session to get an at-a-glance picture. Prefer get_actionable_threads for a deeper, filterable list of threads needing action.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum threads per digest section.", default: 10 },
        minAgeHours: {
          type: "number",
          description: "How old a thread must be before it is considered stale waiting on you.",
          default: 24,
        },
        syncBefore: {
          type: "boolean",
          description: "Refresh the local mailbox index from IMAP before building the digest.",
          default: false,
        },
      },
    },
  },
  {
    name: "get_follow_up_candidates",
    description: "Return threads that appear overdue for follow-up based on age and pending-on state. Use when looking for outbound messages you sent that haven't received a reply, or to surface stale inbound threads. Prefer get_actionable_threads for threads where someone is currently waiting on you.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum candidate threads to return.", default: 25 },
        minAgeHours: { type: "number", description: "Minimum thread age in hours.", default: 24 },
        pendingOn: {
          type: "string",
          enum: ["you", "them", "any"],
          description: "Which side the candidate thread should be waiting on.",
          default: "you",
        },
        syncBefore: {
          type: "boolean",
          description: "Refresh the local mailbox index from IMAP before selecting candidates.",
          default: false,
        },
      },
    },
  },
  {
    name: "find_document_threads",
    description: "Find email threads likely containing important document attachments such as invoices, contracts, travel confirmations, or calendar invites. Use to locate attachment-heavy threads by category without knowing the exact sender or subject. Prefer search_indexed_emails with hasAttachment:true for custom attachment queries beyond the built-in categories.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["document", "invoice", "contract", "travel", "calendar"],
          description: "Document category to prioritize.",
          default: "document",
        },
        query: { type: "string", description: "Optional filter across thread subjects and attachment names." },
        limit: { type: "number", description: "Maximum threads to return.", default: 25 },
        syncBefore: {
          type: "boolean",
          description: "Refresh the local mailbox index from IMAP before searching document threads.",
          default: false,
        },
      },
    },
  },
  {
    name: "prepare_meeting_context",
    description: "Fetch recent threads and communication history for a person or company domain to prepare for a meeting or call. Use before a scheduled meeting to surface relevant recent correspondence. Provide at least one of person (name or email fragment) or domain. Returns matched threads sorted by recency.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        person: { type: "string", description: "Person name or email fragment to match." },
        domain: { type: "string", description: "Domain to match, such as example.com." },
        limit: { type: "number", description: "Maximum threads to include.", default: 10 },
        syncBefore: {
          type: "boolean",
          description: "Refresh the local mailbox index from IMAP before building the meeting prep.",
          default: false,
        },
      },
    },
  },
  {
    name: "get_thread_brief",
    description: "Return a summarized view of a single thread: latest inbound message preview, latest outbound preview, attachment list, and a recommended next action. Use for a quick status check on a specific thread without reading every message. Prefer get_thread_by_id when you need the full raw thread data and all messages.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Thread id from get_threads or get_actionable_threads." },
      },
      required: ["threadId"],
    },
  },
  {
    name: "get_thread_by_id",
    description: "Fetch the complete normalized thread record from the local index, including all messages, participants, labels, and full metadata. Use when you need all messages in a thread. Prefer get_thread_brief for a summarized quick view that avoids returning the full message list.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Thread id from get_threads." },
        folders: { type: "array", items: { type: "string" }, description: "Optional folders to scope thread search. Searches all folders when omitted." },
      },
      required: ["threadId"],
    },
  },
  {
    name: "create_thread_reply_draft",
    description:
      "Create a reply draft from a threadId, automatically selecting the latest inbound message to reply to. Use when you have a threadId from get_threads or get_actionable_threads and want to stage a reply for review. Prefer create_reply_draft when you already have a specific emailId. Returns a draftId for later update or send.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Thread id from get_threads or get_actionable_threads." },
        body: { type: "string", description: "Reply body to prepend." },
        replyAll: { type: "boolean", description: "Reply to all original recipients.", default: false },
        preferLatestInbound: {
          type: "boolean",
          description: "Prefer replying to the latest inbound message in the thread.",
          default: true,
        },
        isHtml: { type: "boolean", description: "Store body as HTML.", default: false },
        cc: { type: "string", description: "Additional CC recipients, comma-separated." },
        bcc: { type: "string", description: "Additional BCC recipients, comma-separated." },
        notes: { type: "string", description: "Optional local note for the draft." },
        syncBefore: {
          type: "boolean",
          description: "Refresh the local mailbox index from IMAP before resolving the thread.",
          default: false,
        },
        syncToRemote: {
          type: "boolean",
          description: "Whether to sync the draft to the Proton Drafts mailbox when IMAP is available.",
          default: true,
        },
        attachments: {
          type: "array",
          description: "Attachments with base64 encoded content.",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              content: { type: "string", description: "Base64 content." },
              contentType: { type: "string" },
              cid: { type: "string" },
              contentDisposition: { type: "string" },
            },
            required: ["filename", "content"],
          },
        },
      },
      required: ["threadId", "body"],
    },
  },
  {
    name: "list_attachments",
    description: "List all attachments on a specific email with stable attachmentIds, filenames, content types, and sizes. Use before calling get_attachment_content or save_attachment to discover what attachments are available and get their IDs. Prefer save_attachments when you want to download all attachments at once.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Composite email id in FOLDER::UID format, as returned by get_emails or search_emails." },
        includeInline: { type: "boolean", description: "Include inline attachments.", default: true },
        filenameContains: { type: "string", description: "Optional filename substring filter." },
        contentType: { type: "string", description: "Optional exact content type filter." },
      },
      required: ["emailId"],
    },
  },
  {
    name: "get_attachment_content",
    description: "Fetch metadata for a specific email attachment and optionally return its base64-encoded content inline. Use when you need to read or process attachment data in-memory. Set includeBase64:false (default) to retrieve metadata only without loading the full payload. Prefer save_attachment to write the file to disk instead.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Composite email id in FOLDER::UID format, as returned by get_emails or search_emails." },
        attachmentId: { type: "string", description: "Stable attachment id returned by list_attachments." },
        includeBase64: { type: "boolean", description: "Include base64 payload in the response.", default: false },
        saveTo: { type: "string", description: "Relative path within PROTONMAIL_ALLOW_FILE_DOWNLOAD_DIR to save attachment to disk. Returns file path and size instead of inline base64. Requires env var to be set. Set PROTONMAIL_MAX_INLINE_BYTES (in KB, default 40) to configure the inline size threshold." },
      },
      required: ["emailId", "attachmentId"],
    },
  },
  {
    name: "get_attachment_text",
    description: "Extract plain text from a text-like attachment (text/plain, text/csv, text/markdown, application/json, application/xml, text/html stripped of markup, text/calendar summarized) without dealing with base64 encoding. Not gated by the smaller inline-base64 size limit that get_attachment_content uses — bounded separately at 512KB of raw content. Fails clearly for non-text formats (e.g. PDF, images) — use get_attachment_content or save_attachment for those.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Composite email id in FOLDER::UID format, as returned by get_emails or search_emails." },
        attachmentId: { type: "string", description: "Stable attachment id returned by list_attachments." },
      },
      required: ["emailId", "attachmentId"],
    },
  },
  {
    name: "save_attachments",
    description: "Save all qualifying attachments from an email to a directory on disk, with optional filename substring or content-type filters. Use to batch-download attachments from a single email. Returns the list of written file paths. Prefer save_attachment when you need to save one specific attachment by its attachmentId.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Composite email id in FOLDER::UID format, as returned by get_emails or search_emails." },
        outputPath: { type: "string", description: "Optional target directory or file path." },
        includeInline: { type: "boolean", description: "Include inline attachments.", default: false },
        filenameContains: { type: "string", description: "Optional filename substring filter." },
        contentType: { type: "string", description: "Optional exact content type filter." },
      },
      required: ["emailId"],
    },
  },
  {
    name: "save_attachment",
    description: "Save a single email attachment to disk by its attachmentId and return the written file path. Use when you have a specific attachmentId from list_attachments and want to write that file. Prefer save_attachments to save all or filtered attachments from an email without needing individual attachment IDs.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Composite email id in FOLDER::UID format, as returned by get_emails or search_emails." },
        attachmentId: { type: "string", description: "Stable attachment id returned by list_attachments." },
        outputPath: { type: "string", description: "Optional file or directory path to write to." },
        saveTo: { type: "string", description: "Relative path within PROTONMAIL_ALLOW_FILE_DOWNLOAD_DIR to save attachment to disk. Returns file path and size instead of inline base64. Requires env var to be set. Set PROTONMAIL_MAX_INLINE_BYTES (in KB, default 40) to configure the inline size threshold." },
      },
      required: ["emailId", "attachmentId"],
    },
  },
  {
    name: "export_email",
    description: "Save a message's full raw source (RFC822/.eml) to disk. Use for backup or migrating a message elsewhere. Requires PROTONMAIL_ALLOW_FILE_DOWNLOAD_DIR to be configured, same as save_attachment.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Composite email id in FOLDER::UID format." },
        outputPath: { type: "string", description: "Optional file or directory path to write the .eml to." },
      },
      required: ["emailId"],
    },
  },
  {
    name: "import_email",
    description: "Import a raw RFC822 message (.eml content) into a folder via IMAP APPEND. Use to restore a backed-up message or migrate mail from another provider's export. Does not send anything — this only inserts a message directly into the mailbox. Many real .eml exports use a legacy 8-bit charset (ISO-8859-1, Windows-1252, etc.) rather than UTF-8 for their header/body text outside of MIME-encoded parts — passing that content through `raw` corrupts or rejects it. Use `rawBase64` instead for any message not already known to be valid UTF-8.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        raw: { type: "string", description: "Full raw RFC822 message source (the .eml file content) as a UTF-8 string. Use rawBase64 instead for non-UTF-8 content. Exactly one of raw/rawBase64 is required." },
        rawBase64: { type: "string", description: "Full raw RFC822 message source (the .eml file content), base64-encoded, for byte-exact import of non-UTF-8 content. Exactly one of raw/rawBase64 is required." },
        targetFolder: { type: "string", description: "Destination folder. Defaults to INBOX." },
        markAsRead: { type: "boolean", description: "Set the \\Seen flag on import.", default: false },
      },
    },
  },
  {
    name: "clear_cache",
    description: "Evict all in-memory caches: folder list, message metadata, and analytics data. Use when cached data appears stale after external mailbox changes (e.g. folders modified via Proton webmail). Does NOT affect the persistent SQLite index — use clear_index for that.",
    annotations: { destructiveHint: false },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "clear_index",
    description: "Delete the entire persistent SQLite mailbox index from disk. Use only to reset a corrupted or schema-incompatible index. After clearing, call sync_emails to rebuild. Irreversible — all indexed metadata and search history is lost. Does NOT clear in-memory caches — use clear_cache for that.",
    annotations: { destructiveHint: true },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_logs",
    description: "Return recent in-memory server log entries, filterable by level (debug, info, warn, error). Use to diagnose unexpected tool behavior or connection errors during the current session. Logs are ephemeral and not persisted across server restarts — use get_audit_logs for a persistent audit trail of write operations.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["debug", "info", "warn", "error"] },
        limit: { type: "number", default: 100 },
        offset: { type: "number", description: "Number of records to skip for pagination.", default: 0 },
      },
    },
  },
  {
    name: "get_audit_logs",
    description: "Return recent entries from the persistent on-disk audit log of all write operations performed by this server. Use to review what mutations (sends, moves, deletes, draft operations) were executed across sessions. Prefer get_logs for debugging in-session behavior and transient connection errors.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 100 },
        offset: { type: "number", description: "Number of records to skip for pagination.", default: 0 },
      },
    },
  },
] as const;

// Core tier: the 20 tools that cover ~80% of daily email use.
// Set PROTONMAIL_TOOL_TIER=core to expose only these — reduces context-window burn
// significantly on every session. Default is "full" (all tools).
export const CORE_TOOL_NAMES = new Set([
  "get_emails",
  "get_email_by_id",
  // search_emails (live IMAP) is deliberately excluded from core — it
  // overlaps with search_indexed_emails (faster, offline-capable, and
  // already the "prefer" default per its own description) and the core
  // tier exists specifically to reduce tool-selection overlap. Still
  // available under PROTONMAIL_TOOL_TIER=full for stale-index/live-only cases.
  "search_indexed_emails",
  "send_email",
  "reply_to_email",
  "create_draft",
  "send_draft",
  "trash_email",
  "archive_email",
  "mark_email_read",
  "star_email",
  "move_email",
  "get_threads",
  "get_thread_brief",
  "get_inbox_digest",
  "get_actionable_threads",
  "get_folders",
  "sync_emails",
  "get_connection_status",
]);

function citationToResourceLink(source: CitationSource): ToolResult["content"][number] {
  return {
    type: "resource_link",
    uri: source.uri,
    name: source.name,
    title: source.title,
    description: source.description,
    mimeType: source.mimeType,
  };
}

function normalizeStructuredContent(value: unknown): Record<string, unknown> | undefined {
  const normalized = normalizeJsonValue(value);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    return undefined;
  }
  return normalized as Record<string, unknown>;
}

function withSources<T>(value: T, sources: CitationSource[]): T | (T & { sources: CitationSource[] }) {
  if (sources.length === 0 || !value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return {
    ...(value as Record<string, unknown>),
    sources,
  } as T & { sources: CitationSource[] };
}

function createTextResult(
  value: unknown,
  isError = false,
  sources: CitationSource[] = [],
): ToolResult {
  const payload = withSources(value, sources);
  return {
    content: [
      { type: "text", text: typeof payload === "string" ? payload : stringifyForJson(payload) },
      ...sources.map(citationToResourceLink),
    ],
    structuredContent: normalizeStructuredContent(payload),
    ...(isError ? { isError: true } : {}),
  };
}

function sanitizeAuditValue(value: unknown): unknown {
  if (value === undefined || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditValue(item));
  }

  if (typeof value === "string") {
    return value.length > 300 ? `[redacted:${value.length} chars]` : value;
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => {
        if (
          key === "body" ||
          key === "html" ||
          key === "text" ||
          key === "base64" ||
          key === "customMessage" ||
          /password|secret|token/i.test(key)
        ) {
          return [key, "[redacted]"];
        }

        if (key === "attachments" && Array.isArray(entryValue)) {
          return [
            key,
            entryValue.map((attachment) => {
              const object = asObject(attachment);
              return {
                filename: object.filename,
                contentType: object.contentType,
                cid: object.cid,
              };
            }),
          ];
        }

        return [key, sanitizeAuditValue(entryValue)];
      }),
    );
  }

  return value;
}

export async function withAudit<T>(
  auditService: AuditService,
  tool: string,
  input: Record<string, unknown>,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await operation();
    await auditService.record({
      timestamp: new Date().toISOString(),
      tool,
      status: "success",
      durationMs: Date.now() - startedAt,
      input: sanitizeAuditValue(input),
      result: sanitizeAuditValue(result),
    });
    return result;
  } catch (error) {
    await auditService.record({
      timestamp: new Date().toISOString(),
      tool,
      status: "error",
      durationMs: Date.now() - startedAt,
      input: sanitizeAuditValue(input),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new McpError(ErrorCode.InvalidParams, `${key} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Shared by get_email_by_id and get_emails_by_ids: applies body preference/
// truncation and strips the full raw header map by default (needless token
// bloat — get_email_by_id re-adds it when showHeaders is explicitly true).
function formatEmailDetailOutput(
  detail: EmailDetail,
  preferHtml: boolean,
  maxBodyLength: number,
): Record<string, unknown> {
  let displayBody = preferHtml
    ? (typeof detail.html === "string" ? detail.html : detail.text ?? "")
    : (detail.text ?? "");
  // Only the plain-text path: quote-boundary detection is regex-based on
  // ">"-prefixed lines and "wrote:" markers, which doesn't map onto HTML
  // (blockquotes, interspersed tags) — folding raw HTML here would corrupt
  // it, not shrink it. Comparison against other Proton MCP servers found
  // this is real, avoidable token bloat on a message deep in a thread that
  // repeats every prior reply verbatim at the bottom.
  if (!preferHtml && displayBody) {
    displayBody = foldQuotedHistory(displayBody);
  }
  if (maxBodyLength) {
    const codepoints = [...displayBody];
    if (codepoints.length > maxBodyLength) {
      displayBody = codepoints.slice(0, maxBodyLength).join("") + `\n[truncated at ${maxBodyLength} chars]`;
    }
  }

  const output: Record<string, unknown> = {
    ...detail,
    text: displayBody,
    security: buildSecurityInfo(detail),
    // Disposition-Notification-To means the sender asked for a read receipt.
    // Surfaced so an agent can decide whether to honor it — this server never
    // sends an MDN automatically.
    readReceiptRequested: Boolean(headerString(detail.headers, "disposition-notification-to")),
  };
  if (!preferHtml) delete output.html;
  delete output.headers;
  return output;
}

// mailparser merges List-Unsubscribe (and other List-*) headers into
// detail.headers.list.unsubscribe = { mail?: string, url?: string, name?: string }
// (mail has the "mailto:" prefix already stripped). See mapHeaderValue in
// simple-imap-service.ts for how this nested shape survives serialization.
export function headerString(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = headers?.[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

// Authentication-Results (RFC 8601) is a semi-structured string, not something
// mailparser special-cases into an object: "mx.google.com; dkim=pass ...;
// spf=pass ...; dmarc=pass ...". Pull out the result word for each mechanism.
export function parseAuthenticationResults(value?: string): { dkim?: string; spf?: string; dmarc?: string } {
  if (!value) return {};
  const match = (mechanism: string) => value.match(new RegExp(`\\b${mechanism}=(\\w+)`, "i"))?.[1]?.toLowerCase();
  return { dkim: match("dkim"), spf: match("spf"), dmarc: match("dmarc") };
}

// Bridge injects Proton-only security metadata into every message it serves.
// Surfacing it lets an agent answer "is this email legit?" using signals a
// generic IMAP client can't see — verified against a live Bridge connection
// during the roadmap audit that motivated this tool (x-pm-origin,
// x-pm-content-encryption, x-pm-transfer-encryption, x-pm-spamscore,
// x-pm-spam-action, and a standard Authentication-Results header were all
// observed present on a real message).
export function buildSecurityInfo(detail: EmailDetail): Record<string, unknown> {
  const headers = detail.headers;
  const auth = parseAuthenticationResults(headerString(headers, "authentication-results"));
  return {
    origin: headerString(headers, "x-pm-origin"),
    contentEncryption: headerString(headers, "x-pm-content-encryption"),
    transferEncryption: headerString(headers, "x-pm-transfer-encryption"),
    spamScore: headerString(headers, "x-pm-spamscore"),
    spamAction: headerString(headers, "x-pm-spam-action"),
    dkim: auth.dkim,
    spf: auth.spf,
    dmarc: auth.dmarc,
  };
}

export function extractUnsubscribeInfo(detail: EmailDetail): { mailto?: string; url?: string } {
  const list = detail.headers?.list as Record<string, unknown> | undefined;
  const unsubscribe = list?.unsubscribe as Record<string, unknown> | undefined;
  const mail = typeof unsubscribe?.mail === "string" ? unsubscribe.mail : undefined;
  const url = typeof unsubscribe?.url === "string" ? unsubscribe.url : undefined;
  return {
    mailto: mail && isValidEmail(mail) ? mail : undefined,
    url,
  };
}

function parseFieldsArg(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  return undefined;
}

function parseListValues(value?: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseStringListArg(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return parseListValues(value);
  }

  throw new McpError(ErrorCode.InvalidParams, `${key} must be a non-empty string or string array.`);
}

function requireEmailAction(args: Record<string, unknown>, key = "action"): EmailAction {
  const value = requireString(args, key);
  switch (value) {
    case "mark_read":
    case "mark_unread":
    case "star":
    case "unstar":
    case "archive":
    case "trash":
    case "restore":
    case "move":
    case "delete":
      return value;
    default:
      throw new McpError(ErrorCode.InvalidParams, `${key} must be a supported email action.`);
  }
}

function optionalAttachmentList(value: unknown): EmailAttachmentInput[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new McpError(ErrorCode.InvalidParams, "attachments must be an array.");
  }

  return value.map((item, index) => {
    const attachment = asObject(item);
    const filename = requireString(attachment, "filename");
    const content = requireString(attachment, "content");
    const contentType = optionalString(attachment, "contentType");
    const cid = optionalString(attachment, "cid");
    const contentDisposition = optionalString(attachment, "contentDisposition");

    if (!filename || !content) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `attachments[${index}] must contain filename and content.`,
      );
    }

    return {
      filename,
      content,
      contentType,
      cid,
      contentDisposition,
    };
  });
}

function uniqueAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const address of addresses) {
    const normalized = lowerCaseAddress(address);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(address.trim());
  }

  return result;
}

function addressValues(addresses: EmailAddress[]): string[] {
  return uniqueAddresses(
    addresses
      .map((value) => value.address?.trim())
      .filter((value): value is string => Boolean(value)),
  );
}

function prefixedSubject(subject: string, prefix: "Re:" | "Fwd:"): string {
  const trimmed = subject.trim();
  if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
    return trimmed;
  }
  return `${prefix} ${trimmed}`;
}

function formatAddressList(addresses: EmailAddress[]): string {
  return addresses
    .map((value) => {
      if (value.name && value.address) {
        return `${value.name} <${value.address}>`;
      }
      return value.address || value.name || "";
    })
    .filter(Boolean)
    .join(", ");
}

function quotePlainText(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

function buildReplyText(detail: EmailDetail, body: string): string {
  const originalText = detail.text || detail.preview || "";
  const fromText = formatAddressList(detail.from);
  const dateText = detail.date || detail.internalDate || "an unknown date";

  return [
    body.trim(),
    "",
    `On ${dateText}, ${fromText || "the sender"} wrote:`,
    quotePlainText(originalText),
  ].join("\n");
}

function buildForwardText(detail: EmailDetail, body?: string): string {
  const originalText = detail.text || detail.preview || "";

  return [
    body?.trim() || "",
    body?.trim() ? "" : "",
    "---------- Forwarded message ---------",
    `From: ${formatAddressList(detail.from)}`,
    `Date: ${detail.date || detail.internalDate || ""}`,
    `Subject: ${detail.subject}`,
    `To: ${formatAddressList(detail.to)}`,
    detail.cc.length > 0 ? `Cc: ${formatAddressList(detail.cc)}` : "",
    "",
    originalText,
  ]
    .filter((line, index, array) => line !== "" || (index > 0 && array[index - 1] !== ""))
    .join("\n");
}

export function getReplyRecipients(
  detail: EmailDetail,
  ownerEmail: string,
  replyAll: boolean,
): { to: string[]; cc: string[] } {
  const owner = lowerCaseAddress(ownerEmail);
  const primary = addressValues(detail.replyTo).length > 0 ? detail.replyTo : detail.from;
  const primaryAddresses = addressValues(primary);
  const strippedTo = uniqueAddresses(primaryAddresses.filter((address) => lowerCaseAddress(address) !== owner));
  // A self-addressed email (e.g. a "note to self") has no other party to
  // reply to — stripping the owner then leaves zero recipients and every
  // reply throws "Unable to infer reply recipient." Every real mail client
  // replies back to the same address in that case instead of refusing.
  // Found live: replying to a self-sent test fixture failed outright.
  const to = strippedTo.length > 0 ? strippedTo : uniqueAddresses(primaryAddresses);

  if (!replyAll) {
    return { to, cc: [] };
  }

  const ccPool = uniqueAddresses([
    ...addressValues(detail.to),
    ...addressValues(detail.cc),
  ]).filter((address) => {
    const normalized = lowerCaseAddress(address);
    return normalized !== owner && !to.some((recipient) => lowerCaseAddress(recipient) === normalized);
  });

  return { to, cc: ccPool };
}

function buildEmailResourceUri(emailId: string): string {
  return `${RESOURCE_SCHEME}://email/${encodeURIComponent(emailId)}`;
}

function buildThreadResourceUri(threadId: string): string {
  return `${RESOURCE_SCHEME}://thread/${encodeURIComponent(threadId)}`;
}

function buildDraftResourceUri(draftId: string): string {
  return `${RESOURCE_SCHEME}://draft/${encodeURIComponent(draftId)}`;
}

function buildAttachmentResourceUri(emailId: string, attachmentId: string): string {
  return `${RESOURCE_SCHEME}://attachment/${encodeURIComponent(emailId)}/${encodeURIComponent(attachmentId)}`;
}

function emailSource(
  email: Pick<EmailSummary, "id" | "subject" | "folder"> &
    Partial<Pick<EmailSummary, "date" | "internalDate" | "messageId" | "threadId" | "preview" | "from">>,
): CitationSource {
  const fromText = email.from && email.from.length > 0 ? formatAddressList(email.from) : undefined;
  return {
    uri: buildEmailResourceUri(email.id),
    name: email.id,
    title: email.subject,
    description: [email.folder, email.internalDate || email.date || "undated", fromText].filter(Boolean).join(" · "),
    mimeType: "message/rfc822",
    provider: "proton-bridge-imap",
    snippet: email.preview,
    locator: {
      kind: "email",
      emailId: email.id,
      folder: email.folder,
      messageId: email.messageId,
      threadId: email.threadId,
      from: fromText,
      subject: email.subject,
      date: email.internalDate || email.date,
    },
  };
}

function threadSource(thread: {
  id: string;
  subject: string;
  latestDate?: string;
  messageCount: number;
  normalizedLabels?: string[];
  participants?: EmailAddress[];
}): CitationSource {
  return {
    uri: buildThreadResourceUri(thread.id),
    name: thread.id,
    title: thread.subject,
    description: `${thread.messageCount} message(s) · ${thread.latestDate || "undated"}`,
    mimeType: "text/markdown",
    provider: "local-index",
    snippet: thread.participants && thread.participants.length > 0 ? formatAddressList(thread.participants) : undefined,
    locator: {
      kind: "thread",
      threadId: thread.id,
      normalizedLabels: thread.normalizedLabels,
      participants: thread.participants?.map((entry) => entry.address || entry.name).filter(Boolean),
    },
  };
}

function draftSource(draft: DraftRecord): CitationSource {
  return {
    uri: buildDraftResourceUri(draft.id),
    name: draft.id,
    title: draft.subject,
    description: `${draft.status} · updated ${draft.updatedAt}`,
    mimeType: "text/markdown",
    provider: "local-draft-store",
    locator: {
      kind: "draft",
      draftId: draft.id,
      remoteEmailId: draft.remoteDraft?.emailId,
    },
  };
}

function attachmentSource(
  emailId: string,
  attachment: NonNullable<EmailDetail["attachments"]>[number],
): CitationSource {
  const attachmentId = attachment.id || attachment.filename || "attachment";
  return {
    uri: buildAttachmentResourceUri(emailId, attachmentId),
    name: attachmentId,
    title: attachment.filename || attachmentId,
    description: `${attachment.contentType || "application/octet-stream"} · ${attachment.size || 0} bytes`,
    mimeType: attachment.contentType || "application/octet-stream",
    provider: "proton-bridge-imap",
    locator: {
      kind: "attachment",
      emailId,
      attachmentId,
      filename: attachment.filename,
    },
  };
}

function formatEmailResource(detail: EmailDetail): string {
  return [
    `# ${detail.subject}`,
    "",
    `- Email ID: ${detail.id}`,
    detail.messageId ? `- Message-ID: ${detail.messageId}` : "",
    detail.threadId ? `- Thread ID: ${detail.threadId}` : "",
    detail.references && detail.references.length > 0 ? `- References: ${detail.references.join(", ")}` : "",
    `- Folder: ${detail.folder}`,
    `- Date: ${detail.internalDate || detail.date || "unknown"}`,
    `- From: ${formatAddressList(detail.from) || "unknown"}`,
    `- To: ${formatAddressList(detail.to) || "unknown"}`,
    detail.cc.length > 0 ? `- Cc: ${formatAddressList(detail.cc)}` : "",
    "",
    detail.text || detail.preview || "(no body text available)",
    detail.attachmentText ? "" : "",
    detail.attachmentText ? "## Attachment Text" : "",
    detail.attachmentText || "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatThreadResource(thread: {
  id: string;
  subject: string;
  latestDate?: string;
  normalizedLabels: string[];
  messages: Array<Pick<EmailDetail, "id" | "subject" | "from" | "date" | "internalDate" | "preview">>;
}): string {
  return [
    `# ${thread.subject}`,
    "",
    `- Thread ID: ${thread.id}`,
    `- Latest: ${thread.latestDate || "unknown"}`,
    `- Labels: ${thread.normalizedLabels.join(", ") || "(none)"}`,
    "",
    ...thread.messages.flatMap((message) => [
      `## ${message.subject}`,
      `- Email ID: ${message.id}`,
      `- From: ${formatAddressList(message.from) || "unknown"}`,
      `- Date: ${message.internalDate || message.date || "unknown"}`,
      "",
      message.preview || "(no preview)",
      "",
    ]),
  ].join("\n");
}

function formatDraftResource(draft: DraftRecord): string {
  return [
    `# ${draft.subject}`,
    "",
    `- Draft ID: ${draft.id}`,
    `- Status: ${draft.status}`,
    `- Mode: ${draft.mode}`,
    `- Updated: ${draft.updatedAt}`,
    `- Remote Sync: ${draft.remoteSyncState}`,
    draft.remoteDraft?.emailId ? `- Remote Email ID: ${draft.remoteDraft.emailId}` : "",
    `- To: ${draft.to.join(", ") || "(none)"}`,
    draft.cc.length > 0 ? `- Cc: ${draft.cc.join(", ")}` : "",
    draft.bcc.length > 0 ? `- Bcc: ${draft.bcc.join(", ")}` : "",
    "",
    draft.body,
  ]
    .filter(Boolean)
    .join("\n");
}

type ParsedResourceUri =
  | { kind: "email"; emailId: string }
  | { kind: "thread"; threadId: string }
  | { kind: "draft"; draftId: string }
  | { kind: "attachment"; emailId: string; attachmentId: string };

function parseResourceUri(uri: string): ParsedResourceUri {
  const parsed = new URL(uri);
  if (parsed.protocol !== `${RESOURCE_SCHEME}:`) {
    throw new Error(`Unsupported resource URI: ${uri}`);
  }

  const segments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));

  switch (parsed.hostname) {
    case "email":
      if (segments.length !== 1) {
        break;
      }
      return { kind: "email", emailId: segments[0] };
    case "thread":
      if (segments.length !== 1) {
        break;
      }
      return { kind: "thread", threadId: segments[0] };
    case "draft":
      if (segments.length !== 1) {
        break;
      }
      return { kind: "draft", draftId: segments[0] };
    case "attachment":
      if (segments.length !== 2) {
        break;
      }
      return { kind: "attachment", emailId: segments[0], attachmentId: segments[1] };
    default:
      break;
  }

  throw new Error(`Unsupported resource URI: ${uri}`);
}

async function syncDraftToRemote(
  draftStore: DraftStoreService,
  smtpService: SMTPService,
  imapService: SimpleIMAPService,
  draft: DraftRecord,
): Promise<{
  draft: DraftRecord;
  remoteSync: { ok: boolean; emailId?: string; message?: string };
}> {
  try {
    const raw = await smtpService.buildRawMessage({
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      body: draft.body,
      isHtml: draft.isHtml,
      priority: draft.priority,
      replyTo: draft.replyTo,
      inReplyTo: draft.inReplyTo,
      references: draft.references,
      messageId: draft.draftMessageId,
      attachments: draft.attachments,
    });

    const remoteDraft = await imapService.upsertRemoteDraft({
      raw,
      messageId: draft.draftMessageId,
      existingEmailId: draft.remoteDraft?.emailId,
    });

    return {
      draft: await draftStore.markRemoteSynced(draft.id, remoteDraft),
      remoteSync: {
        ok: true,
        emailId: remoteDraft.emailId,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Draft remote sync failed", "MCPServer", { draftId: draft.id, error });
    return {
      draft: await draftStore.markRemoteSyncError(draft.id, message),
      remoteSync: {
        ok: false,
        message,
      },
    };
  }
}

async function clearRemoteDraft(
  draftStore: DraftStoreService,
  imapService: SimpleIMAPService,
  draft: DraftRecord,
): Promise<{
  draft: DraftRecord;
  remoteDelete?: { ok: boolean; message?: string };
}> {
  if (!draft.remoteDraft?.emailId) {
    return {
      draft,
    };
  }

  try {
    await imapService.deleteRemoteDraft(draft.remoteDraft.emailId);
    return {
      draft: await draftStore.clearRemoteSync(draft.id),
      remoteDelete: {
        ok: true,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Remote draft cleanup failed", "MCPServer", { draftId: draft.id, error });
    return {
      draft,
      remoteDelete: {
        ok: false,
        message,
      },
    };
  }
}

async function ensureFreshLocalIndex(
  imapService: SimpleIMAPService,
  localIndexService: LocalIndexService,
  input: {
    folder?: string;
    full?: boolean;
    limitPerFolder?: number;
  } = {},
) {
  const checkpoints = await localIndexService.getSyncCheckpointMap();
  const snapshot = await imapService.collectEmailsForIndex({
    folder: input.folder,
    full: input.full ?? false,
    limitPerFolder: input.limitPerFolder,
    includeAttachmentText: true,
    checkpoints,
  });

  const indexStatus = await localIndexService.recordSnapshot({
    folders: snapshot.folders,
    emails: snapshot.emails,
    syncedAt: snapshot.syncedAt,
    folderStats: snapshot.folderStats,
  });

  return {
    snapshot,
    indexStatus,
  };
}

async function maybeRefreshLocalIndex(
  imapService: SimpleIMAPService,
  localIndexService: LocalIndexService,
  input: {
    force?: boolean;
    folder?: string;
    full?: boolean;
    limitPerFolder?: number;
  } = {},
) {
  const status = await localIndexService.getStatus();
  if (!input.force && status.storedMessageCount > 0 && !status.isStale) {
    return undefined;
  }

  return ensureFreshLocalIndex(imapService, localIndexService, {
    folder: input.folder,
    full: input.full,
    limitPerFolder: input.limitPerFolder,
  });
}

// get_email_stats/get_email_analytics/get_contacts/get_volume_trends used to
// sample via imapService.getAnalyticsSample, which ran a live IMAP SEARCH
// sequentially across every folder in the account — on a real account with a
// normal number of labels (13 here) that reliably exceeded a client's 60s
// request timeout, so all four tools failed on every call despite one being
// documented as "fast". Reading from the local index instead (same source
// get_actionable_threads/get_inbox_digest already use, refreshed the same
// lazy way via maybeRefreshLocalIndex) is a single fast SQL query regardless
// of folder count. Trade-off: results now reflect the last sync, not live
// IMAP state — same staleness characteristics as every other local-index tool
// (see sync_emails' own description for why that can lag behind trash/move).
async function getAnalyticsSampleFromIndex(
  imapService: SimpleIMAPService,
  localIndexService: LocalIndexService,
  days: number,
  limit: number,
): Promise<EmailSummary[]> {
  await maybeRefreshLocalIndex(imapService, localIndexService, {});
  const dateFrom = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const result = await localIndexService.search({ dateFrom, limit });
  return result.emails;
}

async function runEmailAction(
  imapService: SimpleIMAPService,
  emailId: string,
  action: EmailAction,
  targetFolder?: string,
): Promise<unknown> {
  switch (action) {
    case "mark_read":
      return imapService.markEmailRead(emailId, true);
    case "mark_unread":
      return imapService.markEmailRead(emailId, false);
    case "star":
      return imapService.starEmail(emailId, true);
    case "unstar":
      return imapService.starEmail(emailId, false);
    case "archive":
      return imapService.archiveEmail(emailId);
    case "trash":
      return imapService.trashEmail(emailId);
    case "restore":
      return imapService.restoreEmail(emailId, targetFolder);
    case "move":
      if (!targetFolder) throw new McpError(ErrorCode.InvalidParams, "targetFolder is required for action 'move'.");
      return imapService.moveEmail(emailId, targetFolder);
    case "delete":
      return imapService.deleteEmail(emailId);
  }
}

function emailSourceFromActionResult(result: unknown): CitationSource[] {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return [];
  }

  const candidateKeys = ["targetEmailId", "emailId"] as const;
  const emailIds = new Set<string>();

  for (const key of candidateKeys) {
    const value = (result as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) {
      emailIds.add(value.trim());
    }
  }

  return [...emailIds].map((emailId) => ({
    uri: buildEmailResourceUri(emailId),
    name: emailId,
    title: `Email ${emailId}`,
    mimeType: "message/rfc822",
  }));
}

async function applyBatchEmailAction(
  imapService: SimpleIMAPService,
  entries: BatchActionEntry[],
  input: {
    emailIds: string[];
    action: EmailAction;
    targetFolder?: string;
    continueOnError: boolean;
    dryRun?: boolean;
  },
): Promise<BatchActionResult> {
  for (const emailId of input.emailIds) {
    try {
      // Unlike SimpleIMAPService's own bulk*/thread* loops, this one had no
      // per-item bound — a single wedged IMAP call (same shared connection,
      // same churn from the perpetual IDLE watcher) hung the *entire*
      // tools/call response forever, with no timeout to degrade it to a
      // per-item failure. Reused verbatim rather than duplicated, since it
      // also forces the same reconnect-on-timeout SimpleIMAPService's other
      // callers rely on to keep the item after it from wedging too.
      const action = input.dryRun
        ? previewEmailAction(imapService, emailId, input.action, input.targetFolder)
        : runEmailAction(imapService, emailId, input.action, input.targetFolder);
      const result = await imapService.withTimeout(
        action,
        BULK_ITEM_TIMEOUT_MS,
        `Timed out after ${BULK_ITEM_TIMEOUT_MS}ms running ${input.action} on ${emailId}`,
      );
      entries.push({
        emailId,
        ok: true,
        action: input.action,
        result,
      });
    } catch (error) {
      entries.push({
        emailId,
        ok: false,
        action: input.action,
        error: error instanceof Error ? error.message : String(error),
      });

      if (!input.continueOnError) {
        break;
      }
    }
  }

  const succeeded = entries.filter((entry) => entry.ok).length;
  return {
    action: input.action,
    total: input.emailIds.length,
    succeeded,
    failed: entries.length - succeeded,
    results: entries,
  };
}

async function previewEmailAction(
  imapService: SimpleIMAPService,
  emailId: string,
  action: EmailAction,
  targetFolder?: string,
): Promise<Record<string, unknown>> {
  const detail = await imapService.getEmailById(emailId);
  const target =
    action === "archive"
      ? "Archive"
      : action === "trash"
        ? "Trash"
        : action === "restore"
          ? targetFolder || "INBOX"
          : action === "move"
            ? targetFolder || detail.folder
            : action === "delete"
              ? "(expunged)"
              : detail.folder;

  return {
    emailId,
    previewOnly: true,
    action,
    currentFolder: detail.folder,
    targetFolder: target,
    subject: detail.subject,
    from: detail.from,
    date: detail.internalDate || detail.date,
    hasAttachments: detail.hasAttachments,
    isRead: detail.isRead,
    isStarred: detail.isStarred,
  };
}

// Best-effort: confirms the sent copy landed in the Sent folder, purely for
// the sentCopy:"[sent-copy:verified]" hint in the response. sentCopyVerify
// already does its own robust folder resolution internally (by specialUse,
// then by name) on every call — retrying it with different guessed folder
// names here was redundant and, worse, sequential (up to 3 x 30s = 90s),
// which blocked the send_email response long enough to trip the MCP
// client's own request timeout on an email that had already sent
// successfully. One bounded call; failing to verify quickly just means the
// hint stays "unverified", never a false failure.
async function verifySentCopy(
  imapService: SimpleIMAPService,
  messageId: string,
): Promise<{ found: boolean; uid?: number }> {
  return imapService.sentCopyVerify(messageId, "Sent", 8_000);
}

function getBulkMaxBatchSize(args: Record<string, unknown>): number {
  return typeof args.maxBatchSize === "number" ? Math.min(args.maxBatchSize, 2000) : 500;
}

function ensureBulkBatchSize(uidsLength: number, max: number): void {
  if (uidsLength > max) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "Batch size " + uidsLength + " exceeds limit " + max + ". Use match criteria to narrow the scope, or increase maxBatchSize.",
    );
  }
}

function getBulkNotFoundEmailIds(emailIds: string[] | undefined, folder: string): string[] {
  if (!emailIds) {
    return [];
  }

  return emailIds.filter((emailId) => {
    // Found live: this compared the emailId's folder segment against
    // `folder` as raw, still-percent-encoded text — createEmailId encodes
    // it (Folders/MCP-Snoozed -> Folders%2FMCP-Snoozed) but `folder` here
    // is the plain path callers actually pass. Every real emailId in any
    // folder with a "/" or other encoded character (any Folders/* or
    // Labels/* path, not just top-level INBOX/Archive/etc.) never matched,
    // so bulk_move/bulk_delete/bulk_update_flags/bulk_update_labels
    // reported genuinely valid ids as notFound. parseEmailId already does
    // the matching decodeURIComponent correctly — reuse it instead of
    // hand-rolling the same parse a second, inconsistent way.
    try {
      const parsed = parseEmailId(emailId);
      return parsed.folder !== folder;
    } catch {
      return true;
    }
  });
}

function withBulkNotFound(
  result: BulkOperationResult,
  notFoundEmailIds: string[],
): BulkOperationResult {
  if (notFoundEmailIds.length === 0) {
    return result;
  }

  return {
    ...result,
    total: result.total + notFoundEmailIds.length,
    notFound: result.notFound + notFoundEmailIds.length,
    results: [
      ...result.results,
      ...notFoundEmailIds.map((emailId) => ({
        uid: 0,
        emailId,
        ok: false,
        error: "Email ID could not be resolved to a UID.",
      })),
    ],
  };
}

function paginateRecentRecords<T>(records: T[], limit: number, offset: number): T[] {
  return records.slice(offset, offset + limit);
}

function pickReplyTargetFromThread(
  thread: Awaited<ReturnType<LocalIndexService["getThreadById"]>>,
  ownerEmail: string,
  preferLatestInbound: boolean,
) {
  const messages = [...thread.messages];
  if (preferLatestInbound) {
    const inbound = [...messages]
      .reverse()
      .find(
        (message) =>
          !message.from.some((address) => lowerCaseAddress(address.address) === lowerCaseAddress(ownerEmail)),
      );
    if (inbound) {
      return inbound;
    }
  }

  return messages[messages.length - 1];
}

function buildThreadBrief(
  thread: Awaited<ReturnType<LocalIndexService["getThreadById"]>>,
  ownerEmail: string,
): Record<string, unknown> {
  const messages = [...thread.messages];
  const latestMessage = messages[messages.length - 1];
  const latestInbound = [...messages]
    .reverse()
    .find((message) => !message.from.some((entry) => lowerCaseAddress(entry.address) === lowerCaseAddress(ownerEmail)));
  const latestOutbound = [...messages]
    .reverse()
    .find((message) => message.from.some((entry) => lowerCaseAddress(entry.address) === lowerCaseAddress(ownerEmail)));
  const pendingOn = latestMessage
    ? latestMessage.from.some((entry) => lowerCaseAddress(entry.address) === lowerCaseAddress(ownerEmail))
      ? "them"
      : "you"
    : "unknown";

  return {
    threadId: thread.id,
    subject: thread.subject,
    messageCount: thread.messageCount,
    unreadCount: thread.unreadCount,
    latestDate: thread.latestDate,
    normalizedLabels: thread.normalizedLabels,
    participants: thread.participants,
    pendingOn,
    likelyNextAction: pendingOn === "you" ? "reply" : pendingOn === "them" ? "wait_or_follow_up" : "review",
    latestInbound: latestInbound
      ? {
          emailId: latestInbound.primaryEmailId,
          from: latestInbound.from,
          date: latestInbound.internalDate || latestInbound.date,
          preview: latestInbound.preview,
        }
      : undefined,
    latestOutbound: latestOutbound
      ? {
          emailId: latestOutbound.primaryEmailId,
          to: latestOutbound.to,
          date: latestOutbound.internalDate || latestOutbound.date,
          preview: latestOutbound.preview,
        }
      : undefined,
    attachments: messages.flatMap((message) =>
      message.attachments.map((attachment) => ({
        emailId: message.primaryEmailId,
        filename: attachment.filename,
        kind: attachment.kind,
        contentType: attachment.contentType,
      })),
    ),
  };
}

function readEnvValue(name: string): string | undefined {
  const direct = process.env[name]?.trim();
  if (direct) {
    return direct;
  }

  const command = process.env[`${name}_COMMAND`]?.trim();
  if (command) {
    return execFileSync("/bin/sh", ["-c", command], { encoding: "utf-8" }).trim();
  }

  const filePath = process.env[`${name}_FILE`]?.trim();
  if (!filePath) {
    return undefined;
  }

  return readFileSync(filePath, "utf8").trim();
}

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return defaultValue;
  }

  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }
  return defaultValue;
}

function parseIntegerEnv(
  name: string,
  defaultValue: number,
  min = 1,
  max = 10_000,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    return defaultValue;
  }

  return Math.min(max, Math.max(min, parsed));
}

function parseAllowedActionsEnv(name: string): EmailAction[] {
  const configured = parseListValues(process.env[name]);
  if (configured.length === 0) {
    return [...ALL_EMAIL_ACTIONS];
  }

  const allowed = configured.filter((value): value is EmailAction =>
    ALL_EMAIL_ACTIONS.includes(value as EmailAction),
  );

  if (allowed.length === 0) {
    throw new Error(`${name} contains no valid action names. Valid values: ${ALL_EMAIL_ACTIONS.join(", ")}`);
  }

  return allowed;
}

function isLocalBridgeHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function isMissingTargetFolderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /TRYCREATE|NONEXISTENT/i.test(message);
}

export function buildConfigFromEnv(): ProtonMailConfig {
  const username = readEnvValue("PROTONMAIL_USERNAME");
  const password = readEnvValue("PROTONMAIL_PASSWORD");

  if (!username || !password) {
    throw new Error(
      "Missing required environment variables or secret sources: PROTONMAIL_USERNAME and PROTONMAIL_PASSWORD.",
    );
  }

  const smtpPort = parseIntegerEnv("PROTONMAIL_SMTP_PORT", 1025, 1, 65_535);
  // Bridge's local SMTP port requires implicit TLS from the first byte (no
  // plaintext greeting, no STARTTLS) — confirmed against a live Bridge
  // instance. Overridable for non-Bridge SMTP setups.
  const smtpSecure = parseBooleanEnv("PROTONMAIL_SMTP_SECURE", true);
  const imapPort = parseIntegerEnv("PROTONMAIL_IMAP_PORT", 1143, 1, 65_535);
  const debug = parseBooleanEnv("DEBUG", false);
  const readOnly = parseBooleanEnv("PROTONMAIL_READ_ONLY", false);
  const allowSend = parseBooleanEnv("PROTONMAIL_ALLOW_SEND", !readOnly);
  const allowRemoteDraftSync = parseBooleanEnv(
    "PROTONMAIL_ALLOW_REMOTE_DRAFT_SYNC",
    !readOnly,
  );
  const autoSync = parseBooleanEnv("PROTONMAIL_AUTO_SYNC", true);
  const syncInterval = parseIntegerEnv("PROTONMAIL_SYNC_INTERVAL_MINUTES", 5, 1, 24 * 60);
  const idleWatchEnabled = parseBooleanEnv("PROTONMAIL_IDLE_WATCH", autoSync);
  const idleMaxSeconds = parseIntegerEnv("PROTONMAIL_IDLE_MAX_SECONDS", 30, 5, 300);
  const confirmDestructive = parseBooleanEnv("PROTONMAIL_CONFIRM_DESTRUCTIVE", false);
  const allowEmptyFolder = parseBooleanEnv("PROTONMAIL_ALLOW_EMPTY_FOLDER", false);
  const restrictOutboundToSelf = parseBooleanEnv("PROTONMAIL_RESTRICT_OUTBOUND_TO_SELF", false);
  const allowFileDownloadDir = process.env.PROTONMAIL_ALLOW_FILE_DOWNLOAD_DIR?.trim() || undefined;
  const imapUsername = process.env.PROTONMAIL_IMAP_USERNAME?.trim() || username;
  const imapPassword = process.env.PROTONMAIL_IMAP_PASSWORD?.trim() || password;
  const opDelayMs = parseIntegerEnv("PROTONMAIL_OP_DELAY_MS", 0, 0, 5000);
  const sendDelaySeconds = parseIntegerEnv("PROTONMAIL_SEND_DELAY_SECONDS", 0, 0, 300);
  const smtpHost = process.env.PROTONMAIL_SMTP_HOST || "127.0.0.1";
  const imapHost = process.env.PROTONMAIL_IMAP_HOST || "localhost";
  const imapSecure = parseBooleanEnv("PROTONMAIL_IMAP_SECURE", false);
  const dataDir = process.env.PROTONMAIL_DATA_DIR?.trim() || join(homedir(), ".proton-mail-bridge-client");

  if (dataDir && !isAbsolute(dataDir)) {
    throw new Error("PROTONMAIL_DATA_DIR must be absolute, got: " + dataDir);
  }

  logger.setDebugMode(debug);
  if (isLocalBridgeHost(smtpHost)) {
    logger.warn("TLS verification is disabled for local Bridge SMTP connections.", "MCPServer", { host: smtpHost });
  }
  if (isLocalBridgeHost(imapHost)) {
    logger.warn("TLS verification is disabled for local Bridge IMAP connections.", "MCPServer", { host: imapHost });
  }

  return {
    smtp: {
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      username,
      password,
    },
    imap: {
      host: imapHost,
      port: imapPort,
      secure: imapSecure,
      username: imapUsername,
      password: imapPassword,
    },
    dataDir,
    debug,
    cacheEnabled: true,
    analyticsEnabled: true,
    autoSync,
    syncInterval,
    runtime: {
      readOnly,
      allowSend,
      allowRemoteDraftSync,
      allowedActions: parseAllowedActionsEnv("PROTONMAIL_ALLOWED_ACTIONS"),
      startupSync: parseBooleanEnv("PROTONMAIL_STARTUP_SYNC", autoSync),
      // Comma-separated; Sent is included by default so pendingOn/digest/follow-up
      // candidates don't misreport threads that were already answered — IDLE still
      // only watches the first folder (see BackgroundSyncService.primaryIdleFolder).
      autoSyncFolder: process.env.PROTONMAIL_AUTO_SYNC_FOLDER?.trim() || "INBOX,Sent",
      autoSyncFull: parseBooleanEnv("PROTONMAIL_AUTO_SYNC_FULL", false),
      autoSyncLimitPerFolder: parseIntegerEnv("PROTONMAIL_AUTO_SYNC_LIMIT_PER_FOLDER", 100, 1, 500),
      idleWatchEnabled,
      idleMaxSeconds,
      confirmDestructive,
      allowEmptyFolder,
      restrictOutboundToSelf,
      allowFileDownloadDir,
      maxInlineBytes: parseIntegerEnv("PROTONMAIL_MAX_INLINE_BYTES", 40, 1, 10240),
      opDelayMs,
      sendDelaySeconds,
    },
  };
}

export function createServer(
  config: ProtonMailConfig,
  options: {
    startBackgroundSync?: boolean;
  } = {},
) {
  const smtpService = new SMTPService(config);
  const imapService = new SimpleIMAPService(config, logger, config.runtime.opDelayMs);
  const analyticsService = new AnalyticsService();
  const auditService = new AuditService(config);
  const localIndexService = new LocalIndexService(config, logger);
  const draftStore = new DraftStoreService(config, logger);
  const backgroundSyncService = new BackgroundSyncService(
    config,
    imapService,
    localIndexService,
    logger,
  );
  const deliveryQueueService = new DeliveryQueueService(config, smtpService, logger);
  const snoozeService = new SnoozeService(config, imapService, logger);
  const templateService = new TemplateService(config, logger);

  if (options.startBackgroundSync) {
    backgroundSyncService.start();
    void deliveryQueueService.start();
    snoozeService.start();
  }

  const server = new Server(
    {
      name: "proton-mail-bridge-client",
      version: PACKAGE_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tier = (process.env.PROTONMAIL_TOOL_TIER ?? "full").trim().toLowerCase();
    return { tools: tier === "core" ? [...TOOLS].filter((t) => CORE_TOOL_NAMES.has(t.name)) : [...TOOLS] };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const cursor = request.params?.cursor ? Number.parseInt(request.params.cursor, 10) : 0;
    const [drafts, threadsResult, messages] = await Promise.all([
      draftStore.listDrafts(false),
      localIndexService.getThreads({ limit: 25 }),
      localIndexService.listRecentMessages(25),
    ]);

    const resources = [
      ...drafts.map((draft) => ({
        uri: buildDraftResourceUri(draft.id),
        name: draft.id,
        title: draft.subject,
        description: `${draft.status} · updated ${draft.updatedAt}`,
        mimeType: "text/markdown",
      })),
      ...threadsResult.threads.map((thread) => ({
        uri: buildThreadResourceUri(thread.id),
        name: thread.id,
        title: thread.subject,
        description: `${thread.messageCount} message(s)`,
        mimeType: "text/markdown",
      })),
      ...messages.map((message) => ({
        uri: buildEmailResourceUri(message.primaryEmailId),
        name: message.primaryEmailId,
        title: message.subject,
        description: `${message.folder} · ${message.internalDate || message.date || "undated"}`,
        mimeType: "message/rfc822",
      })),
    ];

    const pageSize = 50;
    const nextCursor =
      cursor + pageSize < resources.length ? String(cursor + pageSize) : undefined;

    return {
      resources: resources.slice(cursor, cursor + pageSize),
      nextCursor,
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const target = parseResourceUri(request.params.uri);

    switch (target.kind) {
      case "email": {
        const detail = await imapService.getEmailById(target.emailId);
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: "text/markdown",
              text: formatEmailResource(detail),
            },
          ],
        };
      }
      case "thread": {
        const thread = await localIndexService.getThreadById(target.threadId);
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: "text/markdown",
              text: formatThreadResource({
                id: thread.id,
                subject: thread.subject,
                latestDate: thread.latestDate,
                normalizedLabels: thread.normalizedLabels,
                messages: thread.messages.map((message) => ({
                  id: message.primaryEmailId,
                  subject: message.subject,
                  from: message.from,
                  date: message.date,
                  internalDate: message.internalDate,
                  preview: message.preview,
                })),
              }),
            },
          ],
        };
      }
      case "draft": {
        const draft = await draftStore.getDraft(target.draftId);
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: "text/markdown",
              text: formatDraftResource(draft),
            },
          ],
        };
      }
      case "attachment": {
        const attachment = await imapService.getAttachmentContent(
          target.emailId,
          target.attachmentId,
          true,
        );
        const mimeType = attachment.attachment.contentType || "application/octet-stream";
        if (attachment.text && isTextLikeMimeType(mimeType)) {
          return {
            contents: [
              {
                uri: request.params.uri,
                mimeType,
                text: attachment.text,
              },
            ],
          };
        }

        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType,
              blob: attachment.base64 || "",
            },
          ],
        };
      }
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = asObject(request.params.arguments);
    logger.debug("Handling tool call", "MCPServer", { name, argKeys: Object.keys(args || {}) });

    try {
      switch (name) {
        case "send_email": {
          ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args.confirmed, false), `Send email to ${String(args.to ?? "?")} — "${String(args.subject ?? "?")}"`);
          ensureSendAllowed(config.runtime);
          const to = parseEmails(requireString(args, "to"));
          const cc = parseEmails(optionalString(args, "cc"));
          const bcc = parseEmails(optionalString(args, "bcc"));
          const subject = requireString(args, "subject");
          const markdownBodySend = optionalString(args, "markdownBody");
          const body = markdownBodySend ? markdownBodySend : requireString(args, "body");
          const isHtml = markdownBodySend ? false : normalizeBoolean(args.isHtml, false);
          const htmlBody = markdownBodySend ? renderMarkdown(markdownBodySend).html : undefined;
          const priority = optionalString(args, "priority");
          const replyTo = optionalString(args, "replyTo");
          const fromName = optionalString(args, "fromName");
          const sanitizeHtml = normalizeBoolean(args.sanitizeHtml, true);
          const attachments = optionalAttachmentList(args.attachments);

          ensureValidEmails(to, "to");
          ensureValidEmails(cc, "cc");
          ensureValidEmails(bcc, "bcc");
          if (replyTo && !isValidEmail(replyTo)) {
            throw new McpError(ErrorCode.InvalidParams, "replyTo must be a valid email address.");
          }

          // dryRun: preview without sending
          const dryRunSend = normalizeBoolean(args.dryRun, false);

          // RESTRICT_OUTBOUND_TO_SELF check
          if (config.runtime.restrictOutboundToSelf) {
            const selfAddr = config.smtp.username.toLowerCase();
            const allR = [...to, ...(cc ?? []), ...(bcc ?? [])];
            const ext = allR.filter(r => r.toLowerCase() !== selfAddr);
            if (ext.length > 0) {
              throw new McpError(ErrorCode.InvalidParams, `RESTRICT_OUTBOUND_TO_SELF is enabled. Cannot send to: ${ext.join(", ")}`);
            }
          }

          if (dryRunSend) {
            return createTextResult({ dryRun: true, wouldSendTo: { to, cc: cc ?? [], bcc: bcc ?? [] }, subject, note: "No email was sent." });
          }

          const emailPayload: SendEmailInput = {
            to,
            cc,
            bcc,
            subject,
            body,
            isHtml,
            htmlBody,
            fromName,
            sanitizeHtml,
            priority:
              priority === "high" || priority === "low" || priority === "normal"
                ? priority
                : "normal",
            replyTo,
            attachments,
            requestReadReceipt: normalizeBoolean(args.requestReadReceipt, false),
            appendSignature: normalizeBoolean(args.appendSignature, true),
          };

          // Undo-send: PROTONMAIL_SEND_DELAY_SECONDS > 0 queues instead of sending
          // immediately, cancelable via cancel_send until the window elapses.
          // undoWindowSeconds overrides the server default for this one send —
          // including forcing 0 (send immediately) when a default is configured.
          let undoWindowSeconds = config.runtime.sendDelaySeconds;
          if (args.undoWindowSeconds !== undefined) {
            const requested = Number(args.undoWindowSeconds);
            if (!Number.isInteger(requested) || requested < 0 || requested > 300) {
              throw new McpError(ErrorCode.InvalidParams, "undoWindowSeconds must be an integer between 0 and 300.");
            }
            undoWindowSeconds = requested;
          }
          if (undoWindowSeconds > 0) {
            const sendAt = new Date(Date.now() + undoWindowSeconds * 1000).toISOString();
            const queued = await withAudit(auditService, name, args, async () =>
              deliveryQueueService.enqueue(emailPayload, sendAt, "undo_send"),
            );
            return createTextResult({
              queued: true,
              id: queued.id,
              sendAt: queued.sendAt,
              note: `Not sent yet — will send in ~${undoWindowSeconds}s unless canceled with cancel_send. This server must stay running for the send to fire; if it's restarted before sendAt, the send fires on next startup instead.`,
            });
          }

          const result = await withAudit(auditService, name, args, async () =>
            smtpService.sendEmail(emailPayload),
          );

          let sentCopyTokenSend = "[sent-copy:unverified]";
          try {
            const verifyMsgId = result.messageId;
            if (verifyMsgId) {
              const scv = await verifySentCopy(imapService, verifyMsgId);
              if (scv.found) sentCopyTokenSend = "[sent-copy:verified]";
            }
          } catch (_) {}

          return createTextResult({
            messageId: result.messageId,
            accepted: result.accepted,
            rejected: result.rejected,
            response: result.response,
            sentCopy: sentCopyTokenSend,
          });
        }

        case "cancel_send": {
          const result = await withAudit(auditService, name, args, async () =>
            deliveryQueueService.cancel(requireString(args, "id")),
          );
          return createTextResult(result);
        }

        case "list_scheduled_sends": {
          const statusFilter = optionalString(args, "status");
          const all = await withAudit(auditService, name, args, async () => deliveryQueueService.list());
          const filtered = statusFilter ? all.filter((item) => item.status === statusFilter) : all;
          return createTextResult(filtered);
        }

        case "get_unsubscribe_info": {
          const detail = await imapService.getEmailById(requireString(args, "emailId"));
          const info = extractUnsubscribeInfo(detail);
          return createTextResult({
            emailId: detail.id,
            hasUnsubscribeHeader: Boolean(info.mailto || info.url),
            mailto: info.mailto,
            url: info.url,
            note: info.url
              ? "This server never auto-fetches unsubscribe URLs — open the url yourself, or use unsubscribe_sender if mailto is also set."
              : undefined,
          });
        }

        case "unsubscribe_sender": {
          const detail = await imapService.getEmailById(requireString(args, "emailId"));
          const info = extractUnsubscribeInfo(detail);
          if (!info.mailto) {
            if (info.url) {
              throw new McpError(
                ErrorCode.InvalidParams,
                `This message's List-Unsubscribe header only has an https link, not a mailto address — this server never auto-fetches unsubscribe URLs. Open it yourself: ${info.url}`,
              );
            }
            throw new McpError(ErrorCode.InvalidParams, "This message has no List-Unsubscribe header — nothing to unsubscribe from.");
          }

          ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args.confirmed, false), `Send unsubscribe email to ${info.mailto} for message "${detail.subject}"`);
          ensureSendAllowed(config.runtime);
          // info.mailto comes from an untrusted inbound header — subject to the
          // same outbound restriction as every other send path.
          ensureOutboundRecipientsAllowed(config.runtime, config.smtp.username, [info.mailto]);

          const result = await withAudit(auditService, name, args, () =>
            smtpService.sendEmail({
              to: [info.mailto as string],
              subject: "unsubscribe",
              body: "unsubscribe",
              isHtml: false,
            }),
          );

          return createTextResult({
            emailId: detail.id,
            unsubscribedVia: info.mailto,
            messageId: result.messageId,
            accepted: result.accepted,
            rejected: result.rejected,
          });
        }

        case "send_test_email": {
          ensureSendAllowed(config.runtime);
          const to = requireString(args, "to");
          if (!isValidEmail(to)) {
            throw new McpError(ErrorCode.InvalidParams, "to must be a valid email address.");
          }

          const result = await withAudit(auditService, name, args, async () =>
            smtpService.sendTestEmail(to, optionalString(args, "customMessage")),
          );
          return createTextResult({
            messageId: result.messageId,
            accepted: result.accepted,
            rejected: result.rejected,
            response: result.response,
          });
        }

        case "reply_to_email": {
          ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args.confirmed, false), `Reply to email ${String(args.emailId ?? "?")}`);
          ensureSendAllowed(config.runtime);
          const detail = await imapService.getEmailById(requireString(args, "emailId"));
          const markdownBodyReply = optionalString(args, "markdownBody");
          const body = markdownBodyReply ? markdownBodyReply : requireString(args, "body");
          const isHtml = markdownBodyReply ? false : normalizeBoolean(args.isHtml, false);
          const htmlBody = markdownBodyReply ? renderMarkdown(markdownBodyReply).html : undefined;
          const replyAll = normalizeBoolean(args.replyAll, false);
          const fromNameReply = optionalString(args, "fromName");
          const sanitizeHtmlReply = normalizeBoolean(args.sanitizeHtml, true);
          const attachments = optionalAttachmentList(args.attachments);
          const extraCc = parseEmails(optionalString(args, "cc"));
          const extraBcc = parseEmails(optionalString(args, "bcc"));
          const recipients = getReplyRecipients(detail, config.smtp.username, replyAll);
          const cc = uniqueAddresses([...recipients.cc, ...extraCc]);
          const to = uniqueAddresses(recipients.to);

          ensureValidEmails(to, "to");
          ensureValidEmails(cc, "cc");
          ensureValidEmails(extraBcc, "bcc");

          if (to.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "Unable to infer reply recipient.");
          }

          const dryRunReply = normalizeBoolean(args.dryRun, false);
          const includeQuoteReply = normalizeBoolean(args.includeQuote, true);
          // Signature goes right after the user's own reply text, before the
          // quoted original — not at the very end, after the quote.
          const signedReply = applySignature(body, htmlBody, normalizeBoolean(args.appendSignature, true));
          const replyBody = includeQuoteReply ? buildReplyText(detail, signedReply.body) : signedReply.body;

          if (config.runtime.restrictOutboundToSelf) {
            const selfAddr = config.smtp.username.toLowerCase();
            const allR = [...to, ...cc, ...extraBcc];
            const ext = allR.filter(r => r.toLowerCase() !== selfAddr);
            if (ext.length > 0) {
              throw new McpError(ErrorCode.InvalidParams, `RESTRICT_OUTBOUND_TO_SELF is enabled. Cannot send to: ${ext.join(", ")}`);
            }
          }

          if (dryRunReply) {
            return createTextResult({ dryRun: true, wouldSendTo: { to, cc, bcc: extraBcc }, subject: prefixedSubject(detail.subject, "Re:"), note: "No email was sent." }, false, [emailSource(detail)]);
          }

          const result = await withAudit(auditService, name, args, async () =>
            smtpService.sendEmail({
              to,
              cc,
              bcc: extraBcc,
              subject: prefixedSubject(detail.subject, "Re:"),
              body: replyBody,
              isHtml,
              htmlBody: signedReply.htmlBody,
              fromName: fromNameReply,
              sanitizeHtml: sanitizeHtmlReply,
              inReplyTo: detail.messageId,
              references: detail.messageId ? [detail.messageId] : undefined,
              attachments,
              // Already applied above, before quote-wrapping.
              appendSignature: false,
            }),
          );

          let sentCopyTokenReply = "[sent-copy:unverified]";
          try {
            const verifyMsgId = result.messageId;
            if (verifyMsgId) {
              const scv = await verifySentCopy(imapService, verifyMsgId);
              if (scv.found) sentCopyTokenReply = "[sent-copy:verified]";
            }
          } catch (_) {}

          return createTextResult({
            repliedTo: detail.id,
            to,
            cc,
            messageId: result.messageId,
            accepted: result.accepted,
            rejected: result.rejected,
            response: result.response,
            sentCopy: sentCopyTokenReply,
          }, false, [emailSource(detail)]);
        }

        case "reply_all_email": {
          ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args.confirmed, false), `Reply-all to email ${String(args.emailId ?? "?")}`);
          ensureSendAllowed(config.runtime);
          const detailRa = await imapService.getEmailById(requireString(args, "emailId"));
          const markdownBodyRa = optionalString(args, "markdownBody");
          const bodyRa = markdownBodyRa ? markdownBodyRa : requireString(args, "body");
          const isHtmlRa = markdownBodyRa ? false : normalizeBoolean(args.isHtml, false);
          const htmlBodyRa = markdownBodyRa ? renderMarkdown(markdownBodyRa).html : undefined;
          const fromNameRa = optionalString(args, "fromName");
          const sanitizeHtmlRa = normalizeBoolean(args.sanitizeHtml, true);
          const attachmentsRa = optionalAttachmentList(args.attachments);
          const extraCcRa = parseEmails(optionalString(args, "cc"));
          const extraBccRa = parseEmails(optionalString(args, "bcc"));
          const recipientsRa = getReplyRecipients(detailRa, config.smtp.username, true);
          const ccRa = uniqueAddresses([...recipientsRa.cc, ...extraCcRa]);
          const toRa = uniqueAddresses(recipientsRa.to);

          ensureValidEmails(toRa, "to");
          ensureValidEmails(ccRa, "cc");
          ensureValidEmails(extraBccRa, "bcc");

          if (toRa.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "Unable to infer reply recipients.");
          }

          const dryRunRa = normalizeBoolean(args.dryRun, false);
          if (config.runtime.restrictOutboundToSelf) {
            const selfAddr = config.smtp.username.toLowerCase();
            const allR = [...toRa, ...ccRa, ...extraBccRa];
            const ext = allR.filter(r => r.toLowerCase() !== selfAddr);
            if (ext.length > 0) {
              throw new McpError(ErrorCode.InvalidParams, `RESTRICT_OUTBOUND_TO_SELF is enabled. Cannot send to: ${ext.join(", ")}`);
            }
          }
          if (dryRunRa) {
            return createTextResult({ dryRun: true, wouldSendTo: { to: toRa, cc: ccRa, bcc: extraBccRa }, subject: prefixedSubject(detailRa.subject, "Re:"), note: "No email was sent." });
          }

          const includeQuoteRa = normalizeBoolean(args.includeQuote, true);
          // Signature goes right after the user's own reply text, before the
          // quoted original — not at the very end, after the quote.
          const signedReplyRa = applySignature(bodyRa, htmlBodyRa, normalizeBoolean(args.appendSignature, true));
          const replyBodyRa = includeQuoteRa ? buildReplyText(detailRa, signedReplyRa.body) : signedReplyRa.body;

          const resultRa = await withAudit(auditService, name, args, async () =>
            smtpService.sendEmail({
              to: toRa,
              cc: ccRa,
              bcc: extraBccRa,
              subject: prefixedSubject(detailRa.subject, "Re:"),
              body: replyBodyRa,
              isHtml: isHtmlRa,
              htmlBody: signedReplyRa.htmlBody,
              fromName: fromNameRa,
              sanitizeHtml: sanitizeHtmlRa,
              inReplyTo: detailRa.messageId,
              references: detailRa.messageId ? [detailRa.messageId] : undefined,
              attachments: attachmentsRa,
              // Already applied above, before quote-wrapping.
              appendSignature: false,
            }),
          );

          let sentCopyTokenRa = "[sent-copy:unverified]";
          try {
            const verifyMsgId = resultRa.messageId;
            if (verifyMsgId) {
              const scv = await verifySentCopy(imapService, verifyMsgId);
              if (scv.found) sentCopyTokenRa = "[sent-copy:verified]";
            }
          } catch (_) {}

          return createTextResult({
            repliedTo: detailRa.id,
            to: toRa,
            cc: ccRa,
            messageId: resultRa.messageId,
            accepted: resultRa.accepted,
            rejected: resultRa.rejected,
            response: resultRa.response,
            sentCopy: sentCopyTokenRa,
          }, false, [emailSource(detailRa)]);
        }

        case "forward_email": {
          ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args.confirmed, false), `Forward email ${String(args.emailId ?? "?")} to ${String(args.to ?? "?")}`);
          ensureSendAllowed(config.runtime);
          const detail = await imapService.getEmailById(requireString(args, "emailId"));
          const to = parseEmails(requireString(args, "to"));
          const cc = parseEmails(optionalString(args, "cc"));
          const bcc = parseEmails(optionalString(args, "bcc"));
          const markdownBodyFwd = optionalString(args, "markdownBody");
          const body = markdownBodyFwd ?? optionalString(args, "body");
          const isHtml = markdownBodyFwd ? false : normalizeBoolean(args.isHtml, false);
          const htmlBody = markdownBodyFwd ? renderMarkdown(markdownBodyFwd).html : undefined;
          const fromNameFwd = optionalString(args, "fromName");
          const sanitizeHtmlFwd = normalizeBoolean(args.sanitizeHtml, true);
          // args.attachments are new attachments the caller wants to add to the
          // forward — they are NOT the original message's attachments. Despite
          // the tool's own description ("preserving original attachments") and
          // includeAttachments defaulting to true, nothing here ever fetched the
          // original attachments themselves, so every forward silently dropped
          // them unless the caller had already fetched and resupplied their
          // content manually. attachmentParts was accepted in the schema and
          // documented but never read at all. Found live: forwarding a fixture
          // with one attachment produced a forward with zero attachments.
          const attachments = optionalAttachmentList(args.attachments) ?? [];
          const includeAttachments = normalizeBoolean(args.includeAttachments, true);
          const attachmentParts = Array.isArray(args.attachmentParts)
            ? (args.attachmentParts as unknown[]).map(String)
            : undefined;

          ensureValidEmails(to, "to");
          ensureValidEmails(cc, "cc");
          ensureValidEmails(bcc, "bcc");

          const dryRunFwd = normalizeBoolean(args.dryRun, false);
          if (config.runtime.restrictOutboundToSelf) {
            const selfAddr = config.smtp.username.toLowerCase();
            const allR = [...to, ...cc, ...bcc];
            const ext = allR.filter(r => r.toLowerCase() !== selfAddr);
            if (ext.length > 0) {
              throw new McpError(ErrorCode.InvalidParams, `RESTRICT_OUTBOUND_TO_SELF is enabled. Cannot send to: ${ext.join(", ")}`);
            }
          }
          if (dryRunFwd) {
            return createTextResult({ dryRun: true, wouldSendTo: { to, cc, bcc }, subject: prefixedSubject(detail.subject, "Fwd:"), note: "No email was sent." });
          }

          // args.attachments are new attachments the caller wants to add to the
          // forward — they are NOT the original message's attachments. Despite
          // the tool's own description ("preserving original attachments") and
          // includeAttachments defaulting to true, nothing here ever fetched the
          // original attachments themselves, so every forward silently dropped
          // them unless the caller had already fetched and resupplied their
          // content manually. attachmentParts was accepted in the schema and
          // documented but never read at all. Found live: forwarding a fixture
          // with one attachment produced a forward with zero attachments.
          const originalAttachments = includeAttachments
            ? await Promise.all(
                detail.attachments
                  .filter((a) => a.id && (!attachmentParts || (a.part !== undefined && attachmentParts.includes(a.part))))
                  .map((a) => imapService.getAttachmentForForward(detail.id, a.id as string)),
              )
            : [];
          const fwdAttachments = [...originalAttachments, ...attachments];

          // Signature goes right after the user's own note, before the
          // "---------- Forwarded message ---------" block — not at the very
          // end, after the forwarded content.
          const signedFwd = applySignature(body ?? "", htmlBody, normalizeBoolean(args.appendSignature, true));

          const result = await withAudit(auditService, name, args, async () =>
            smtpService.sendEmail({
              to,
              cc,
              bcc,
              subject: prefixedSubject(detail.subject, "Fwd:"),
              body: buildForwardText(detail, signedFwd.body),
              isHtml,
              htmlBody: signedFwd.htmlBody,
              fromName: fromNameFwd,
              sanitizeHtml: sanitizeHtmlFwd,
              attachments: fwdAttachments,
              // Already applied above, before quote-wrapping.
              appendSignature: false,
            }),
          );

          let sentCopyTokenFwd = "[sent-copy:unverified]";
          try {
            const verifyMsgId = result.messageId;
            if (verifyMsgId) {
              const scv = await verifySentCopy(imapService, verifyMsgId);
              if (scv.found) sentCopyTokenFwd = "[sent-copy:verified]";
            }
          } catch (_) {}

          return createTextResult({
            forwardedMessage: detail.id,
            to,
            cc,
            messageId: result.messageId,
            accepted: result.accepted,
            rejected: result.rejected,
            response: result.response,
            sentCopy: sentCopyTokenFwd,
          }, false, [emailSource(detail)]);
        }

        case "create_draft": {
          const to = parseEmails(optionalString(args, "to"));
          const cc = parseEmails(optionalString(args, "cc"));
          const bcc = parseEmails(optionalString(args, "bcc"));
          const subject = requireString(args, "subject");
          const body = requireString(args, "body");
          const replyTo = optionalString(args, "replyTo");
          const attachments = optionalAttachmentList(args.attachments);
          const priority = optionalString(args, "priority");

          ensureValidEmails(to, "to");
          ensureValidEmails(cc, "cc");
          ensureValidEmails(bcc, "bcc");
          if (replyTo && !isValidEmail(replyTo)) {
            throw new McpError(ErrorCode.InvalidParams, "replyTo must be a valid email address.");
          }

          const result = await withAudit(auditService, name, args, async () => {
            const draft = await draftStore.createDraft({
              mode: "compose",
              to,
              cc,
              bcc,
              subject,
              body,
              isHtml: normalizeBoolean(args.isHtml, false),
              priority:
                priority === "high" || priority === "low" || priority === "normal"
                  ? priority
                  : undefined,
              replyTo,
              notes: optionalString(args, "notes"),
              attachments,
            });

            const remoteSyncDecision = resolveRemoteDraftSync(
              config.runtime,
              normalizeBoolean(args.syncToRemote, true),
            );
            const synced = remoteSyncDecision.enabled
              ? await syncDraftToRemote(draftStore, smtpService, imapService, draft)
              : { draft, remoteSync: undefined };
            const remoteSync =
              synced.remoteSync ??
              (remoteSyncDecision.reason
                ? {
                    ok: false,
                    skipped: true,
                    message: remoteSyncDecision.reason,
                  }
                : undefined);

            return remoteSync ? { ...synced.draft, remoteSync } : synced.draft;
          });

          return createTextResult(
            result,
            false,
            [
              draftSource(result),
              ...(result.remoteDraft?.emailId
                ? [
                    emailSource({
                      id: result.remoteDraft.emailId,
                      subject: result.subject,
                      folder: result.remoteDraft.folder,
                    })
                  ]
                : []),
            ],
          );
        }

        case "create_reply_draft": {
          const detail = await imapService.getEmailById(requireString(args, "emailId"));
          const body = requireString(args, "body");
          const isHtml = normalizeBoolean(args.isHtml, false);
          const replyAll = normalizeBoolean(args.replyAll, false);
          const attachments = optionalAttachmentList(args.attachments);
          const extraCc = parseEmails(optionalString(args, "cc"));
          const extraBcc = parseEmails(optionalString(args, "bcc"));
          const recipients = getReplyRecipients(detail, config.smtp.username, replyAll);
          const cc = uniqueAddresses([...recipients.cc, ...extraCc]);
          const to = uniqueAddresses(recipients.to);

          ensureValidEmails(to, "to");
          ensureValidEmails(cc, "cc");
          ensureValidEmails(extraBcc, "bcc");

          if (to.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "Unable to infer reply recipient.");
          }

          const result = await withAudit(auditService, name, args, async () => {
            const draft = await draftStore.createDraft({
              mode: "reply",
              to,
              cc,
              bcc: extraBcc,
              subject: prefixedSubject(detail.subject, "Re:"),
              body: buildReplyText(detail, body),
              isHtml,
              inReplyTo: detail.messageId,
              references: detail.messageId ? [detail.messageId] : undefined,
              attachments,
              sourceEmailId: detail.id,
              sourceMessageId: detail.messageId,
              notes: optionalString(args, "notes"),
            });

            const remoteSyncDecision = resolveRemoteDraftSync(
              config.runtime,
              normalizeBoolean(args.syncToRemote, true),
            );
            const synced = remoteSyncDecision.enabled
              ? await syncDraftToRemote(draftStore, smtpService, imapService, draft)
              : { draft, remoteSync: undefined };
            const remoteSync =
              synced.remoteSync ??
              (remoteSyncDecision.reason
                ? {
                    ok: false,
                    skipped: true,
                    message: remoteSyncDecision.reason,
                  }
                : undefined);

            return remoteSync ? { ...synced.draft, remoteSync } : synced.draft;
          });

          return createTextResult(
            result,
            false,
            [
              draftSource(result),
              emailSource(detail),
              ...(result.remoteDraft?.emailId
                ? [
                    emailSource({
                      id: result.remoteDraft.emailId,
                      subject: result.subject,
                      folder: result.remoteDraft.folder,
                    })
                  ]
                : []),
            ],
          );
        }

        case "create_forward_draft": {
          const detail = await imapService.getEmailById(requireString(args, "emailId"));
          const to = parseEmails(requireString(args, "to"));
          const cc = parseEmails(optionalString(args, "cc"));
          const bcc = parseEmails(optionalString(args, "bcc"));
          const callerAttachments = optionalAttachmentList(args.attachments) ?? [];

          ensureValidEmails(to, "to");
          ensureValidEmails(cc, "cc");
          ensureValidEmails(bcc, "bcc");

          // Same bug fixed earlier this session in forward_email: only the
          // caller-supplied `attachments` (new attachments to add) were ever
          // used — the original email's own attachments were never fetched,
          // regardless of the tool's "preserving attachments" description.
          // Found live: forwarding a fixture with one attachment produced a
          // draft with zero attachments.
          const includeAttachments = normalizeBoolean(args.includeAttachments, true);
          const originalAttachments = includeAttachments
            ? await Promise.all(
                detail.attachments
                  .filter((a) => a.id)
                  .map((a) => imapService.getAttachmentForForward(detail.id, a.id as string)),
              )
            : [];
          const attachments = [...originalAttachments, ...callerAttachments];

          const result = await withAudit(auditService, name, args, async () => {
            const draft = await draftStore.createDraft({
              mode: "forward",
              to,
              cc,
              bcc,
              subject: prefixedSubject(detail.subject, "Fwd:"),
              body: buildForwardText(detail, optionalString(args, "body")),
              isHtml: normalizeBoolean(args.isHtml, false),
              attachments,
              sourceEmailId: detail.id,
              sourceMessageId: detail.messageId,
              notes: optionalString(args, "notes"),
            });

            const remoteSyncDecision = resolveRemoteDraftSync(
              config.runtime,
              normalizeBoolean(args.syncToRemote, true),
            );
            const synced = remoteSyncDecision.enabled
              ? await syncDraftToRemote(draftStore, smtpService, imapService, draft)
              : { draft, remoteSync: undefined };
            const remoteSync =
              synced.remoteSync ??
              (remoteSyncDecision.reason
                ? {
                    ok: false,
                    skipped: true,
                    message: remoteSyncDecision.reason,
                  }
                : undefined);

            return remoteSync ? { ...synced.draft, remoteSync } : synced.draft;
          });

          return createTextResult(
            result,
            false,
            [
              draftSource(result),
              emailSource(detail),
              ...(result.remoteDraft?.emailId
                ? [
                    emailSource({
                      id: result.remoteDraft.emailId,
                      subject: result.subject,
                      folder: result.remoteDraft.folder,
                    })
                  ]
                : []),
            ],
          );
        }

        case "list_drafts": {
          const drafts = await draftStore.listDrafts(normalizeBoolean(args.includeSent, false));
          return createTextResult(
            {
              total: drafts.length,
              drafts,
            },
            false,
            drafts.map(draftSource),
          );
        }

        case "list_remote_drafts": {
          const result = await imapService.listRemoteDrafts(
            normalizeLimit(args.limit, 50),
            normalizeLimit(args.offset, 0, 0, 10_000),
          );
          return createTextResult(result, false, result.emails.map(emailSource));
        }

        case "get_draft": {
          const draft = await draftStore.getDraft(requireString(args, "draftId"));
          return createTextResult(
            draft,
            false,
            [
              draftSource(draft),
              ...(draft.remoteDraft?.emailId
                ? [
                    emailSource({
                      id: draft.remoteDraft.emailId,
                      subject: draft.subject,
                      folder: draft.remoteDraft.folder,
                    })
                  ]
                : []),
            ],
          );
        }

        case "update_draft": {
          const draftId = requireString(args, "draftId");
          const to = args.to === undefined ? undefined : parseEmails(optionalString(args, "to"));
          const cc = args.cc === undefined ? undefined : parseEmails(optionalString(args, "cc"));
          const bcc = args.bcc === undefined ? undefined : parseEmails(optionalString(args, "bcc"));
          const replyTo = optionalString(args, "replyTo");
          const priority = optionalString(args, "priority");
          const attachments = args.attachments === undefined ? undefined : optionalAttachmentList(args.attachments);

          if (to) {
            ensureValidEmails(to, "to");
          }
          if (cc) {
            ensureValidEmails(cc, "cc");
          }
          if (bcc) {
            ensureValidEmails(bcc, "bcc");
          }
          if (replyTo && !isValidEmail(replyTo)) {
            throw new McpError(ErrorCode.InvalidParams, "replyTo must be a valid email address.");
          }

          const result = await withAudit(auditService, name, args, async () => {
            const draft = await draftStore.updateDraft(draftId, {
              to,
              cc,
              bcc,
              subject: optionalString(args, "subject"),
              body: optionalString(args, "body"),
              isHtml: typeof args.isHtml === "boolean" ? args.isHtml : undefined,
              priority:
                priority === "high" || priority === "low" || priority === "normal"
                  ? priority
                  : undefined,
              replyTo,
              attachments,
              notes: optionalString(args, "notes"),
            });

            const remoteSyncDecision = resolveRemoteDraftSync(
              config.runtime,
              normalizeBoolean(args.syncToRemote, true),
            );
            const synced = remoteSyncDecision.enabled
              ? await syncDraftToRemote(draftStore, smtpService, imapService, draft)
              : { draft, remoteSync: undefined };
            const remoteSync =
              synced.remoteSync ??
              (remoteSyncDecision.reason
                ? {
                    ok: false,
                    skipped: true,
                    message: remoteSyncDecision.reason,
                  }
                : undefined);

            return remoteSync ? { ...synced.draft, remoteSync } : synced.draft;
          });

          return createTextResult(
            result,
            false,
            [
              draftSource(result),
              ...(result.remoteDraft?.emailId
                ? [
                    emailSource({
                      id: result.remoteDraft.emailId,
                      subject: result.subject,
                      folder: result.remoteDraft.folder,
                    })
                  ]
                : []),
            ],
          );
        }

        case "sync_draft_to_remote": {
          ensureRemoteDraftSyncAllowed(config.runtime);
          const draft = await draftStore.getDraft(requireString(args, "draftId"));
          const synced = await withAudit(auditService, name, args, async () =>
            syncDraftToRemote(draftStore, smtpService, imapService, draft),
          );
          return createTextResult(
            { ...synced.draft, remoteSync: synced.remoteSync },
            false,
            [
              draftSource(synced.draft),
              ...(synced.draft.remoteDraft?.emailId
                ? [
                    emailSource({
                      id: synced.draft.remoteDraft.emailId,
                      subject: synced.draft.subject,
                      folder: synced.draft.remoteDraft.folder,
                    })
                  ]
                : []),
            ],
          );
        }

        case "send_draft": {
          ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args.confirmed, false), `Send draft ${String(args.draftId ?? "?")}`);
          ensureSendAllowed(config.runtime);
          const draft = await draftStore.getDraft(requireString(args, "draftId"));
          // Found live: calling send_draft twice on the same draft sent it
          // twice — nothing here checked whether it was already marked
          // "sent" before sending again. Refuse; create_draft for a new
          // message instead.
          if (draft.status === "sent") {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Draft ${draft.id} was already sent (at ${draft.sentAt ?? "an earlier time"}) — sending it again would deliver it twice. Use create_draft to compose a new message instead.`,
            );
          }
          // Found live: schedule_draft followed by send_draft on the same
          // draft sent it twice — two independent, successful SMTP
          // transactions, since nothing here knew about the still-pending
          // scheduled send. Refuse instead; cancel_send first if the
          // immediate send is actually what's wanted.
          const pendingScheduled = (await deliveryQueueService.list()).find(
            (record) => record.sourceDraftId === draft.id && record.status === "pending",
          );
          if (pendingScheduled) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `This draft already has a pending scheduled send (id ${pendingScheduled.id}, sendAt ${pendingScheduled.sendAt}). Sending now would deliver it twice. Cancel that scheduled send with cancel_send first, or wait for it to fire.`,
            );
          }
          ensureValidEmails(draft.to, "to");
          ensureValidEmails(draft.cc, "cc");
          ensureValidEmails(draft.bcc, "bcc");
          if (draft.replyTo && !isValidEmail(draft.replyTo)) {
            throw new McpError(ErrorCode.InvalidParams, "replyTo must be a valid email address.");
          }
          if (config.runtime.restrictOutboundToSelf) {
            const allRecipients = [...draft.to, ...draft.cc, ...draft.bcc];
            // Found live: with PROTONMAIL_IMAP_USERNAME set to a different
            // address than the account's send identity, this compared
            // recipients against the IMAP login instead — rejecting mail to
            // the real self as "external" (and, the other way round, would
            // let mail to that IMAP-only address through as if it were
            // self). Every other RESTRICT_OUTBOUND_TO_SELF check in this
            // file already uses smtp.username, since that's the identity
            // mail actually sends as; this was the one inconsistent copy.
            const selfAddr = config.smtp.username.toLowerCase();
            const external = allRecipients.filter(r => r.toLowerCase() !== selfAddr);
            if (external.length > 0) throw new McpError(ErrorCode.InvalidParams, "PROTONMAIL_RESTRICT_OUTBOUND_TO_SELF is enabled. All recipients must be the authenticated user.");
          }

          if (normalizeBoolean(args.dryRun, false)) {
            return createTextResult({
              dryRun: true,
              wouldSendTo: { to: draft.to, cc: draft.cc, bcc: draft.bcc },
              subject: draft.subject,
              body: draft.body,
              isHtml: draft.isHtml,
              note: "No email was sent.",
            }, false, [draftSource(draft)]);
          }

          const result = await withAudit(auditService, name, args, async () =>
            smtpService.sendEmail({
              to: draft.to,
              cc: draft.cc,
              bcc: draft.bcc,
              subject: draft.subject,
              body: draft.body,
              isHtml: draft.isHtml,
              priority: draft.priority,
              replyTo: draft.replyTo,
              inReplyTo: draft.inReplyTo,
              references: draft.references,
              attachments: draft.attachments,
              // Draft content is already finalized and reviewed — appending a
              // signature invisibly at send time would change what the user
              // saw and approved. If a signature is wanted, it belongs in the
              // draft body itself.
              appendSignature: false,
            }),
          );

          let sentDraft = await draftStore.markSent(draft.id, {
            messageId: result.messageId,
            accepted: result.accepted,
            rejected: result.rejected,
            response: result.response,
          });
          const remoteCleanup = resolveRemoteDraftSync(config.runtime, true).enabled
            ? await clearRemoteDraft(draftStore, imapService, sentDraft)
            : {
                draft: sentDraft,
                remoteDelete: sentDraft.remoteDraft?.emailId
                  ? {
                      ok: false,
                      skipped: true,
                      message: "Remote draft cleanup skipped by runtime policy.",
                    }
                  : undefined,
              };
          sentDraft = remoteCleanup.draft;

          const sources = [draftSource(sentDraft)];
          if (sentDraft.sourceEmailId) {
            sources.push(emailSource(await imapService.getEmailById(sentDraft.sourceEmailId)));
          }

          let sentCopyTokenDraft = "[sent-copy:unverified]";
          try {
            const verifyMsgId = result.messageId;
            if (verifyMsgId) {
              const scv = await verifySentCopy(imapService, verifyMsgId);
              if (scv.found) sentCopyTokenDraft = "[sent-copy:verified]";
            }
          } catch (_) {}

          return createTextResult(
            {
              draftId: sentDraft.id,
              status: sentDraft.status,
              messageId: result.messageId,
              accepted: result.accepted,
              rejected: result.rejected,
              response: result.response,
              remoteDelete: remoteCleanup.remoteDelete,
              sentCopy: sentCopyTokenDraft,
            },
            false,
            sources,
          );
        }

        case "schedule_draft": {
          ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args.confirmed, false), `Schedule draft ${String(args.draftId ?? "?")} to send later`);
          ensureSendAllowed(config.runtime);
          const draft = await draftStore.getDraft(requireString(args, "draftId"));
          // Mirrors send_draft's own pendingScheduled guard, for the reverse
          // ordering: send_draft already delivered this draft once, and
          // scheduling it again here would deliver it a second time at
          // sendAt. Found live: send_draft then schedule_draft on the same
          // (already-sent) draft queued a second, independent delivery.
          if (draft.status === "sent") {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Draft ${draft.id} was already sent — scheduling it again would deliver it twice. Use create_draft to compose a new message instead.`,
            );
          }
          const sendAt = requireString(args, "sendAt");
          const sendAtTime = new Date(sendAt).getTime();
          if (Number.isNaN(sendAtTime)) {
            throw new McpError(ErrorCode.InvalidParams, `sendAt is not a valid ISO 8601 timestamp: ${sendAt}`);
          }
          if (sendAtTime <= Date.now()) {
            throw new McpError(ErrorCode.InvalidParams, "sendAt must be in the future. Use send_draft to send immediately.");
          }
          ensureValidEmails(draft.to, "to");
          ensureValidEmails(draft.cc, "cc");
          ensureValidEmails(draft.bcc, "bcc");
          if (draft.replyTo && !isValidEmail(draft.replyTo)) {
            throw new McpError(ErrorCode.InvalidParams, "replyTo must be a valid email address.");
          }
          if (config.runtime.restrictOutboundToSelf) {
            const allRecipients = [...draft.to, ...draft.cc, ...draft.bcc];
            // Same fix as send_draft's identical check — see its comment.
            const selfAddr = config.smtp.username.toLowerCase();
            const external = allRecipients.filter((r) => r.toLowerCase() !== selfAddr);
            if (external.length > 0) throw new McpError(ErrorCode.InvalidParams, "PROTONMAIL_RESTRICT_OUTBOUND_TO_SELF is enabled. All recipients must be the authenticated user.");
          }

          const queued = await withAudit(auditService, name, args, async () =>
            deliveryQueueService.enqueue(
              {
                to: draft.to,
                cc: draft.cc,
                bcc: draft.bcc,
                subject: draft.subject,
                body: draft.body,
                isHtml: draft.isHtml,
                priority: draft.priority,
                replyTo: draft.replyTo,
                inReplyTo: draft.inReplyTo,
                references: draft.references,
                attachments: draft.attachments,
                // Draft content is already finalized and reviewed — see the
                // identical note on send_draft.
                appendSignature: false,
              },
              new Date(sendAtTime).toISOString(),
              "scheduled_send",
              draft.id,
            ),
          );

          return createTextResult({
            queued: true,
            id: queued.id,
            draftId: draft.id,
            sendAt: queued.sendAt,
            note: "The draft's content was snapshotted now and queued. This server must stay running for the send to fire at sendAt — if restarted first, it fires on next startup instead. The draft record itself is not automatically marked sent; use cancel_send with this id to abort before it fires.",
          });
        }

        case "delete_draft": {
          const draft = await draftStore.getDraft(requireString(args, "draftId"));
          const deleted = await withAudit(auditService, name, args, async () => {
            const remoteCleanup = resolveRemoteDraftSync(config.runtime, true).enabled
              ? await clearRemoteDraft(draftStore, imapService, draft)
              : {
                  draft,
                  remoteDelete: draft.remoteDraft?.emailId
                    ? {
                        ok: false,
                        skipped: true,
                        message: "Remote draft cleanup skipped by runtime policy.",
                      }
                    : undefined,
                };
            return {
              ...(await draftStore.deleteDraft(draft.id)),
              remoteDelete: remoteCleanup.remoteDelete,
            };
          });
          return createTextResult(deleted);
        }

        case "get_emails": {
          const effectiveLimit = normalizeLimit(args.limit, 50);
          const result = await imapService.getEmails({
            folder: optionalString(args, "folder"),
            limit: effectiveLimit,
            offset: typeof args.offset === "number" ? args.offset : undefined,
            beforeUid: typeof args?.beforeUid === "number" ? args.beforeUid : undefined,
            sortByUid: args?.sortByUid === "asc" || args?.sortByUid === "desc" ? args.sortByUid : undefined,
            includeSnippet: normalizeBoolean(args.includeSnippet, false),
          });
          return createTextResult(
            {
              ...result,
              emails: projectFields(result.emails, parseFieldsArg(args.fields)),
              returned: result.emails.length,
              hasMore: result.emails.length === effectiveLimit,
            },
            false,
            result.emails.map(emailSource),
          );
        }

        case "get_email_by_id": {
          const detail = await imapService.getEmailById(requireString(args, "emailId"));
          const preferHtml = normalizeBoolean(args.preferHtml, false);
          const maxBodyLength = normalizeLimit(args.maxBodyLength, undefined as unknown as number, 1, 500_000);
          const showHeaders = normalizeBoolean(args.showHeaders, false);

          const output = formatEmailDetailOutput(detail, preferHtml, maxBodyLength);
          // formatEmailDetailOutput always strips the full raw header map (needless
          // token bloat by default) — re-add it only when explicitly requested.
          // showHeaders already existed but previously only added a 2-field duplicate
          // on top without ever removing the always-present full map.
          if (showHeaders) output.headers = detail.headers;

          return createTextResult(output, false, [emailSource(detail), ...detail.attachments.map((attachment) => attachmentSource(detail.id, attachment))]);
        }

        case "get_emails_by_ids": {
          const emailIds = [...new Set(parseStringListArg(args, "emailIds"))];
          if (emailIds.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "emailIds must contain at least one email id.");
          }
          if (emailIds.length > 25) {
            throw new McpError(ErrorCode.InvalidParams, `get_emails_by_ids: maximum 25 email IDs per call, got ${emailIds.length}. Split into multiple calls.`);
          }
          const preferHtml = normalizeBoolean(args.preferHtml, false);
          const maxBodyLength = normalizeLimit(args.maxBodyLength, undefined as unknown as number, 1, 500_000);

          const results = await Promise.all(
            emailIds.map(async (emailId) => {
              try {
                const detail = await imapService.getEmailById(emailId);
                return { emailId, ok: true as const, email: formatEmailDetailOutput(detail, preferHtml, maxBodyLength) };
              } catch (error) {
                return { emailId, ok: false as const, error: error instanceof Error ? error.message : String(error) };
              }
            }),
          );

          const sources = results.flatMap((entry) =>
            entry.ok ? [emailSource(entry.email as unknown as Parameters<typeof emailSource>[0])] : [],
          );
          return createTextResult(
            { requested: emailIds.length, succeeded: results.filter((entry) => entry.ok).length, results },
            false,
            sources,
          );
        }

        case "search_emails": {
          const effectiveLimit = normalizeLimit(args.limit, 100);
          try {
            const result = await imapService.searchEmails({
              query: optionalString(args, "query"),
              folder: optionalString(args, "folder"),
              label: optionalString(args, "label"),
              threadId: optionalString(args, "threadId"),
              from: optionalString(args, "from"),
              to: optionalString(args, "to"),
              senderDomain: optionalString(args, "senderDomain"),
              mailboxRole: optionalString(args, "mailboxRole"),
              messageId: optionalString(args, "messageId"),
              cc: optionalString(args, "cc"),
              bcc: optionalString(args, "bcc"),
              subject: optionalString(args, "subject"),
              hasAttachment:
                typeof args.hasAttachment === "boolean" ? args.hasAttachment : undefined,
              attachmentName: optionalString(args, "attachmentName"),
              isRead: typeof args.isRead === "boolean" ? args.isRead : undefined,
              isStarred: typeof args.isStarred === "boolean" ? args.isStarred : undefined,
              dateFrom: optionalString(args, "dateFrom"),
              dateTo: optionalString(args, "dateTo"),
              sizeLarger: typeof args.sizeLarger === "number" ? args.sizeLarger : undefined,
              sizeSmaller: typeof args.sizeSmaller === "number" ? args.sizeSmaller : undefined,
              listId: optionalString(args, "listId"),
              limit: effectiveLimit,
              includeSnippet: normalizeBoolean(args.includeSnippet, false),
            });
            return createTextResult(
              {
                ...result,
                emails: projectFields(result.emails, parseFieldsArg(args.fields)),
                returned: result.emails.length,
                hasMore: result.emails.length === effectiveLimit,
              },
              false,
              result.emails.map(emailSource),
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("Invalid date")) {
              throw new McpError(ErrorCode.InvalidParams, message);
            }
            throw error;
          }
        }

        case "update_message_labels": {
          ensureMailboxWriteAllowed(config.runtime);
          const emailId = requireString(args, "emailId");
          const labelsToAdd = Array.isArray(args.labelsToAdd)
            ? (args.labelsToAdd as unknown[]).map(String)
            : [];
          const labelsToRemove = Array.isArray(args.labelsToRemove)
            ? (args.labelsToRemove as unknown[]).map(String)
            : [];
          if (labelsToAdd.length === 0 && labelsToRemove.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "Provide at least one label in labelsToAdd or labelsToRemove.");
          }
          const result = await withAudit(auditService, name, args, async () =>
            imapService.updateMessageLabels(emailId, labelsToAdd, labelsToRemove),
          );
          return createTextResult(result, false, [emailSource({ id: emailId } as Parameters<typeof emailSource>[0])]);
        }

        case "update_message_flags": {
          ensureMailboxWriteAllowed(config.runtime);
          const emailId = requireString(args, "emailId");
          const flagsToAdd = Array.isArray(args.flagsToAdd)
            ? (args.flagsToAdd as unknown[]).map(String)
            : [];
          const flagsToRemove = Array.isArray(args.flagsToRemove)
            ? (args.flagsToRemove as unknown[]).map(String)
            : [];
          if (flagsToAdd.length === 0 && flagsToRemove.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "Provide at least one flag in flagsToAdd or flagsToRemove.");
          }
          const result = await withAudit(auditService, name, args, async () =>
            imapService.updateMessageFlags(emailId, flagsToAdd, flagsToRemove),
          );
          return createTextResult(result, false, [emailSource({ id: emailId } as Parameters<typeof emailSource>[0])]);
        }

        case "count_messages": {
          const result = await imapService.countMessages({
            folder: optionalString(args, "folder"),
            query: optionalString(args, "query"),
            from: optionalString(args, "from"),
            to: optionalString(args, "to"),
            subject: optionalString(args, "subject"),
            hasAttachment:
              typeof args.hasAttachment === "boolean" ? args.hasAttachment : undefined,
            label: optionalString(args, "label"),
            threadId: optionalString(args, "threadId"),
            senderDomain: optionalString(args, "senderDomain"),
            isRead: typeof args.isRead === "boolean" ? args.isRead : undefined,
            isStarred: typeof args.isStarred === "boolean" ? args.isStarred : undefined,
            dateFrom: optionalString(args, "dateFrom"),
            dateTo: optionalString(args, "dateTo"),
            sizeLarger: typeof args.sizeLarger === "number" ? args.sizeLarger : undefined,
            sizeSmaller: typeof args.sizeSmaller === "number" ? args.sizeSmaller : undefined,
          });
          return createTextResult(result);
        }

        case "folder_stats": {
          const result = await imapService.getFolderStats(
            optionalString(args, "folder"),
            typeof args.scanLimit === "number" ? args.scanLimit : undefined,
          );
          return createTextResult(result);
        }

        case "empty_folder": {
          if (!config.runtime.allowEmptyFolder) {
            throw new McpError(
              ErrorCode.InvalidParams,
              "empty_folder is disabled. Set PROTONMAIL_ALLOW_EMPTY_FOLDER=true to enable.",
            );
          }
          ensureMailboxWriteAllowed(config.runtime);
          const folder = requireString(args, "folder");
          const confirmed = normalizeBoolean(args.confirmed, false);
          if (!confirmed) {
            ensureDestructiveConfirmed(config.runtime, confirmed, "Delete all messages in folder " + folder);
            const stats = await imapService.getFolderStats(folder);
            return createTextResult({
              preview: true,
              folder,
              wouldDelete: stats.total,
              message: `This would permanently delete ${stats.total} messages from "${folder}". Call again with confirmed:true to execute.`,
            });
          }
          ensureDestructiveConfirmed(config.runtime, confirmed, "Delete all messages in folder " + folder);
          const result = await withAudit(auditService, name, args, async () =>
            imapService.emptyFolder(folder),
          );
          return createTextResult(result);
        }

        case "bulk_move": {
          ensureMailboxWriteAllowed(config.runtime);
          const emailIds = Array.isArray(args.emailIds)
            ? (args.emailIds as unknown[]).map(String) : undefined;
          const match = args.match && typeof args.match === "object"
            ? (args.match as BulkMatchCriteria) : undefined;
          if (emailIds && emailIds.length === 0) throw new McpError(ErrorCode.InvalidParams, "emailIds must contain at least one email id.");
          if (!emailIds && !match) throw new McpError(ErrorCode.InvalidParams, "Provide emailIds or match.");
          if (emailIds && match) throw new McpError(ErrorCode.InvalidParams, "Provide emailIds OR match, not both.");
          const folder = optionalString(args, "folder") ?? "INBOX";
          const targetFolder = requireString(args, "targetFolder");
          const max = getBulkMaxBatchSize(args);
          const notFoundEmailIds = getBulkNotFoundEmailIds(emailIds, folder);
          const preview = await imapService.bulkMove({
            emailIds,
            match,
            folder,
            targetFolder,
            dryRun: true,
          });
          ensureBulkBatchSize(preview.total, max);
          if (normalizeBoolean(args.dryRun, false)) {
            return createTextResult(withBulkNotFound(preview, notFoundEmailIds));
          }
          const result = await withAudit(auditService, name, args, () =>
            imapService.bulkMove({
              emailIds,
              match,
              folder,
              targetFolder,
              dryRun: false,
            })
          );
          return createTextResult(withBulkNotFound(result, notFoundEmailIds));
        }

        case "bulk_delete": {
          ensureMailboxWriteAllowed(config.runtime);
          const permanent = normalizeBoolean(args.permanent, false);
          if (permanent) ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args.confirmed, false), "Permanently delete multiple emails");
          const emailIds = Array.isArray(args.emailIds)
            ? (args.emailIds as unknown[]).map(String) : undefined;
          const match = args.match && typeof args.match === "object"
            ? (args.match as BulkMatchCriteria) : undefined;
          if (emailIds && emailIds.length === 0) throw new McpError(ErrorCode.InvalidParams, "emailIds must contain at least one email id.");
          if (!emailIds && !match) throw new McpError(ErrorCode.InvalidParams, "Provide emailIds or match.");
          if (emailIds && match) throw new McpError(ErrorCode.InvalidParams, "Provide emailIds OR match, not both.");
          const folder = optionalString(args, "folder") ?? "INBOX";
          const max = getBulkMaxBatchSize(args);
          const notFoundEmailIds = getBulkNotFoundEmailIds(emailIds, folder);
          const preview = await imapService.bulkDelete({
            emailIds,
            match,
            folder,
            permanent,
            dryRun: true,
          });
          ensureBulkBatchSize(preview.total, max);
          if (normalizeBoolean(args.dryRun, false)) {
            return createTextResult(withBulkNotFound(preview, notFoundEmailIds));
          }
          const result = await withAudit(auditService, name, args, () =>
            imapService.bulkDelete({
              emailIds,
              match,
              folder,
              permanent,
              dryRun: false,
            })
          );
          return createTextResult(withBulkNotFound(result, notFoundEmailIds));
        }

        case "bulk_update_flags": {
          ensureMailboxWriteAllowed(config.runtime);
          const emailIds = Array.isArray(args.emailIds)
            ? (args.emailIds as unknown[]).map(String) : undefined;
          const match = args.match && typeof args.match === "object"
            ? (args.match as BulkMatchCriteria) : undefined;
          if (emailIds && emailIds.length === 0) throw new McpError(ErrorCode.InvalidParams, "emailIds must contain at least one email id.");
          if (!emailIds && !match) throw new McpError(ErrorCode.InvalidParams, "Provide emailIds or match.");
          if (emailIds && match) throw new McpError(ErrorCode.InvalidParams, "Provide emailIds OR match, not both.");
          const flagsToAdd = Array.isArray(args.flagsToAdd) ? (args.flagsToAdd as unknown[]).map(String) : [];
          const flagsToRemove = Array.isArray(args.flagsToRemove) ? (args.flagsToRemove as unknown[]).map(String) : [];
          if (flagsToAdd.length === 0 && flagsToRemove.length === 0) throw new McpError(ErrorCode.InvalidParams, "Provide flagsToAdd or flagsToRemove.");
          const folder = optionalString(args, "folder") ?? "INBOX";
          const max = getBulkMaxBatchSize(args);
          const notFoundEmailIds = getBulkNotFoundEmailIds(emailIds, folder);
          const preview = await imapService.bulkUpdateFlags({ emailIds, match, folder, flagsToAdd, flagsToRemove, dryRun: true });
          ensureBulkBatchSize(preview.total, max);
          if (normalizeBoolean(args.dryRun, false)) {
            return createTextResult(withBulkNotFound(preview, notFoundEmailIds));
          }
          const result = await withAudit(auditService, name, args, () =>
            imapService.bulkUpdateFlags({ emailIds, match, folder, flagsToAdd, flagsToRemove, dryRun: false })
          );
          return createTextResult(withBulkNotFound(result, notFoundEmailIds));
        }

        case "bulk_update_labels": {
          ensureMailboxWriteAllowed(config.runtime);
          const emailIds = Array.isArray(args.emailIds)
            ? (args.emailIds as unknown[]).map(String) : undefined;
          const match = args.match && typeof args.match === "object"
            ? (args.match as BulkMatchCriteria) : undefined;
          if (emailIds && emailIds.length === 0) throw new McpError(ErrorCode.InvalidParams, "emailIds must contain at least one email id.");
          if (!emailIds && !match) throw new McpError(ErrorCode.InvalidParams, "Provide emailIds or match.");
          if (emailIds && match) throw new McpError(ErrorCode.InvalidParams, "Provide emailIds OR match, not both.");
          const labelsToAdd = Array.isArray(args.labelsToAdd) ? (args.labelsToAdd as unknown[]).map(String) : [];
          const labelsToRemove = Array.isArray(args.labelsToRemove) ? (args.labelsToRemove as unknown[]).map(String) : [];
          const folder = optionalString(args, "folder") ?? "INBOX";
          const max = getBulkMaxBatchSize(args);
          const notFoundEmailIds = getBulkNotFoundEmailIds(emailIds, folder);
          const preview = await imapService.bulkUpdateLabels({ emailIds, match, folder, labelsToAdd, labelsToRemove, dryRun: true });
          ensureBulkBatchSize(preview.total, max);
          if (normalizeBoolean(args.dryRun, false)) {
            return createTextResult(withBulkNotFound(preview, notFoundEmailIds));
          }
          const result = await withAudit(auditService, name, args, () =>
            imapService.bulkUpdateLabels({ emailIds, match, folder, labelsToAdd, labelsToRemove, dryRun: false })
          );
          return createTextResult(withBulkNotFound(result, notFoundEmailIds));
        }

        case "top_senders": {
          const result = await imapService.topSenders({
            folder: optionalString(args, "folder"),
            since: optionalString(args, "since"),
            before: optionalString(args, "before"),
            limit: typeof args.limit === "number" ? args.limit : undefined,
            scanLimit: typeof args.scanLimit === "number" ? args.scanLimit : undefined,
            excludeSelf: normalizeBoolean(args.excludeSelf, true),
          });
          return createTextResult(result);
        }

        case "move_thread": {
          ensureMailboxWriteAllowed(config.runtime);
          const result = await withAudit(auditService, name, args, () =>
            imapService.moveThread({
              messageId: requireString(args, "messageId"),
              destination: requireString(args, "destination"),
              acrossFolders: normalizeBoolean(args.acrossFolders, false),
              dryRun: normalizeBoolean(args.dryRun, false),
            })
          );
          return createTextResult(result);
        }

        case "delete_thread": {
          ensureMailboxWriteAllowed(config.runtime);
          const permanentThread = normalizeBoolean(args.permanent, false);
          if (permanentThread) ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args.confirmed, false), "Permanently delete thread");
          const result = await withAudit(auditService, name, args, () =>
            imapService.deleteThread({
              messageId: requireString(args, "messageId"),
              permanent: permanentThread,
              acrossFolders: normalizeBoolean(args.acrossFolders, false),
              dryRun: normalizeBoolean(args.dryRun, false),
            })
          );
          return createTextResult(result);
        }

        case "flag_thread": {
          ensureMailboxWriteAllowed(config.runtime);
          const flagsToAdd = Array.isArray(args.flagsToAdd) ? (args.flagsToAdd as unknown[]).map(String) : [];
          const flagsToRemove = Array.isArray(args.flagsToRemove) ? (args.flagsToRemove as unknown[]).map(String) : [];
          if (flagsToAdd.length === 0 && flagsToRemove.length === 0) throw new McpError(ErrorCode.InvalidParams, "Provide flagsToAdd or flagsToRemove.");
          const result = await withAudit(auditService, name, args, () =>
            imapService.flagThread({
              messageId: requireString(args, "messageId"),
              flagsToAdd,
              flagsToRemove,
              acrossFolders: normalizeBoolean(args.acrossFolders, false),
              dryRun: normalizeBoolean(args.dryRun, false),
            })
          );
          return createTextResult(result);
        }

        case "create_label": {
          ensureMailboxWriteAllowed(config.runtime);
          const rawName = requireString(args, "name");
          if (!rawName.trim()) throw new McpError(ErrorCode.InvalidParams, "Label name cannot be empty.");
          const labelPath = rawName.startsWith("Labels/") ? rawName : `Labels/${rawName}`;
          const result = await withAudit(auditService, name, args, () =>
            imapService.createFolder(labelPath)
          );
          return createTextResult(result);
        }

        case "rename_label": {
          ensureMailboxWriteAllowed(config.runtime);
          const rawName = requireString(args, "name");
          const rawNewName = requireString(args, "newName");
          if (!rawName.trim()) throw new McpError(ErrorCode.InvalidParams, "Label name cannot be empty.");
          if (!rawNewName.trim()) throw new McpError(ErrorCode.InvalidParams, "New label name cannot be empty.");
          const labelPath = rawName.startsWith("Labels/") ? rawName : `Labels/${rawName}`;
          const newLabelPath = rawNewName.startsWith("Labels/") ? rawNewName : `Labels/${rawNewName}`;
          const result = await withAudit(auditService, name, args, () =>
            imapService.renameFolder(labelPath, newLabelPath)
          );
          return createTextResult(result);
        }

        case "delete_label": {
          ensureMailboxWriteAllowed(config.runtime);
          const rawName = requireString(args, "name");
          if (!rawName.trim()) throw new McpError(ErrorCode.InvalidParams, "Label name cannot be empty.");
          const labelPath = rawName.startsWith("Labels/") ? rawName : `Labels/${rawName}`;
          ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args?.confirmed, false), "Permanently delete label: " + labelPath);
          const result = await withAudit(auditService, name, args, () =>
            imapService.deleteFolder(labelPath)
          );
          return createTextResult(result);
        }

        case "get_folders":
          return createTextResult(await imapService.getFolders());

        case "sync_folders":
          return createTextResult(await imapService.syncFolders());

        case "create_folder":
          ensureMailboxWriteAllowed(config.runtime);
          return createTextResult(
            await withAudit(auditService, name, args, async () =>
              imapService.createFolder(requireString(args, "path")),
            ),
          );

        case "rename_folder":
          ensureMailboxWriteAllowed(config.runtime);
          return createTextResult(
            await withAudit(auditService, name, args, async () =>
              imapService.renameFolder(
                requireString(args, "path"),
                requireString(args, "newPath"),
              ),
            ),
          );

        case "delete_folder":
          ensureMailboxWriteAllowed(config.runtime);
          ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args?.confirmed, false), "Permanently delete folder and all messages in it: " + requireString(args, "path"));
          return createTextResult(
            await withAudit(auditService, name, args, async () =>
              imapService.deleteFolder(requireString(args, "path")),
            ),
          );

        case "mark_email_read":
          ensureEmailActionAllowed(
            config.runtime,
            normalizeBoolean(args.isRead, true) ? "mark_read" : "mark_unread",
          );
          return createTextResult(
            await withAudit(auditService, name, args, async () =>
              imapService.markEmailRead(
                requireString(args, "emailId"),
                normalizeBoolean(args.isRead, true),
              ),
            ),
          );

        case "star_email":
          ensureEmailActionAllowed(
            config.runtime,
            normalizeBoolean(args.isStarred, true) ? "star" : "unstar",
          );
          return createTextResult(
            await withAudit(auditService, name, args, async () =>
              imapService.starEmail(
                requireString(args, "emailId"),
                normalizeBoolean(args.isStarred, true),
              ),
            ),
          );

        case "move_email":
        {
          ensureMailboxWriteAllowed(config.runtime);
          const emailId = requireString(args, "emailId");
          const targetFolder = requireString(args, "targetFolder");
          const result = await withAudit(auditService, name, args, async () => {
            try {
              return await imapService.moveEmail(emailId, targetFolder);
            } catch (error) {
              if (isMissingTargetFolderError(error)) {
                throw new McpError(
                  ErrorCode.InvalidParams,
                  `Target folder ${targetFolder} does not exist. Use get_folders to list valid paths.`,
                );
              }
              throw error;
            }
          });
          const sources = result.targetEmailId
            ? [
                {
                  uri: buildEmailResourceUri(result.targetEmailId),
                  name: result.targetEmailId,
                  title: `Moved email ${result.targetEmailId}`,
                  description: `${result.targetFolder} · uid ${result.targetUid || result.uid}`,
                  mimeType: "message/rfc822",
                },
              ]
            : [];
          return createTextResult(result, false, sources);
        }

        case "archive_email":
        {
          ensureEmailActionAllowed(config.runtime, "archive");
          const result = await withAudit(auditService, name, args, async () =>
            imapService.archiveEmail(requireString(args, "emailId")),
          );
          const sources = result.targetEmailId
            ? [
                {
                  uri: buildEmailResourceUri(result.targetEmailId),
                  name: result.targetEmailId,
                  title: `Archived email ${result.targetEmailId}`,
                  description: `${result.targetFolder} · uid ${result.targetUid || result.uid}`,
                  mimeType: "message/rfc822",
                },
              ]
            : [];
          return createTextResult(result, false, sources);
        }

        case "trash_email":
        {
          ensureEmailActionAllowed(config.runtime, "trash");
          const result = await withAudit(auditService, name, args, async () =>
            imapService.trashEmail(requireString(args, "emailId")),
          );
          const sources = result.targetEmailId
            ? [
                {
                  uri: buildEmailResourceUri(result.targetEmailId),
                  name: result.targetEmailId,
                  title: `Trashed email ${result.targetEmailId}`,
                  description: `${result.targetFolder} · uid ${result.targetUid || result.uid}`,
                  mimeType: "message/rfc822",
                },
              ]
            : [];
          return createTextResult(result, false, sources);
        }

        case "restore_email":
        {
          ensureEmailActionAllowed(config.runtime, "restore");
          const result = await withAudit(auditService, name, args, async () =>
            imapService.restoreEmail(
              requireString(args, "emailId"),
              optionalString(args, "targetFolder"),
            ),
          );
          const sources = result.targetEmailId
            ? [
                {
                  uri: buildEmailResourceUri(result.targetEmailId),
                  name: result.targetEmailId,
                  title: `Restored email ${result.targetEmailId}`,
                  description: `${result.targetFolder} · uid ${result.targetUid || result.uid}`,
                  mimeType: "message/rfc822",
                },
              ]
            : [];
          return createTextResult(result, false, sources);
        }

        case "snooze_email": {
          ensureEmailActionAllowed(config.runtime, "archive");
          const wakeAt = requireString(args, "wakeAt");
          const wakeAtTime = new Date(wakeAt).getTime();
          if (Number.isNaN(wakeAtTime)) {
            throw new McpError(ErrorCode.InvalidParams, `wakeAt is not a valid ISO 8601 timestamp: ${wakeAt}`);
          }
          if (wakeAtTime <= Date.now()) {
            throw new McpError(ErrorCode.InvalidParams, "wakeAt must be in the future.");
          }
          const snoozed = await withAudit(auditService, name, args, async () =>
            snoozeService.snooze(requireString(args, "emailId"), new Date(wakeAtTime).toISOString()),
          );
          return createTextResult({
            id: snoozed.id,
            emailId: snoozed.currentEmailId,
            wakeAt: snoozed.wakeAt,
            note: "This server must stay running for the wake to fire at wakeAt — if restarted first, it wakes on next startup instead. Cancelable via cancel_snooze.",
          });
        }

        case "cancel_snooze": {
          // cancel moves the mailbox back to its original folder, same as
          // snooze_email's own move — gate it the same way.
          ensureEmailActionAllowed(config.runtime, "archive");
          const result = await withAudit(auditService, name, args, async () =>
            snoozeService.cancel(requireString(args, "id")),
          );
          return createTextResult(result);
        }

        case "list_snoozed": {
          const statusFilter = optionalString(args, "status");
          const all = await withAudit(auditService, name, args, async () => snoozeService.list());
          const filtered = statusFilter ? all.filter((item) => item.status === statusFilter) : all;
          return createTextResult(filtered);
        }

        case "create_template": {
          const result = await withAudit(auditService, name, args, async () =>
            templateService.create({
              name: requireString(args, "name"),
              subject: requireString(args, "subject"),
              body: requireString(args, "body"),
              isHtml: normalizeBoolean(args.isHtml, false),
            }),
          );
          return createTextResult(result);
        }

        case "list_templates": {
          const result = await withAudit(auditService, name, args, async () => templateService.list());
          return createTextResult(result);
        }

        case "get_template": {
          const result = await withAudit(auditService, name, args, async () =>
            templateService.get(requireString(args, "id")),
          );
          return createTextResult(result);
        }

        case "delete_template": {
          const result = await withAudit(auditService, name, args, async () =>
            templateService.delete(requireString(args, "id")),
          );
          return createTextResult(result);
        }

        case "render_template": {
          const variables = (args.variables && typeof args.variables === "object" ? args.variables : {}) as Record<string, string>;
          const result = await withAudit(auditService, name, args, async () =>
            templateService.render(requireString(args, "id"), variables),
          );
          return createTextResult(result);
        }

        case "delete_email":
          ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args.confirmed, false), `Permanently delete ${String(args.emailId ?? "?")} (cannot be recovered)`);
          ensureMailboxWriteAllowed(config.runtime);
          return createTextResult(
            await withAudit(auditService, name, args, async () =>
              imapService.deleteEmail(requireString(args, "emailId")),
            ),
          );

        case "batch_email_action":
        {
          const emailIds = [...new Set(parseStringListArg(args, "emailIds"))];
          if (emailIds.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "emailIds must contain at least one email id.");
          }
          const action = requireEmailAction(args);
          ensureEmailActionAllowed(config.runtime, action);
          const result = await withAudit(auditService, name, args, async () =>
            applyBatchEmailAction(imapService, [], {
              emailIds,
              action,
              targetFolder: optionalString(args, "targetFolder"),
              continueOnError: normalizeBoolean(args.continueOnError, true),
              dryRun: normalizeBoolean(args.dryRun, false),
            }),
          );

          const sources = result.results.flatMap((entry) =>
            entry.ok ? emailSourceFromActionResult(entry.result) : [],
          );
          return createTextResult(result, false, sources);
        }

        case "get_email_stats": {
          const folders = await imapService.getFolders();
          const sample = await getAnalyticsSampleFromIndex(
            imapService,
            localIndexService,
            typeof args.days === "number" ? args.days : 30,
            typeof args.limit === "number" ? args.limit : 2000,
          );
          return createTextResult(
            analyticsService.getEmailStats(sample, folders, config.smtp.username),
          );
        }

        case "get_email_analytics": {
          const sample = await getAnalyticsSampleFromIndex(
            imapService,
            localIndexService,
            typeof args.days === "number" ? args.days : 30,
            typeof args.limit === "number" ? args.limit : 2000,
          );
          return createTextResult(
            analyticsService.getEmailAnalytics(sample, config.smtp.username),
          );
        }

        case "get_contacts": {
          // limit is "how many contacts to return", not "how many messages to
          // sample" — unlike get_email_stats/get_email_analytics (which return
          // one aggregate object, so their limit genuinely means sample size),
          // get_contacts returns a ranked list. Reusing limit as the sample size
          // meant limit: 5 silently ranked contacts from only 5 messages total.
          const limit = normalizeLimit(args.limit, 100);
          const sample = await getAnalyticsSampleFromIndex(imapService, localIndexService, 30, 3000);
          return createTextResult(
            analyticsService.getContacts(sample, limit, config.smtp.username),
          );
        }

        case "get_volume_trends": {
          const days = normalizeLimit(args.days, 30, 1, 365);
          const sample = await getAnalyticsSampleFromIndex(imapService, localIndexService, days, 3000);
          return createTextResult(analyticsService.getVolumeTrends(sample, days));
        }

        case "get_connection_status": {
          const includeRawConnectionErrors = process.env.PROTONMAIL_DEBUG === "true";
          const [smtpStatus, imapStatus] = await Promise.allSettled([
            smtpService.verifyConnection(),
            imapService.ping(),
          ]);

          return createTextResult({
            checkedAt: new Date().toISOString(),
            // A running server has no other way to tell an MCP client which
            // install it's actually talking to — a stale/orphaned install
            // (wrong path, old version) looks identical to a fresh one from
            // every other field here. Found this gap while diagnosing a
            // real 5-month-stale install that silently caused timeouts long
            // after the underlying bugs were fixed upstream.
            version: PACKAGE_VERSION,
            entrypoint: fileURLToPath(import.meta.url),
            smtp: {
              ok: smtpStatus.status === "fulfilled",
              message:
                smtpStatus.status === "fulfilled"
                  ? "SMTP connection verified."
                  : includeRawConnectionErrors
                    ? smtpStatus.reason instanceof Error
                      ? smtpStatus.reason.message
                      : String(smtpStatus.reason)
                    : "SMTP connection failed.",
            },
            imap: {
              ok: imapStatus.status === "fulfilled",
              connected: imapService.isConnected(),
              idle: imapService.getIdleStatus(),
              message:
                imapStatus.status === "fulfilled"
                  ? "IMAP connection verified."
                  : includeRawConnectionErrors
                    ? imapStatus.reason instanceof Error
                      ? imapStatus.reason.message
                      : String(imapStatus.reason)
                    : "IMAP connection failed.",
            },
          });
        }

        case "run_doctor": {
          const includeRawConnectionErrors = process.env.PROTONMAIL_DEBUG === "true";
          const includeSmtp = normalizeBoolean(args.includeSmtp, true);
          const includeImap = normalizeBoolean(args.includeImap, true);
          const includeIdleProbe = normalizeBoolean(args.includeIdleProbe, false);
          const idleTimeoutSeconds = normalizeLimit(args.idleTimeoutSeconds, 5, 1, 60);
          const [smtpStatus, imapStatus, indexStatus, integrity, drafts] = await Promise.all([
            includeSmtp
              ? Promise.allSettled([smtpService.verifyConnection()]).then(([result]) => result)
              : Promise.resolve({ status: "fulfilled", value: undefined } as const),
            includeImap
              ? Promise.allSettled([imapService.ping()]).then(([result]) => result)
              : Promise.resolve({ status: "fulfilled", value: undefined } as const),
            localIndexService.getStatus(),
            localIndexService.runIntegrityCheck(),
            draftStore.listDrafts(true),
          ]);

          const idleProbe = includeIdleProbe
            ? await Promise.allSettled([
                imapService.waitForMailboxChanges({
                  folder: config.runtime.autoSyncFolder,
                  timeoutMs: idleTimeoutSeconds * 1000,
                }),
              ]).then(([result]) => result)
            : undefined;

          // Classifies the connection failure into a specific, actionable cause —
          // without PROTONMAIL_DEBUG this used to just say "connection failed" for
          // both a wrong password and Bridge not being open at all.
          const diagnoseFailure = (
            reason: unknown,
          ): { cause: string; suggestion: string } | undefined => {
            if (isLikelyAuthenticationError(reason)) {
              return {
                cause: "authentication_failed",
                suggestion:
                  "PROTONMAIL_PASSWORD must be the Proton Bridge password (Bridge app -> account -> Mailbox details), not your Proton account password. Confirm you're signed in inside the Bridge app.",
              };
            }
            if (isLikelyConnectionError(reason)) {
              return {
                cause: "bridge_unreachable",
                suggestion:
                  "Proton Bridge isn't reachable on the configured host/port. Make sure the Bridge app is running, and that PROTONMAIL_IMAP_HOST/PORT and PROTONMAIL_SMTP_HOST/PORT match Bridge's Mailbox details.",
              };
            }
            return undefined;
          };

          return createTextResult({
            checkedAt: new Date().toISOString(),
            // See get_connection_status for why this matters: from inside
            // the tool, a stale install is indistinguishable from a fresh
            // one on every other field here.
            version: PACKAGE_VERSION,
            entrypoint: fileURLToPath(import.meta.url),
            runtime: sanitizeRuntimeConfig(config.runtime),
            smtp: {
              ok: smtpStatus.status === "fulfilled",
              enabled: includeSmtp,
              message:
                smtpStatus.status === "fulfilled"
                  ? "SMTP connection verified."
                  : includeRawConnectionErrors
                    ? smtpStatus.reason instanceof Error
                      ? smtpStatus.reason.message
                      : String(smtpStatus.reason)
                    : "SMTP connection failed.",
              ...(smtpStatus.status === "rejected" ? { diagnosis: diagnoseFailure(smtpStatus.reason) } : {}),
            },
            imap: {
              ok: imapStatus.status === "fulfilled",
              enabled: includeImap,
              idle: imapService.getIdleStatus(),
              message:
                imapStatus.status === "fulfilled"
                  ? "IMAP connection verified."
                  : includeRawConnectionErrors
                    ? imapStatus.reason instanceof Error
                      ? imapStatus.reason.message
                      : String(imapStatus.reason)
                    : "IMAP connection failed.",
              ...(imapStatus.status === "rejected" ? { diagnosis: diagnoseFailure(imapStatus.reason) } : {}),
            },
            idleProbe:
              idleProbe === undefined
                ? { skipped: true }
                : idleProbe.status === "fulfilled"
                  ? idleProbe.value
                  : {
                      ok: false,
                      error: includeRawConnectionErrors
                        ? idleProbe.reason instanceof Error
                          ? idleProbe.reason.message
                          : String(idleProbe.reason)
                        : "IMAP connection failed.",
                    },
            backgroundSync: backgroundSyncService.getStatus(),
            index: indexStatus,
            integrity,
            drafts: {
              total: drafts.length,
              syncFailed: drafts.filter((draft) => draft.remoteSyncState === "sync_failed").length,
              syncFailedIds: drafts
                .filter((draft) => draft.remoteSyncState === "sync_failed")
                .map((draft) => draft.id),
            },
            audit: {
              path: auditService.getPath(),
            },
            // What this server can and cannot do, given Proton Bridge only proxies
            // local IMAP/SMTP — prevents an agent from attempting an impossible
            // operation (e.g. server-side filters) and getting a confusing failure.
            capabilities: {
              supported: ["mail read/search/send", "folders", "labels (IMAP folders under Labels/)", "drafts", "local full-text index"],
              notSupported: [
                "server-side filters/rules (no ManageSieve access through Bridge)",
                "real contacts / address book (no CardDAV access through Bridge)",
                "calendar (no CalDAV access through Bridge)",
                "vacation responder (Proton account API only, not exposed via Bridge)",
              ],
            },
          });
        }

        case "get_runtime_status": {
          const [indexStatus, drafts] = await Promise.all([
            localIndexService.getStatus(),
            draftStore.listDrafts(true),
          ]);
          return createTextResult({
            checkedAt: new Date().toISOString(),
            runtime: sanitizeRuntimeConfig(config.runtime),
            backgroundSync: backgroundSyncService.getStatus(),
            imapIdle: imapService.getIdleStatus(),
            index: indexStatus,
            audit: {
              enabled: true,
            },
            drafts: {
              total: drafts.length,
              active: drafts.filter((draft) => draft.status === "draft").length,
              remoteSynced: drafts.filter((draft) => draft.remoteSyncState === "synced").length,
              syncFailed: drafts.filter((draft) => draft.remoteSyncState === "sync_failed").length,
            },
          });
        }

        case "run_background_sync":
          return createTextResult({
            checkedAt: new Date().toISOString(),
            backgroundSync: await backgroundSyncService.runNow(),
            index: await localIndexService.getStatus(),
          });

        case "wait_for_mailbox_changes":
          return createTextResult(
            await imapService.waitForMailboxChanges({
              folder: optionalString(args, "folder"),
              timeoutMs: normalizeLimit(args.timeoutSeconds, 15, 1, 300) * 1000,
            }),
          );

        case "sync_emails":
        {
          const syncStatus = await backgroundSyncService.runNow("sync_emails");
          const indexStatus = await localIndexService.getStatus();
          return createTextResult({
            checkedAt: new Date().toISOString(),
            backgroundSync: syncStatus,
            index: {
              updatedAt: indexStatus.updatedAt,
              storedMessageCount: indexStatus.storedMessageCount,
              dedupedMessageCount: indexStatus.dedupedMessageCount,
              path: indexStatus.path,
            },
          });
        }

        case "get_index_status":
          return createTextResult(await localIndexService.getStatus());

        case "search_indexed_emails":
        {
          const result = await localIndexService.search({
            query: optionalString(args, "query"),
            folder: optionalString(args, "folder"),
            label: optionalString(args, "label"),
            threadId: optionalString(args, "threadId"),
            from: optionalString(args, "from"),
            to: optionalString(args, "to"),
            senderDomain: optionalString(args, "senderDomain"),
            subject: optionalString(args, "subject"),
            hasAttachment:
              typeof args.hasAttachment === "boolean" ? args.hasAttachment : undefined,
            attachmentName: optionalString(args, "attachmentName"),
            isRead: typeof args.isRead === "boolean" ? args.isRead : undefined,
            isStarred: typeof args.isStarred === "boolean" ? args.isStarred : undefined,
            mailboxRole: optionalString(args, "mailboxRole"),
            dateFrom: optionalString(args, "dateFrom"),
            dateTo: optionalString(args, "dateTo"),
            limit: typeof args.limit === "number" ? args.limit : undefined,
          });
          return createTextResult(
            { ...result, emails: projectFields(result.emails, parseFieldsArg(args.fields)) },
            false,
            result.emails.map(emailSource),
          );
        }

        case "get_labels":
        {
          const labels = await localIndexService.getLabels(normalizeLimit(args.limit, 250));
          return createTextResult({
            total: labels.length,
            labels,
          });
        }

        case "get_threads":
        {
          await maybeRefreshLocalIndex(imapService, localIndexService, {
            folder: "INBOX",
            limitPerFolder: 100,
          });
          const result = await localIndexService.getThreads({
            query: optionalString(args, "query"),
            label: optionalString(args, "label"),
            limit: typeof args.limit === "number" ? args.limit : undefined,
          });
          return createTextResult(result, false, result.threads.map(threadSource));
        }

        case "get_actionable_threads":
        {
          const refresh = await maybeRefreshLocalIndex(imapService, localIndexService, {
            force: normalizeBoolean(args.syncBefore, false),
            folder: "INBOX",
            limitPerFolder: 100,
          });
          const result = await localIndexService.getActionableThreads({
            query: optionalString(args, "query"),
            label: optionalString(args, "label"),
            pendingOn:
              args.pendingOn === "you" || args.pendingOn === "them" || args.pendingOn === "any"
                ? args.pendingOn
                : undefined,
            unreadOnly: normalizeBoolean(args.unreadOnly, true),
            limit: typeof args.limit === "number" ? args.limit : undefined,
          });
          return createTextResult(
            refresh ? { ...result, indexUpdatedAt: refresh.indexStatus.updatedAt } : result,
            false,
            result.threads.map(threadSource),
          );
        }

        case "get_inbox_digest":
        {
          await maybeRefreshLocalIndex(imapService, localIndexService, {
            force: normalizeBoolean(args.syncBefore, false),
            folder: "INBOX",
            limitPerFolder: 100,
          });
          const result = await localIndexService.getInboxDigest({
            limit: typeof args.limit === "number" ? args.limit : undefined,
            minAgeHours: typeof args.minAgeHours === "number" ? args.minAgeHours : undefined,
          });
          const topThreads = Array.isArray(result.topThreads) ? result.topThreads : [];
          const staleThreads = Array.isArray(result.staleAwaitingYou) ? result.staleAwaitingYou : [];
          return createTextResult(
            result,
            false,
            [...topThreads, ...staleThreads]
              .filter((thread): thread is { id: string; subject: string; latestDate?: string; messageCount: number; normalizedLabels?: string[]; participants?: EmailAddress[] } =>
                Boolean(thread && typeof thread === "object" && "id" in thread),
              )
              .map(threadSource),
          );
        }

        case "get_follow_up_candidates":
        {
          await maybeRefreshLocalIndex(imapService, localIndexService, {
            force: normalizeBoolean(args.syncBefore, false),
            folder: "INBOX",
            limitPerFolder: 100,
          });
          const result = await localIndexService.getFollowUpCandidates({
            limit: typeof args.limit === "number" ? args.limit : undefined,
            minAgeHours: typeof args.minAgeHours === "number" ? args.minAgeHours : undefined,
            pendingOn:
              args.pendingOn === "you" || args.pendingOn === "them" || args.pendingOn === "any"
                ? args.pendingOn
                : undefined,
          });
          return createTextResult(
            result,
            false,
            Array.isArray(result.threads)
              ? result.threads
                  .filter((thread): thread is { id: string; subject: string; latestDate?: string; messageCount: number; normalizedLabels?: string[]; participants?: EmailAddress[] } =>
                    Boolean(thread && typeof thread === "object" && "id" in thread),
                  )
                  .map(threadSource)
              : [],
          );
        }

        case "find_document_threads":
        {
          await maybeRefreshLocalIndex(imapService, localIndexService, {
            force: normalizeBoolean(args.syncBefore, false),
            folder: "INBOX",
            limitPerFolder: 100,
          });
          const result = await localIndexService.findDocumentThreads({
            category:
              args.category === "document" ||
              args.category === "invoice" ||
              args.category === "contract" ||
              args.category === "travel" ||
              args.category === "calendar"
                ? args.category
                : undefined,
            query: optionalString(args, "query"),
            limit: typeof args.limit === "number" ? args.limit : undefined,
          });
          const threads = Array.isArray(result.threads) ? result.threads : [];
          return createTextResult(
            result,
            false,
            threads
              .filter((thread): thread is { id: string; subject: string; latestDate?: string; messageCount: number; normalizedLabels?: string[]; participants?: EmailAddress[] } =>
                Boolean(thread && typeof thread === "object" && "id" in thread),
              )
              .map(threadSource),
          );
        }

        case "prepare_meeting_context":
        {
          await maybeRefreshLocalIndex(imapService, localIndexService, {
            force: normalizeBoolean(args.syncBefore, false),
            folder: "INBOX",
            limitPerFolder: 100,
          });
          const result = await localIndexService.getMeetingPrep({
            person: optionalString(args, "person"),
            domain: optionalString(args, "domain"),
            limit: typeof args.limit === "number" ? args.limit : undefined,
          });
          const threads = Array.isArray(result.threads) ? result.threads : [];
          return createTextResult(
            result,
            false,
            threads
              .filter((thread): thread is { id: string; subject: string; latestDate?: string; messageCount: number; normalizedLabels?: string[]; participants?: EmailAddress[] } =>
                Boolean(thread && typeof thread === "object" && "id" in thread),
              )
              .map(threadSource),
          );
        }

        case "get_thread_brief":
        {
          await maybeRefreshLocalIndex(imapService, localIndexService, {
            folder: "INBOX",
            limitPerFolder: 100,
          });
          const thread = await localIndexService.getThreadById(requireString(args, "threadId"));
          const result = buildThreadBrief(thread, config.smtp.username);
          return createTextResult(
            result,
            false,
            [
              threadSource(thread),
              ...thread.messages.map((message) =>
                emailSource({
                  id: message.primaryEmailId,
                  subject: message.subject,
                  folder: message.folder,
                  date: message.date,
                  internalDate: message.internalDate,
                  preview: message.preview,
                  from: message.from,
                  messageId: message.messageId,
                  threadId: thread.id,
                }),
              ),
            ],
          );
        }

        case "get_thread_by_id":
        {
          await maybeRefreshLocalIndex(imapService, localIndexService, {
            folder: "INBOX",
            limitPerFolder: 100,
          });
          const rawFolders = args?.folders;
          const threadFolders = Array.isArray(rawFolders) ? rawFolders.filter((f): f is string => typeof f === "string") : undefined;
          const thread = await localIndexService.getThreadById(requireString(args, "threadId"));
          const result = threadFolders && threadFolders.length > 0
            ? {
                ...thread,
                messages: thread.messages.filter((message) => threadFolders.includes(message.folder)),
                messageCount: thread.messages.filter((message) => threadFolders.includes(message.folder)).length,
                unreadCount: thread.messages.filter((message) => threadFolders.includes(message.folder) && !message.isRead).length,
              }
            : thread;
          return createTextResult(
            result,
            false,
            [threadSource(result), ...result.messages.map((message) => emailSource({
              id: message.primaryEmailId,
              subject: message.subject,
              folder: message.folder,
              date: message.date,
              internalDate: message.internalDate,
            }))],
          );
        }

        case "create_thread_reply_draft":
        {
          await maybeRefreshLocalIndex(imapService, localIndexService, {
            force: normalizeBoolean(args.syncBefore, false),
            folder: "INBOX",
            limitPerFolder: 100,
          });

          const thread = await localIndexService.getThreadById(requireString(args, "threadId"));
          const targetMessage = pickReplyTargetFromThread(
            thread,
            config.smtp.username,
            normalizeBoolean(args.preferLatestInbound, true),
          );

          if (!targetMessage?.primaryEmailId) {
            throw new McpError(ErrorCode.InvalidParams, "Unable to resolve a reply target from the thread.");
          }

          const detail = await imapService.getEmailById(targetMessage.primaryEmailId);
          const body = requireString(args, "body");
          const isHtml = normalizeBoolean(args.isHtml, false);
          const replyAll = normalizeBoolean(args.replyAll, false);
          const attachments = optionalAttachmentList(args.attachments);
          const extraCc = parseEmails(optionalString(args, "cc"));
          const extraBcc = parseEmails(optionalString(args, "bcc"));
          const recipients = getReplyRecipients(detail, config.smtp.username, replyAll);
          const cc = uniqueAddresses([...recipients.cc, ...extraCc]);
          const to = uniqueAddresses(recipients.to);

          ensureValidEmails(to, "to");
          ensureValidEmails(cc, "cc");
          ensureValidEmails(extraBcc, "bcc");

          if (to.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "Unable to infer reply recipient.");
          }

          const result = await withAudit(auditService, name, args, async () => {
            const draft = await draftStore.createDraft({
              mode: "reply",
              to,
              cc,
              bcc: extraBcc,
              subject: prefixedSubject(detail.subject, "Re:"),
              body: buildReplyText(detail, body),
              isHtml,
              inReplyTo: detail.messageId,
              references: detail.messageId ? [detail.messageId] : undefined,
              attachments,
              sourceEmailId: detail.id,
              sourceMessageId: detail.messageId,
              notes: optionalString(args, "notes"),
            });

            const remoteSyncDecision = resolveRemoteDraftSync(
              config.runtime,
              normalizeBoolean(args.syncToRemote, true),
            );
            const synced = remoteSyncDecision.enabled
              ? await syncDraftToRemote(draftStore, smtpService, imapService, draft)
              : { draft, remoteSync: undefined };
            const remoteSync =
              synced.remoteSync ??
              (remoteSyncDecision.reason
                ? {
                    ok: false,
                    skipped: true,
                    message: remoteSyncDecision.reason,
                  }
                : undefined);

            return remoteSync
              ? { ...synced.draft, remoteSync, threadId: thread.id }
              : { ...synced.draft, threadId: thread.id };
          });

          return createTextResult(
            result,
            false,
            [
              draftSource(result),
              threadSource(thread),
              emailSource(detail),
              ...(result.remoteDraft?.emailId
                ? [
                    emailSource({
                      id: result.remoteDraft.emailId,
                      subject: result.subject,
                      folder: result.remoteDraft.folder,
                    })
                  ]
                : []),
            ],
          );
        }

        case "apply_thread_action":
        {
          await maybeRefreshLocalIndex(imapService, localIndexService, {
            force: normalizeBoolean(args.syncBefore, false),
            folder: "INBOX",
            limitPerFolder: 100,
          });

          const thread = await localIndexService.getThreadById(requireString(args, "threadId"));
          const action = requireEmailAction(args);
          ensureEmailActionAllowed(config.runtime, action);
          const unreadOnly = normalizeBoolean(args.unreadOnly, false);
          const emailIds = [...new Set(
            thread.messages
              .filter((message) => !unreadOnly || !message.isRead)
              .map((message) => message.primaryEmailId),
          )];

          const result = await withAudit(auditService, name, args, async () =>
            applyBatchEmailAction(imapService, [], {
              emailIds,
              action,
              targetFolder: optionalString(args, "targetFolder"),
              continueOnError: normalizeBoolean(args.continueOnError, true),
              dryRun: normalizeBoolean(args.dryRun, false),
            }),
          );

          const sources = [
            threadSource(thread),
            ...result.results.flatMap((entry) => (entry.ok ? emailSourceFromActionResult(entry.result) : [])),
          ];

          return createTextResult(
            {
              threadId: thread.id,
              unreadOnly,
              dryRun: normalizeBoolean(args.dryRun, false),
              ...result,
            },
            false,
            sources,
          );
        }

        case "list_attachments":
        {
          const attachmentList = await imapService.listAttachments(requireString(args, "emailId"));
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
            emailId: attachmentList.emailId,
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
          const result = await imapService.getAttachmentContent(
            requireString(args, "emailId"),
            requireString(args, "attachmentId"),
            normalizeBoolean(args.includeBase64, false),
          );
          const saveTo = optionalString(args, "saveTo");
          if (!saveTo && result.base64) {
            const MAX_INLINE_BYTES = (config.runtime.maxInlineBytes ?? 40) * 1024;
            const decodedSize = Math.floor(result.base64.length * 0.75);
            if (decodedSize > MAX_INLINE_BYTES) {
              throw new McpError(
                ErrorCode.InvalidParams,
                `Attachment is ~${Math.round(decodedSize / 1024)}KB decoded. Inline limit is ${config.runtime.maxInlineBytes ?? 40}KB. Set PROTONMAIL_ALLOW_FILE_DOWNLOAD_DIR and pass saveTo to write to disk instead, or increase the limit with PROTONMAIL_MAX_INLINE_BYTES.`,
              );
            }
          }
          if (saveTo && result.base64) {
            const downloadDir = config.runtime.allowFileDownloadDir;
            if (!downloadDir) {
              throw new McpError(ErrorCode.InvalidParams, "PROTONMAIL_ALLOW_FILE_DOWNLOAD_DIR env var is not set.");
            }
            const { resolve: pathResolve, join: pathJoin, dirname, basename, sep } = await import("node:path");
            const { realpathSync } = await import("node:fs");
            const { writeFile: wf, mkdir: mkd } = await import("node:fs/promises");
            const absDir = pathResolve(downloadDir);
            const absTarget = pathJoin(absDir, saveTo);
            if (!absTarget.startsWith(absDir + "/") && absTarget !== absDir) {
              throw new McpError(ErrorCode.InvalidParams, "saveTo path escapes the allowed directory.");
            }
            await mkd(pathResolve(absTarget, ".."), { recursive: true });
            let realTarget: string;
            try {
              realTarget = realpathSync(absTarget);
            } catch (error) {
              if (
                error &&
                typeof error === "object" &&
                "code" in error &&
                (error as { code?: string }).code === "ENOENT"
              ) {
                realTarget = realpathSync(dirname(absTarget)) + sep + basename(absTarget);
              } else {
                throw error;
              }
            }
            if (!realTarget.startsWith(absDir + "/") && realTarget !== absDir) {
              throw new McpError(ErrorCode.InvalidParams, "saveTo path escapes the allowed directory.");
            }
            const buf = Buffer.from(result.base64, "base64");
            await wf(absTarget, buf);
            return createTextResult({ saved: true, path: absTarget, bytes: buf.length, filename: result.attachment?.filename });
          }
          return createTextResult(result, false, [attachmentSource(result.emailId, result.attachment)]);
        }

        case "get_attachment_text": {
          const result = await imapService.getAttachmentText(
            requireString(args, "emailId"),
            requireString(args, "attachmentId"),
          );
          return createTextResult(result, false, [attachmentSource(result.emailId, result.attachment)]);
        }

        case "save_attachment":
        {
          const saveTo = optionalString(args, "saveTo");
          const outputPath = optionalString(args, "outputPath");
          let resolvedPath = outputPath;
          if (saveTo) {
            const allowDir = config.runtime.allowFileDownloadDir;
            if (!allowDir) throw new McpError(ErrorCode.InvalidParams, "PROTONMAIL_ALLOW_FILE_DOWNLOAD_DIR must be set to use saveTo.");
            const absDir = pathResolve(allowDir);
            const absTarget = pathResolve(join(absDir, saveTo));
            if (!absTarget.startsWith(absDir + "/") && absTarget !== absDir) {
              throw new McpError(ErrorCode.InvalidParams, "saveTo path escapes the allowed directory.");
            }
            resolvedPath = absTarget;
          }
          const result = await imapService.saveAttachment(
            requireString(args, "emailId"),
            requireString(args, "attachmentId"),
            resolvedPath,
          );
          return createTextResult(result, false, [attachmentSource(result.emailId, result.attachment)]);
        }

        case "export_email": {
          const result = await withAudit(auditService, name, args, async () =>
            imapService.exportEmail(requireString(args, "emailId"), optionalString(args, "outputPath")),
          );
          return createTextResult(result);
        }

        case "import_email": {
          ensureMailboxWriteAllowed(config.runtime);
          const rawText = optionalString(args, "raw");
          const rawBase64 = optionalString(args, "rawBase64");
          if (!rawText && !rawBase64) {
            throw new McpError(ErrorCode.InvalidParams, "Provide raw or rawBase64.");
          }
          if (rawText && rawBase64) {
            throw new McpError(ErrorCode.InvalidParams, "Provide raw OR rawBase64, not both.");
          }
          // Many real .eml exports use a legacy 8-bit charset (ISO-8859-1,
          // Windows-1252, etc.) outside of MIME-encoded parts — decoding
          // those bytes as UTF-8 either mangles them or throws outright.
          // rawBase64 preserves the message byte-for-byte regardless of
          // its original encoding.
          const raw = rawBase64
            ? Buffer.from(rawBase64, "base64")
            : Buffer.from(rawText as string, "utf8");
          const result = await withAudit(auditService, name, args, async () =>
            imapService.importEmail({
              raw,
              targetFolder: optionalString(args, "targetFolder"),
              flags: normalizeBoolean(args.markAsRead, false) ? ["\\Seen"] : [],
            }),
          );
          return createTextResult(result);
        }

        case "save_attachments":
        {
          const result = await imapService.saveAttachments({
            emailId: requireString(args, "emailId"),
            outputPath: optionalString(args, "outputPath"),
            includeInline: normalizeBoolean(args.includeInline, false),
            filenameContains: optionalString(args, "filenameContains"),
            contentType: optionalString(args, "contentType"),
          });
          return createTextResult(
            result,
            false,
            result.saved.map((entry) => attachmentSource(result.emailId, entry.attachment)),
          );
        }

        case "clear_cache":
          analyticsService.clearCache();
          return createTextResult({
            clearedAt: new Date().toISOString(),
            ...imapService.clearCache(),
          });

        case "clear_index":
          return createTextResult({
            clearedAt: new Date().toISOString(),
            ...(await localIndexService.clear()),
          });

        case "get_logs":
        {
          const limit = normalizeLimit(args.limit, 100);
          const offset = normalizeLimit(args.offset, 0, 0, 10_000);
          const records = logger.getLogs({
              level:
                args.level === "debug" ||
                args.level === "info" ||
                args.level === "warn" ||
                args.level === "error"
                  ? args.level
                  : undefined,
              limit: limit + offset,
            });
          return createTextResult({
            ...records,
            entries: paginateRecentRecords(records.entries, limit, offset),
          });
        }

        case "get_audit_logs":
        {
          const limit = normalizeLimit(args.limit, 100);
          const offset = normalizeLimit(args.offset, 0, 0, 10_000);
          return createTextResult(
            paginateRecentRecords(await auditService.list(limit + offset), limit, offset),
          );
        }

        default:
          throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      logger.error("Tool call failed", "MCPServer", { name, error });
      if (isLikelyAuthenticationError(error)) {
        throw new McpError(
          ErrorCode.InternalError,
          "IMAP authentication failed. Check that PROTONMAIL_PASSWORD is your Proton Bridge password (not your Proton account password) and that you're signed in inside the Bridge app. Run run_doctor for a full connectivity check.",
        );
      }
      if (isLikelyConnectionError(error)) {
        throw new McpError(
          ErrorCode.InternalError,
          "Could not connect to Proton Bridge. Make sure the Bridge app is running, and that PROTONMAIL_IMAP_HOST/PORT and PROTONMAIL_SMTP_HOST/PORT match the ports shown in Bridge's settings. Run run_doctor for a full connectivity check.",
        );
      }
      // Every throw new Error(...) across src/services and src/utils is a
      // deliberately-worded, actionable message (not-found, validation,
      // policy-disabled, etc.) with no secrets or stack traces in it —
      // surface it directly instead of discarding it into a generic
      // "check get_logs" message that sends the caller on a diagnostic
      // wild goose chase for something that was already fully explained.
      // describeImapError additionally recovers imapflow's real failure
      // reason (its .responseText) for the many call sites that let a raw
      // IMAP NO/BAD response bubble up as a bare "Command failed".
      const message = describeImapError(error)
        ?? "An internal error occurred. Check get_logs for details, or run run_doctor for a full connectivity check.";
      throw new McpError(ErrorCode.InternalError, message);
    }
  });

  return {
    server,
    smtpService,
    imapService,
    localIndexService,
    draftStore,
    backgroundSyncService,
    deliveryQueueService,
    snoozeService,
    auditService,
  };
}

export async function main(): Promise<void> {
  const config = buildConfigFromEnv();
  const { server, smtpService, imapService, backgroundSyncService, deliveryQueueService, snoozeService } = createServer(config, {
    startBackgroundSync: true,
  });

  logger.info("Starting ProtonMail MCP server", "MCPServer");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("ProtonMail MCP server ready", "MCPServer");

  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`Received ${reason}, shutting down`, "MCPServer");
    backgroundSyncService.stop();
    deliveryQueueService.stop();
    snoozeService.stop();
    await Promise.allSettled([imapService.disconnect(), smtpService.close()]);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  // Lifecycle tie to the MCP client: this is a stdio server whose only consumer
  // is the parent process (e.g. Claude Desktop) on the other end of the pipe.
  // When that parent exits it closes our stdin; without this the background-sync
  // timer and IMAP connection keep the event loop alive and the process is
  // reparented to launchd/init and lingers forever (burning CPU). Exit as soon
  // as the pipe closes so no orphan survives its consumer.
  transport.onclose = () => {
    void shutdown("transport-close");
  };
  process.stdin.on("end", () => {
    void shutdown("stdin-end");
  });
  process.stdin.on("close", () => {
    void shutdown("stdin-close");
  });
  // A broken pipe (parent killed abruptly) surfaces as an stdin error rather
  // than a clean end; treat it the same way instead of crashing.
  process.stdin.on("error", (error) => {
    logger.warn("stdin error, shutting down", "MCPServer", error);
    void shutdown("stdin-error");
  });
}

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", "MCPServer", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", "MCPServer", reason);
  process.exit(1);
});

const isDirectExecution = isMainModule(import.meta.url);

if (isDirectExecution) {
  main().catch((error) => {
    logger.error("Fatal server error", "MCPServer", error);
    process.exit(1);
  });
}
