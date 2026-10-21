// The bulk tools' shared rules: batch size limit, ids that were not found, grouping ids by account and merging the results.

import { AccountManager, type AccountBundle } from "../services/account-manager.js";
import { type BulkOperationResult } from "../types/index.js";
import { UID_VALIDITY_MISMATCH_ERROR } from "../services/simple-imap-service.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { InvalidArgumentError, normalizeLimit, parseEmailId, splitAccountPrefix, withAccountPrefix } from "../utils/helpers.js";
export function getBulkMaxBatchSize(args: Record<string, unknown>): number {
  return normalizeLimit(args.maxBatchSize, 500, 1, 2000);
}

export function ensureBulkBatchSize(uidsLength: number, max: number): void {
  if (uidsLength > max) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "Batch size " + uidsLength + " exceeds limit " + max + ". Use match criteria to narrow the scope, or increase maxBatchSize.",
    );
  }
}

export interface BulkExcludedEmailId {
  emailId: string;
  error: string;
}

// `currentUidValidity` is optional and, when omitted, preserves the exact
// original behavior (folder/format check only) — every caller that already
// knows the folder's current UIDVALIDITY (the bulk_delete/bulk_update_flags/
// bulk_update_labels handlers below, via a single shared getMailboxUidValidity
// call reused for both this and resolveUidsForBulkOp) should pass it, so a
// stale-generation id gets its own clear error instead of being lumped in
// with a genuinely malformed one.
export function getBulkNotFoundEmailIds(
  emailIds: string[] | undefined,
  folder: string,
  currentUidValidity?: string,
): BulkExcludedEmailId[] {
  if (!emailIds) {
    return [];
  }

  const excluded: BulkExcludedEmailId[] = [];
  for (const emailId of emailIds) {
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
    let parsed: ReturnType<typeof parseEmailId>;
    try {
      parsed = parseEmailId(emailId);
    } catch {
      excluded.push({ emailId, error: "Email ID could not be resolved to a UID." });
      continue;
    }
    if (parsed.folder !== folder) {
      excluded.push({ emailId, error: "Email ID could not be resolved to a UID." });
      continue;
    }
    // An id with no embedded uidValidity (pre-this-fix format) is
    // unverifiable, not stale — same "can't check it, so don't block on
    // it" stance assertMailboxUidValidity already takes for the
    // single-message mutation path. Only a *checkable* mismatch is
    // treated as a stale reference. resolveUidsForBulkOp applies this
    // exact same exclusion (see its own comment) against the exact same
    // currentUidValidity value, so the uid this method silently drops from
    // execution and the id this method reports as excluded here always
    // agree.
    if (
      currentUidValidity !== undefined &&
      parsed.uidValidity !== undefined &&
      parsed.uidValidity !== currentUidValidity
    ) {
      excluded.push({ emailId, error: UID_VALIDITY_MISMATCH_ERROR });
    }
  }
  return excluded;
}

export function withBulkNotFound(
  result: BulkOperationResult,
  excludedEmailIds: BulkExcludedEmailId[],
): BulkOperationResult {
  if (excludedEmailIds.length === 0) {
    return result;
  }

  return {
    ...result,
    total: result.total + excludedEmailIds.length,
    notFound: result.notFound + excludedEmailIds.length,
    results: [
      ...result.results,
      ...excludedEmailIds.map(({ emailId, error }) => ({
        uid: 0,
        emailId,
        ok: false,
        error,
      })),
    ],
  };
}

// Groups a bulk/batch tool's emailIds array by the account each id's optional
// "<slug>::" prefix names (see splitAccountPrefix/resolveAccountForEmailId),
// so bulk_delete/bulk_move/bulk_update_flags/bulk_update_labels/
// batch_email_action can run each account's ids against that account's own
// SimpleIMAPService instance instead of always hitting the primary bundle's
// shared `imapService`. Map key is the resolved account slug (undefined for
// the primary account — the same "no prefix" convention as everywhere else),
// so results can be merged back with each entry's original, possibly
// prefixed, emailId.
export function groupEmailIdsByAccount(
  accountManager: AccountManager,
  emailIds: string[],
): Map<string | undefined, { bundle: AccountBundle; restIds: string[] }> {
  const groups = new Map<string | undefined, { bundle: AccountBundle; restIds: string[] }>();
  for (const emailId of emailIds) {
    const { accountSlug, rest } = splitAccountPrefix(emailId, accountManager.additionalSlugs());
    let group = groups.get(accountSlug);
    if (!group) {
      group = { bundle: accountManager.bySlugOrPrimary(accountSlug), restIds: [] };
      groups.set(accountSlug, group);
    }
    group.restIds.push(rest);
  }
  return groups;
}

// The folder a bulk call works in. Given, it wins. Otherwise the ids say: an id carries its folder, so ids from Archive
// are looked up in Archive, not in INBOX. Ids from several folders are refused instead of guessed (pass `folder`, or split
// the call). With no ids (a `match`) it is INBOX, as before.
export function bulkFolder(accountManager: AccountManager, explicit: string | undefined, emailIds: string[] | undefined): string {
  if (explicit) return explicit;
  if (!emailIds?.length) return "INBOX";
  const folders = new Set<string>();
  for (const id of emailIds) {
    try {
      folders.add(parseEmailId(splitAccountPrefix(id, accountManager.additionalSlugs()).rest).folder);
    } catch {
      // not a readable id: it is reported as not found below, where it always was
    }
  }
  if (folders.size === 0) return "INBOX";
  if (folders.size > 1) {
    throw new InvalidArgumentError(`These ids are in different folders (${[...folders].join(", ")}). Pass folder, or split the call.`);
  }
  return [...folders][0];
}

// Re-applies a group's account-slug prefix to every emailId a BulkOperationResult
// or notFound entry references — those are built inside SimpleIMAPService (or from
// the group's own restIds), which knows nothing about account slugs, so the prefix
// stripped off when grouping (groupEmailIdsByAccount) must be put back before the
// per-group results are merged into the single response the tool returns.
export function prefixBulkResult(result: BulkOperationResult, slug: string | undefined): BulkOperationResult {
  if (!slug) {
    return result;
  }
  return {
    ...result,
    results: result.results.map((entry) => ({ ...entry, emailId: withAccountPrefix(slug, entry.emailId) })),
  };
}

export function prefixNotFound(excluded: BulkExcludedEmailId[], slug: string | undefined): BulkExcludedEmailId[] {
  if (!slug) {
    return excluded;
  }
  return excluded.map((entry) => ({ ...entry, emailId: withAccountPrefix(slug, entry.emailId) }));
}

// Merges the per-account-group BulkOperationResults produced by the bulk_*
// handlers into the single combined shape the tool actually returns.
export function mergeBulkResults(results: BulkOperationResult[]): BulkOperationResult {
  return results.reduce((acc, result) => ({
    dryRun: acc.dryRun || result.dryRun,
    total: acc.total + result.total,
    succeeded: acc.succeeded + result.succeeded,
    failed: acc.failed + result.failed,
    notFound: acc.notFound + result.notFound,
    results: [...acc.results, ...result.results],
  }), { dryRun: false, total: 0, succeeded: 0, failed: 0, notFound: 0, results: [] } as BulkOperationResult);
}
