import type { AccountConfig, ProtonMailConfig } from "../types/index.js";
import { logger as defaultLogger, type Logger } from "../utils/logger.js";
import { SimpleIMAPService } from "./simple-imap-service.js";
import { SMTPService } from "./smtp-service.js";
import { LocalIndexService } from "./local-index-service.js";
import { DraftStoreService } from "./draft-store-service.js";
import { DeliveryQueueService } from "./delivery-queue-service.js";
import { SnoozeService } from "./snooze-service.js";
import { AuditService } from "./audit-service.js";
import { ReplyReminderService } from "./reply-reminder-service.js";
import { TemplateService } from "./template-service.js";
import { BackgroundSyncService } from "./background-sync-service.js";
import { AutoresponderService } from "./autoresponder-service.js";
import { ensureSendAllowed } from "../utils/runtime-policy.js";

// One account's complete, self-contained service stack — identical in shape to what
// createServer() builds once for a single account, now built once per configured
// account. Every field here is fully isolated: its own IMAP/SMTP connection, its own
// dataDir (so its own SQLite index, drafts.json, snoozed.json, delivery-queue.json,
// audit.log, templates.json, and account.json identity marker). Reusing the existing,
// already-hardened single-account classes unmodified — rather than adding an
// account dimension inside each of them — means every account gets the full benefit
// of the isolation/locking/TOCTOU work already done on those classes, with zero new
// code paths for that to get wrong per account.
export interface AccountBundle {
  account: AccountConfig;
  config: ProtonMailConfig;
  imapService: SimpleIMAPService;
  smtpService: SMTPService;
  localIndexService: LocalIndexService;
  draftStore: DraftStoreService;
  deliveryQueueService: DeliveryQueueService;
  snoozeService: SnoozeService;
  auditService: AuditService;
  templateService: TemplateService;
  replyReminderService: ReplyReminderService;
  backgroundSyncService: BackgroundSyncService;
  autoresponderService: AutoresponderService;
}

function buildAccountBundle(
  account: AccountConfig,
  baseConfig: ProtonMailConfig,
  log: Logger,
): AccountBundle {
  // Same runtime/debug/sync policy as the primary account (there is only one
  // PROTONMAIL_* runtime configuration for this server process) — only the
  // connection and storage location differ per account.
  const config: ProtonMailConfig = {
    ...baseConfig,
    imap: account.imap,
    smtp: account.smtp,
    dataDir: account.dataDir,
    runtime: account.autoSyncFolder ? { ...baseConfig.runtime, autoSyncFolder: account.autoSyncFolder } : baseConfig.runtime,
  };

  const smtpService = new SMTPService(config);
  const imapService = new SimpleIMAPService(config, log, config.runtime.opDelayMs);
  const auditService = new AuditService(config);
  const localIndexService = new LocalIndexService(config, log);
  const draftStore = new DraftStoreService(config, log);
  const deliveryQueueService = new DeliveryQueueService(config, smtpService, log);
  deliveryQueueService.setDraftStore(draftStore);
  const snoozeService = new SnoozeService(config, imapService, log);
  const templateService = new TemplateService(config, log);
  const replyReminderService = new ReplyReminderService(config, log);
  const backgroundSyncService = new BackgroundSyncService(config, imapService, localIndexService, log);
  const autoresponderService = new AutoresponderService(config, log);

  // The note this address adds to what it sends while its automatic reply is active.
  smtpService.setOutgoingNoteProvider(() => autoresponderService.outgoingNoteNow());
  // Replies go out after a sync has indexed new mail, and only when the runtime lets this server send at all and does
  // not confine mail to the user's own addresses (an automatic reply goes to whoever wrote).
  backgroundSyncService.setNewMailHandler(async (emails) => {
    try {
      ensureSendAllowed(config.runtime);
    } catch {
      return;
    }
    if (config.runtime.restrictOutboundToSelf) return;
    const own = [...new Set([account.address, config.smtp.username, config.imap.username])];
    const outcome = await autoresponderService.process(emails, own, async (reply) => {
      await smtpService.sendEmail({
        to: [reply.to],
        subject: reply.subject,
        body: reply.body,
        inReplyTo: reply.inReplyTo,
        references: reply.references,
        headers: reply.headers,
        appendSignature: false,
      });
      try {
        await auditService.record({
          timestamp: new Date().toISOString(),
          tool: "autoresponder_reply",
          status: "success",
          input: { to: reply.to, subject: reply.subject },
        });
      } catch {
        // bookkeeping only
      }
    });
    if (outcome.replied.length > 0) {
      log.info("Autoresponder replied", "AutoresponderService", { account: account.slug, replies: outcome.replied.length });
    }
  });

  return {
    account,
    config,
    imapService,
    smtpService,
    localIndexService,
    draftStore,
    deliveryQueueService,
    snoozeService,
    auditService,
    templateService,
    replyReminderService,
    backgroundSyncService,
    autoresponderService,
  };
}

// Owns one AccountBundle per configured account (config.accounts[0] is always the
// primary) and resolves email-id account prefixes (see splitAccountPrefix in
// utils/helpers.ts) back to the right bundle. Every read/write tool that needs to act
// on a specific account goes through this instead of holding its own service
// references directly.
export class AccountManager {
  private readonly bySlug = new Map<string, AccountBundle>();
  private readonly primarySlug: string;

  constructor(config: ProtonMailConfig, log: Logger = defaultLogger) {
    if (config.accounts.length === 0) {
      throw new Error("ProtonMailConfig.accounts must contain at least the primary account.");
    }
    this.primarySlug = config.accounts[0].slug;
    for (const account of config.accounts) {
      if (this.bySlug.has(account.slug)) {
        throw new Error(
          `Duplicate account slug "${account.slug}" (from address "${account.address}") — configured account addresses must be unique.`,
        );
      }
      this.bySlug.set(account.slug, buildAccountBundle(account, config, log));
    }
    // A scheduled send's source draft may live in a different account's store than the
    // queue that sends it (see DeliveryQueueRecord.sourceDraftStoreSlug).
    for (const bundle of this.bySlug.values()) {
      bundle.deliveryQueueService.setDraftStoreResolver((slug) => this.bySlug.get(slug)?.draftStore);
    }
  }

  primary(): AccountBundle {
    return this.bySlug.get(this.primarySlug) as AccountBundle;
  }

  all(): AccountBundle[] {
    return [...this.bySlug.values()];
  }

  additional(): AccountBundle[] {
    return this.all().filter((bundle) => bundle.account.slug !== this.primarySlug);
  }

  slugs(): string[] {
    return [...this.bySlug.keys()];
  }

  // Non-primary slugs only — used with splitAccountPrefix so a bare (unprefixed) id
  // always resolves to the primary account, exactly as it did before multi-account
  // support existed.
  additionalSlugs(): string[] {
    return this.additional().map((bundle) => bundle.account.slug);
  }

  bySlugOrPrimary(slug: string | undefined): AccountBundle {
    if (!slug) {
      return this.primary();
    }
    const bundle = this.bySlug.get(slug);
    if (!bundle) {
      throw new Error(`Unknown account "${slug}".`);
    }
    return bundle;
  }

  byAddress(address: string): AccountBundle | undefined {
    const lower = address.trim().toLowerCase();
    return this.all().find((bundle) => bundle.account.address.toLowerCase() === lower);
  }
}
