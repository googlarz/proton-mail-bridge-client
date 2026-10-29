import { PACKAGE_VERSION } from "../package-info.js";
import { paginateRecentRecords } from "./merge.js";
import { logger } from "../utils/logger.js";
import { optionalString } from "./args.js";
import { describeImapError, isLikelyAuthenticationError, isLikelyCertificateError, isLikelyTlsMismatchError, isLikelyConnectionError } from "../services/simple-imap-service.js";
import { normalizeBoolean, normalizeLimit, optionalBoolean, optionalInteger } from "../utils/helpers.js";
import { sanitizeRuntimeConfig, ensureMailboxWriteAllowed } from "../utils/runtime-policy.js";
import { healthProblems } from "../utils/health.js";
import { fileURLToPath } from "node:url";
import { createTextResult } from "./results.js";
import type { ToolContext } from "./context.js";
import type { ToolResult } from "./results.js";

// Status, health checks, logs, caches and the sync tools: what the server knows about itself and its connection to Bridge.

export async function handleDiagnosticTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { config, accountManager, primaryBundle, smtpService, imapService, analyticsService, auditService, localIndexService, draftStore, backgroundSyncService, resolveAccountArg } = ctx;
  switch (name) {
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

    case "get_runtime_status": {
      const [indexStatus, drafts] = await Promise.all([
        localIndexService.getStatus(),
        draftStore.listDrafts(true),
      ]);
      // Per-account breakdown, purely additive alongside every existing top-level
      // field above (which keep describing the PRIMARY account only, unchanged, for
      // backward compatibility) — same shape list_accounts already returns, index
      // status only (no live connection check here — this tool is meant to be fast,
      // unlike run_doctor).
      const accountsInfo = await Promise.all(
        accountManager.all().map(async (bundle) => {
          const accountIndexStatus = await bundle.localIndexService.getStatus();
          return {
            slug: bundle.account.slug,
            address: bundle.account.address,
            isPrimary: bundle.account.slug === primaryBundle.account.slug,
            index: { storedMessageCount: accountIndexStatus.storedMessageCount, updatedAt: accountIndexStatus.updatedAt, isStale: accountIndexStatus.isStale },
            backgroundSync: bundle.backgroundSyncService.getStatus(),
            health: healthProblems(bundle.backgroundSyncService.getStatus(), accountIndexStatus),
          };
        }),
      );
      return createTextResult({
        checkedAt: new Date().toISOString(),
        runtime: sanitizeRuntimeConfig(config.runtime),
        backgroundSync: backgroundSyncService.getStatus(),
        health: healthProblems(backgroundSyncService.getStatus(), indexStatus),
        imapIdle: imapService.getIdleStatus(),
        index: indexStatus,
        audit: {
          enabled: true,
        },
        drafts: {
          total: drafts.length,
          active: drafts.filter((draft) => draft.status !== "sent").length,
          remoteSynced: drafts.filter((draft) => draft.remoteSyncState === "synced").length,
          syncFailed: drafts.filter((draft) => draft.remoteSyncState === "sync_failed").length,
        },
        accounts: accountsInfo,
      });
    }

    case "list_accounts": {
      const checkConnections = normalizeBoolean(args.checkConnections, false);
      const accountsInfo = await Promise.all(
        accountManager.all().map(async (bundle) => {
          const [indexStatus, connection] = await Promise.all([
            bundle.localIndexService.getStatus(),
            checkConnections
              ? Promise.allSettled([bundle.smtpService.verifyConnection(), bundle.imapService.ping()]).then(
                  ([smtpResult, imapResult]) => ({
                    smtp: smtpResult.status === "fulfilled" ? { ok: true } : { ok: false, error: describeImapError(smtpResult.reason) },
                    imap: imapResult.status === "fulfilled" ? { ok: true } : { ok: false, error: describeImapError(imapResult.reason) },
                  }),
                )
              : Promise.resolve(undefined),
          ]);
          return {
            slug: bundle.account.slug,
            address: bundle.account.address,
            isPrimary: bundle.account.slug === accountManager.primary().account.slug,
            imapUsername: bundle.account.imap.username,
            smtpUsername: bundle.account.smtp.username,
            dataDir: bundle.account.dataDir,
            index: { storedMessageCount: indexStatus.storedMessageCount, updatedAt: indexStatus.updatedAt, isStale: indexStatus.isStale },
            connection,
          };
        }),
      );
      return createTextResult({
        checkedAt: new Date().toISOString(),
        total: accountsInfo.length,
        accounts: accountsInfo,
        note: "Prefix an emailId/draftId with '<slug>::' to target a non-primary account in any other tool; a plain id always means the primary account.",
      });
    }

    case "run_background_sync":
    {
      const target = resolveAccountArg(args) ?? primaryBundle;
      return createTextResult({
        checkedAt: new Date().toISOString(),
        backgroundSync: await target.backgroundSyncService.runNow(),
        index: await target.localIndexService.getStatus(),
      });

    }

    case "wait_for_mailbox_changes":
    {
      const target = resolveAccountArg(args) ?? primaryBundle;
      return createTextResult(
        await target.imapService.waitForMailboxChanges({
          folder: optionalString(args, "folder"),
          timeoutMs: normalizeLimit(args.timeoutSeconds, 15, 1, 300) * 1000,
        }),
      );
    }

    case "get_index_status":
    {
      const statusBundle = resolveAccountArg(args) ?? primaryBundle;
      const indexStatus = await statusBundle.localIndexService.getStatus();
      const syncCfg = statusBundle.backgroundSyncService.getStatus();
      return createTextResult({
        ...indexStatus,
        // What keeps this index current, so a stale/missing message can be explained:
        // only these folders are synced in the background, and IDLE watches just the first.
        backgroundSync: {
          enabled: syncCfg.enabled,
          intervalMinutes: syncCfg.intervalMinutes,
          folders: syncCfg.folder,
          idleWatching: syncCfg.idleWatching,
          lastSuccessAt: syncCfg.lastSuccessAt,
          lastError: syncCfg.lastError,
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
              // autoSyncFolder is a comma-separated list ("INBOX,Sent") for
              // the periodic index sync, but IMAP IDLE can only watch one
              // mailbox per connection (same constraint documented on
              // BackgroundSyncService's primaryIdleFolder). Passing the raw
              // multi-folder string through made every run_doctor
              // includeIdleProbe:true call try to SELECT a literal mailbox
              // named "INBOX,Sent" and fail — reproduced live, 100% of the
              // time with the default config.
              folder: config.runtime.autoSyncFolder?.split(",")[0]?.trim() || "INBOX",
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
        if (isLikelyCertificateError(reason)) {
          return {
            cause: "certificate_untrusted",
            suggestion:
              "Bridge's certificate is not trusted. Bridge presents a self-signed certificate made for localhost, which is accepted for 127.0.0.1, localhost and ::1. For another host name (another container, another machine) set PROTONMAIL_TLS_CA_FILE to Bridge's exported certificate, or list the host in PROTONMAIL_TLS_INSECURE_HOSTS.",
          };
        }
        // Checked before the generic connection-error case: an EPROTO/
        // "wrong version number" is unambiguous evidence of a TLS-mode
        // mismatch, distinct from Bridge simply being unreachable.
        if (isLikelyTlsMismatchError(reason)) {
          return {
            cause: "tls_mismatch",
            suggestion:
              "TLS handshake failed against a plaintext/STARTTLS port. PROTONMAIL_IMAP_SECURE/PROTONMAIL_SMTP_SECURE likely doesn't match the security mode of the port in Bridge's Mailbox details (implicit TLS vs STARTTLS) — check both against Bridge's IMAP/SMTP port settings.",
          };
        }
        if (isLikelyConnectionError(reason)) {
          return {
            cause: "bridge_unreachable",
            suggestion:
              "Proton Bridge isn't reachable on the configured host/port, OR (if this is ECONNRESET) a TLS-mode mismatch in the other direction — plaintext attempted against an implicit-TLS port. Make sure the Bridge app is running, that PROTONMAIL_IMAP_HOST/PORT and PROTONMAIL_SMTP_HOST/PORT match Bridge's Mailbox details, and that PROTONMAIL_IMAP_SECURE/PROTONMAIL_SMTP_SECURE match the security mode shown there.",
          };
        }
        return undefined;
      };

      // Per-account breakdown, purely additive alongside every existing top-level
      // field above (which keep describing the PRIMARY account only, unchanged, for
      // backward compatibility) — same shape list_accounts already returns, plus a
      // live connection check reusing that same checkConnections pattern, gated on
      // this tool's own includeSmtp/includeImap flags.
      const accountsInfo = await Promise.all(
        accountManager.all().map(async (bundle) => {
          const [accountIndexStatus, connection] = await Promise.all([
            bundle.localIndexService.getStatus(),
            includeSmtp || includeImap
              ? Promise.allSettled([
                  includeSmtp ? bundle.smtpService.verifyConnection() : Promise.resolve(undefined),
                  includeImap ? bundle.imapService.ping() : Promise.resolve(undefined),
                ]).then(([smtpResult, imapResult]) => ({
                  smtp: !includeSmtp
                    ? undefined
                    : smtpResult.status === "fulfilled" ? { ok: true } : { ok: false, error: describeImapError(smtpResult.reason) },
                  imap: !includeImap
                    ? undefined
                    : imapResult.status === "fulfilled" ? { ok: true } : { ok: false, error: describeImapError(imapResult.reason) },
                }))
              : Promise.resolve(undefined),
          ]);
          return {
            slug: bundle.account.slug,
            address: bundle.account.address,
            isPrimary: bundle.account.slug === primaryBundle.account.slug,
            index: { storedMessageCount: accountIndexStatus.storedMessageCount, updatedAt: accountIndexStatus.updatedAt, isStale: accountIndexStatus.isStale },
            connection,
          };
        }),
      );

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
                  // smtp/imap above both attach this; idleProbe never did,
                  // so an idle-specific failure (e.g. the wrong-folder bug
                  // just fixed above) gave no actionable next step despite
                  // this tool's own description promising one.
                  diagnosis: diagnoseFailure(idleProbe.reason),
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
        accounts: accountsInfo,
      });
    }

    case "clear_cache":
      // Zero policy gate: this mutates local cache state, but nothing here
      // ever checked read-only mode.
      ensureMailboxWriteAllowed(config.runtime);
      analyticsService.clearCache();
      return createTextResult({
        clearedAt: new Date().toISOString(),
        ...imapService.clearCache(),
      });

    case "clear_index":
      // Zero policy gate — same gap as clear_cache, see its comment.
      ensureMailboxWriteAllowed(config.runtime);
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

    case "verify_audit_log":
      return createTextResult(await auditService.verify());

    case "sync_emails":
    {
      const target = resolveAccountArg(args) ?? primaryBundle;
      const folder = optionalString(args, "folder");
      const full = optionalBoolean(args.full);
      const limitPerFolder = optionalInteger(args.limitPerFolder, 1, 50_000);
      const includeAttachmentText =
        optionalBoolean(args.includeAttachmentText);

      // target.backgroundSyncService.runNow() always runs the *fixed* background-
      // sync config (autoSyncFolder/autoSyncFull/autoSyncLimitPerFolder —
      // typically just "INBOX,Sent", incremental, 100/folder) and ignores
      // any argument entirely. This tool's own schema advertises folder/
      // full/limitPerFolder/includeAttachmentText as per-call overrides,
      // but every one of them was silently discarded — a caller asking to
      // sync "Archive" with full:true got back a status snapshot of the
      // last INBOX/Sent background run, with Archive never touched at
      // all. Found live: sync_emails({folder:"Archive", full:true}) did
      // not add an Archive entry to get_index_status's syncCheckpoints.
      // When the caller supplies any of these, run a one-off sync with
      // their actual parameters instead.
      if (folder !== undefined || full !== undefined || limitPerFolder !== undefined || includeAttachmentText !== undefined) {
        // Commit each folder to the index as soon as it is fetched (rather than one
        // recordSnapshot after ALL folders), and stop starting new folders once the time
        // budget is spent. Before this, a full sync over many folders that hit the
        // client's request timeout lost everything it had already fetched and gave the
        // caller no way to tell what had synced. The default budget sits below typical
        // 60s MCP client timeouts; a single folder in flight still runs to completion.
        const budgetMs = normalizeLimit(args.timeBudgetSeconds, 45, 1, 300) * 1000;
        const startedAtMs = Date.now();
        const snapshot = await target.imapService.collectEmailsForIndex({
          folder,
          full,
          limitPerFolder,
          includeAttachmentText,
          checkpoints: await target.localIndexService.getSyncCheckpointMap(),
          deadlineAt: startedAtMs + budgetMs,
          onFolderCollected: async (batch) => {
            await target.localIndexService.recordSnapshot({
              folders: [],
              emails: batch.emails,
              syncedAt: batch.checkpoint.lastSyncAt ?? new Date().toISOString(),
              folderStats: [batch.checkpoint],
            });
          },
        });
        // Final commit carries the complete folder list (folder counts, pruning of folders
        // deleted server-side) — no messages, those were committed per folder above.
        const indexStatus = await target.localIndexService.recordSnapshot({
          folders: snapshot.folders,
          folderListComplete: true,
          emails: [],
          syncedAt: snapshot.syncedAt,
          folderStats: [],
        });
        return createTextResult({
          checkedAt: new Date().toISOString(),
          complete: snapshot.complete,
          remainingFolders: snapshot.remainingFolders,
          ...(snapshot.failedFolders.length > 0 ? { failedFolders: snapshot.failedFolders } : {}),
          ...(snapshot.skippedFolders.length > 0 ? { skippedFolders: snapshot.skippedFolders } : {}),
          elapsedMs: Date.now() - startedAtMs,
          budgetMs,
          ...(snapshot.complete
            ? {}
            : { note: "Time budget reached; completed folders are already committed. Call sync_emails again with the same arguments to continue with remainingFolders." }),
          synced: {
            folder: folder ?? "all",
            full: Boolean(full),
            complete: snapshot.complete,
            remainingFolders: snapshot.remainingFolders,
            folderStats: snapshot.folderStats,
            // Per-folder progress: `moreHistory` is true while a full sync is still walking
            // backward through history or an incremental catch-up cursor is pending.
            folderProgress: snapshot.folderStats.map((stat) => ({
              folder: stat.folder,
              fetched: stat.fetched ?? 0,
              total: stat.total,
              strategy: stat.strategy,
              moreHistory:
                stat.incrementalResumeUid !== undefined ||
                (Boolean(full) && stat.backfilledToUid !== undefined && stat.backfilledToUid > 1),
            })),
          },
          index: {
            updatedAt: indexStatus.updatedAt,
            storedMessageCount: indexStatus.storedMessageCount,
            dedupedMessageCount: indexStatus.dedupedMessageCount,
            path: indexStatus.path,
          },
        });
      }

      const syncStatus = await target.backgroundSyncService.runNow("sync_emails");
      const indexStatus = await target.localIndexService.getStatus();
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

    default:
      throw new Error(`handleDiagnosticTool: unexpected tool ${name}`);
  }
}
