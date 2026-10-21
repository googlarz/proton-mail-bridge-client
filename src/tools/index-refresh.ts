// Keeping the local index fresh for the tools that read it: refresh before a search or a digest, with a time limit, and a probe that tells whether a folder changed.

import { type EmailSummary } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { type AccountBundle } from "../services/account-manager.js";
import { LocalIndexService } from "../services/local-index-service.js";
import { SimpleIMAPService } from "../services/simple-imap-service.js";
export async function ensureFreshLocalIndex(
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
    folderListComplete: true,
    emails: snapshot.emails,
    syncedAt: snapshot.syncedAt,
    folderStats: snapshot.folderStats,
  });

  return {
    snapshot,
    indexStatus,
  };
}

export async function mailboxChangedSinceCheckpoint(
  imapService: Pick<SimpleIMAPService, "getFolderStats">,
  localIndexService: Pick<LocalIndexService, "getSyncCheckpointMap">,
  folder: string,
): Promise<boolean> {
  try {
    const checkpoint = (await localIndexService.getSyncCheckpointMap())[folder];
    if (!checkpoint) {
      return true;
    }
    const live = await imapService.getFolderStats(folder);
    return (
      (live.uidNext !== undefined && checkpoint.uidNext !== undefined && live.uidNext !== checkpoint.uidNext) ||
      (checkpoint.total !== undefined && live.total !== checkpoint.total) ||
      // A backfill/catch-up cursor still pending means the index is knowingly incomplete.
      checkpoint.incrementalResumeUid !== undefined
    );
  } catch {
    return false;
  }
}

// Bounded, best-effort refresh before an indexed search. The IMAP probe has connect timeouts
// but nothing bounds a Bridge that accepts the connection and then stalls, and the point of
// the indexed search is to answer without Bridge. So: give up after a few seconds, and after a
// failure skip the probe for a while instead of paying the timeout on every search.
export const SEARCH_REFRESH_TIMEOUT_MS = 3_000;

export const SEARCH_REFRESH_BACKOFF_MS = 60_000;

export const searchRefreshSkipUntil = new WeakMap<AccountBundle, number>();

export async function refreshIndexForSearch(bundle: AccountBundle): Promise<void> {
  const slug = bundle.account.slug;
  if (Date.now() < (searchRefreshSkipUntil.get(bundle) ?? 0)) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, { folder: "INBOX", limitPerFolder: 100 }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`refresh did not finish in ${SEARCH_REFRESH_TIMEOUT_MS} ms`)), SEARCH_REFRESH_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    searchRefreshSkipUntil.set(bundle, Date.now() + SEARCH_REFRESH_BACKOFF_MS);
    logger.warn("search_indexed_emails: refresh skipped, serving the local index", "MCPServer", {
      account: slug,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function maybeRefreshLocalIndex(
  imapService: SimpleIMAPService,
  localIndexService: LocalIndexService,
  input: {
    force?: boolean;
    folder?: string;
    full?: boolean;
    limitPerFolder?: number;
  } = {},
) {
  // The triage tools ask for "INBOX", but with Proton filters most mail lands in other folders. Refresh the
  // folders the account actually indexes (its autoSyncFolder list) instead of INBOX alone.
  const folders =
    input.folder === "INBOX" && typeof imapService.getSyncFolderList === "function"
      ? imapService.getSyncFolderList()
      : input.folder
        ? [input.folder]
        : undefined;
  const status = await localIndexService.getFreshness();
  if (!input.force && status.storedMessageCount > 0 && !status.isStale) {
    // Not stale by age, but age alone cannot see mail that arrived since the last sync
    // (background sync/IDLE may be off, failing, or not covering this account). Compare the
    // server's UIDNEXT/MESSAGES for each folder with the stored checkpoint (a single STATUS)
    // and refresh only those that differ. A failed probe never blocks serving the index.
    const changed: string[] = [];
    for (const folder of folders ?? ["INBOX"]) {
      if (await mailboxChangedSinceCheckpoint(imapService, localIndexService, folder)) changed.push(folder);
    }
    if (changed.length === 0) {
      return undefined;
    }
    // Only the folders that moved, so refresh only those. An unscoped refresh here would
    // sync EVERY folder (with attachment text) whenever a single INBOX message arrives — the
    // pattern that used to blow past the client's 60 s request timeout.
    return ensureFreshLocalIndex(imapService, localIndexService, {
      folder: changed.join(","),
      full: input.full,
      limitPerFolder: input.limitPerFolder ?? 100,
    });
  }

  return ensureFreshLocalIndex(imapService, localIndexService, {
    folder: folders?.join(","),
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
export async function getAnalyticsSampleFromIndex(
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

// --- Multi-account fan-out helpers (2.2.0) -------------------------------
//
// Every helper below is only ever invoked from the ">1 configured account"
// branch of its call site; the "exactly 1 account" branch always keeps
// running the original single-bundle code path unchanged, so a
// single-account setup produces byte-for-byte the same response it always
// did. These helpers exist purely to keep each case-block's merge logic
// short and readable.
