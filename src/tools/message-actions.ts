import { maybeRefreshLocalIndex } from "./index-refresh.js";
import { type AccountBundle } from "../services/account-manager.js";
import { type BatchActionResult, type BatchActionEntry, type BulkMatchCriteria, type BulkOperationResult } from "../types/index.js";
import { bulkFolderOfIds, ensureBulkBatchSize, getBulkMaxBatchSize, groupEmailIdsByAccount, BulkExcludedEmailId, getBulkNotFoundEmailIds, withBulkNotFound, prefixBulkResult, prefixNotFound, mergeBulkResults } from "./bulk.js";
import { buildEmailResourceUri, emailSource, threadSource } from "./resources.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ensureMoveTargetAllowed, isMissingTargetFolderError, applyBatchEmailAction, emailSourceFromActionResult } from "./actions.js";
import { withAudit } from "./audit.js";
import { createTextResult } from "./results.js";
import { requireString, optionalString, parseStringListArg, requireEmailAction } from "./args.js";
import { normalizeBoolean, parseEmailId, withAccountPrefix } from "../utils/helpers.js";
import { ensureEmailActionAllowed, ensureDestructiveConfirmed, ensureMailboxWriteAllowed, ensureFlagChangeAllowed } from "../utils/runtime-policy.js";
import type { ToolContext } from "./context.js";
import type { ToolResult } from "./results.js";

// Single-message actions (read, star, move, archive, trash, restore, delete) and the batch and bulk forms.

export async function handleMessageActionTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { config, accountManager, primaryBundle, auditService, resolveAccountForEmailId, prefixedIdFor, withPrefixedIds, resolveFolderTarget, resolveAccountArg } = ctx;
  switch (name) {
    case "mark_email_read": {
      ensureEmailActionAllowed(
        config.runtime,
        normalizeBoolean(args.isRead, true) ? "mark_read" : "mark_unread",
      );
      const rawEmailId = requireString(args, "emailId");
      const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
      const uidValidity = parseEmailId(emailId).uidValidity;
      return createTextResult(
        withPrefixedIds(
          bundle,
          await withAudit(auditService, name, args, async () =>
            bundle.imapService.markEmailRead(
              emailId,
              normalizeBoolean(args.isRead, true),
              uidValidity,
            ),
          ),
        ),
      );
    }

    case "star_email": {
      ensureEmailActionAllowed(
        config.runtime,
        normalizeBoolean(args.isStarred, true) ? "star" : "unstar",
      );
      const rawEmailId = requireString(args, "emailId");
      const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
      const uidValidity = parseEmailId(emailId).uidValidity;
      return createTextResult(
        withPrefixedIds(
          bundle,
          await withAudit(auditService, name, args, async () =>
            bundle.imapService.starEmail(
              emailId,
              normalizeBoolean(args.isStarred, true),
              uidValidity,
            ),
          ),
        ),
      );
    }

    case "move_email":
    {
      ensureEmailActionAllowed(config.runtime, "move");
      const rawEmailId = requireString(args, "emailId");
      const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
      const targetFolder = requireString(args, "targetFolder");
      await ensureMoveTargetAllowed(config.runtime, bundle.imapService, targetFolder);
      const uidValidity = parseEmailId(emailId).uidValidity;
      const result = await withAudit(auditService, name, args, async () => {
        try {
          return await bundle.imapService.moveEmail(emailId, targetFolder, uidValidity);
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
      const targetEmailId = result.targetEmailId ? prefixedIdFor(bundle, result.targetEmailId) : undefined;
      const sources = targetEmailId
        ? [
            {
              uri: buildEmailResourceUri(targetEmailId),
              name: targetEmailId,
              title: `Moved email ${targetEmailId}`,
              description: `${result.targetFolder} · uid ${result.targetUid || result.uid}`,
              mimeType: "message/rfc822",
            },
          ]
        : [];
      return createTextResult(withPrefixedIds(bundle, { ...result, targetEmailId }), false, sources);
    }

    case "archive_email":
    {
      ensureEmailActionAllowed(config.runtime, "archive");
      const rawEmailId = requireString(args, "emailId");
      const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
      const uidValidity = parseEmailId(emailId).uidValidity;
      const result = await withAudit(auditService, name, args, async () =>
        bundle.imapService.archiveEmail(emailId, uidValidity),
      );
      const targetEmailId = result.targetEmailId ? prefixedIdFor(bundle, result.targetEmailId) : undefined;
      const sources = targetEmailId
        ? [
            {
              uri: buildEmailResourceUri(targetEmailId),
              name: targetEmailId,
              title: `Archived email ${targetEmailId}`,
              description: `${result.targetFolder} · uid ${result.targetUid || result.uid}`,
              mimeType: "message/rfc822",
            },
          ]
        : [];
      return createTextResult(withPrefixedIds(bundle, { ...result, targetEmailId }), false, sources);
    }

    case "trash_email":
    {
      ensureEmailActionAllowed(config.runtime, "trash");
      const rawEmailId = requireString(args, "emailId");
      const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
      const uidValidity = parseEmailId(emailId).uidValidity;
      const result = await withAudit(auditService, name, args, async () =>
        bundle.imapService.trashEmail(emailId, uidValidity),
      );
      const targetEmailId = result.targetEmailId ? prefixedIdFor(bundle, result.targetEmailId) : undefined;
      const sources = targetEmailId
        ? [
            {
              uri: buildEmailResourceUri(targetEmailId),
              name: targetEmailId,
              title: `Trashed email ${targetEmailId}`,
              description: `${result.targetFolder} · uid ${result.targetUid || result.uid}`,
              mimeType: "message/rfc822",
            },
          ]
        : [];
      return createTextResult(withPrefixedIds(bundle, { ...result, targetEmailId }), false, sources);
    }

    case "restore_email":
    {
      ensureEmailActionAllowed(config.runtime, "restore");
      const rawEmailId = requireString(args, "emailId");
      const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
      await ensureMoveTargetAllowed(config.runtime, bundle.imapService, optionalString(args, "targetFolder"));
      const uidValidity = parseEmailId(emailId).uidValidity;
      const result = await withAudit(auditService, name, args, async () =>
        bundle.imapService.restoreEmail(
          emailId,
          optionalString(args, "targetFolder"),
          uidValidity,
        ),
      );
      const targetEmailId = result.targetEmailId ? prefixedIdFor(bundle, result.targetEmailId) : undefined;
      const sources = targetEmailId
        ? [
            {
              uri: buildEmailResourceUri(targetEmailId),
              name: targetEmailId,
              title: `Restored email ${targetEmailId}`,
              description: `${result.targetFolder} · uid ${result.targetUid || result.uid}`,
              mimeType: "message/rfc822",
            },
          ]
        : [];
      return createTextResult(withPrefixedIds(bundle, { ...result, targetEmailId }), false, sources);
    }

    case "delete_email": {
      ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args.confirmed, false), `Permanently delete ${String(args.emailId ?? "?")} (cannot be recovered)`);
      ensureEmailActionAllowed(config.runtime, "delete");
      const rawEmailId = requireString(args, "emailId");
      const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
      const uidValidity = parseEmailId(emailId).uidValidity;
      return createTextResult(
        withPrefixedIds(
          bundle,
          await withAudit(auditService, name, args, async () => bundle.imapService.deleteEmail(emailId, uidValidity)),
        ),
      );
    }

    case "batch_email_action":
    {
      const emailIds = [...new Set(parseStringListArg(args, "emailIds"))];
      if (emailIds.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "emailIds must contain at least one email id.");
      }
      // Same safety rail as the bulk_* tools (bulk_delete etc.) — without
      // it, an arbitrarily large emailIds array would be processed in
      // full with no size limit at all.
      ensureBulkBatchSize(emailIds.length, getBulkMaxBatchSize(args));
      const action = requireEmailAction(args);
      ensureEmailActionAllowed(config.runtime, action);
      if (action === "delete") {
        ensureDestructiveConfirmed(config.runtime, (normalizeBoolean(args.confirmed, false) || normalizeBoolean(args.dryRun, false)), `Permanently delete ${emailIds.length} email(s) (cannot be recovered)`);
      }
      // emailIds can span multiple configured accounts — group them so
      // each account's ids run against that account's own imapService
      // (and get audited to that account's own auditService), then merge
      // the per-group BatchActionResults back into one. continueOnError
      // is honored within each group (as before); across groups, a
      // failure in one account's group still lets independent, unrelated
      // groups for OTHER accounts run — an id in account B failing
      // doesn't block account A's ids, which are on an entirely separate
      // connection anyway.
      const continueOnError = normalizeBoolean(args.continueOnError, true);
      const dryRun = normalizeBoolean(args.dryRun, false);
      const targetFolder = optionalString(args, "targetFolder");
      if (action === "move" || action === "restore") {
        await ensureMoveTargetAllowed(config.runtime, accountManager.all().map((entry) => entry.imapService), targetFolder);
      }
      const groups = groupEmailIdsByAccount(accountManager, emailIds);

      const groupResults: Array<{ slug: string | undefined; result: BatchActionResult }> = [];
      for (const [slug, group] of groups) {
        const entries: BatchActionEntry[] = [];
        const groupResult = await withAudit(group.bundle.auditService, name, args, () =>
          applyBatchEmailAction(group.bundle.imapService, entries, {
            emailIds: group.restIds,
            action,
            targetFolder,
            continueOnError,
            dryRun,
          }),
        );
        groupResults.push({ slug, result: groupResult });
      }

      const outputSlugFor = (slug: string | undefined) => (slug === primaryBundle.account.slug ? undefined : slug);
      const mergedResults: BatchActionEntry[] = groupResults.flatMap(({ slug, result: groupResult }) =>
        groupResult.results.map((entry) => ({ ...entry, emailId: withAccountPrefix(outputSlugFor(slug), entry.emailId) })),
      );
      // Reordered to match the caller's original emailIds order (each
      // group only preserves order within itself) so a mixed-account
      // request's results still line up with the ids the caller passed.
      const byEmailId = new Map(mergedResults.map((entry) => [entry.emailId, entry]));
      const orderedResults = emailIds.flatMap((emailId) => {
        const entry = byEmailId.get(emailId);
        return entry ? [entry] : [];
      });
      const succeeded = orderedResults.filter((entry) => entry.ok).length;
      const notAttempted = groupResults.flatMap(({ slug, result: groupResult }) =>
        (groupResult.notAttempted ?? []).map((id) => withAccountPrefix(outputSlugFor(slug), id)),
      );
      const result: BatchActionResult = {
        action,
        total: orderedResults.length,
        succeeded,
        failed: orderedResults.length - succeeded,
        results: orderedResults,
        ...(notAttempted.length > 0 ? { notAttempted } : {}),
      };

      const sources = result.results.flatMap((entry) =>
        entry.ok ? emailSourceFromActionResult(entry.result) : [],
      );
      return createTextResult(result, false, sources);
    }

    case "update_message_labels": {
      ensureMailboxWriteAllowed(config.runtime);
      const rawEmailId = requireString(args, "emailId");
      const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
      const labelsToAdd = Array.isArray(args.labelsToAdd)
        ? (args.labelsToAdd as unknown[]).map(String)
        : [];
      const labelsToRemove = Array.isArray(args.labelsToRemove)
        ? (args.labelsToRemove as unknown[]).map(String)
        : [];
      if (labelsToAdd.length === 0 && labelsToRemove.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "Provide at least one label in labelsToAdd or labelsToRemove.");
      }
      // undefined for an old-format id (no embedded UIDVALIDITY) —
      // updateMessageLabels's own assertMailboxUidValidity guard already
      // treats that as "unverifiable, don't block on it", same as every
      // other mutation handler below.
      const uidValidity = parseEmailId(emailId).uidValidity;
      const result = await withAudit(auditService, name, args, async () =>
        bundle.imapService.updateMessageLabels(emailId, labelsToAdd, labelsToRemove, uidValidity),
      );
      return createTextResult(result, false, [emailSource({ id: prefixedIdFor(bundle, emailId) } as Parameters<typeof emailSource>[0])]);
    }

    case "update_message_flags": {
      const rawEmailId = requireString(args, "emailId");
      const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
      const flagsToAdd = Array.isArray(args.flagsToAdd)
        ? (args.flagsToAdd as unknown[]).map(String)
        : [];
      const flagsToRemove = Array.isArray(args.flagsToRemove)
        ? (args.flagsToRemove as unknown[]).map(String)
        : [];
      if (flagsToAdd.length === 0 && flagsToRemove.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "Provide at least one flag in flagsToAdd or flagsToRemove.");
      }
      ensureFlagChangeAllowed(config.runtime, flagsToAdd, flagsToRemove, normalizeBoolean(args.confirmed, false));
      const uidValidity = parseEmailId(emailId).uidValidity;
      const result = await withAudit(auditService, name, args, async () =>
        bundle.imapService.updateMessageFlags(emailId, flagsToAdd, flagsToRemove, uidValidity),
      );
      return createTextResult(result, false, [emailSource({ id: prefixedIdFor(bundle, emailId) } as Parameters<typeof emailSource>[0])]);
    }

    case "bulk_move": {
      ensureEmailActionAllowed(config.runtime, "move");
      const emailIds = Array.isArray(args.emailIds)
        ? (args.emailIds as unknown[]).map(String) : undefined;
      const match = args.match && typeof args.match === "object"
        ? (args.match as BulkMatchCriteria) : undefined;
      if (emailIds && emailIds.length === 0) throw new McpError(ErrorCode.InvalidParams, "emailIds must contain at least one email id.");
      if (!emailIds && !match) throw new McpError(ErrorCode.InvalidParams, "Provide emailIds or match.");
      if (emailIds && match) throw new McpError(ErrorCode.InvalidParams, "Provide emailIds OR match, not both.");
      // A call that selects by `match` works in one account: the `account` argument, or the "<slug>::" prefix on the
      // folder (as get_folders shows it), else the primary. Ids carry their own account.
      const requestedFolder = optionalString(args, "folder");
      const folderOwner = requestedFolder ? resolveFolderTarget(args, requestedFolder) : undefined;
      const matchBundle = folderOwner ? folderOwner.bundle : (resolveAccountArg(args) ?? primaryBundle);
      const matchSlug = matchBundle === primaryBundle ? undefined : matchBundle.account.slug;
      const explicitFolder = folderOwner ? folderOwner.paths[0] : undefined;
      const targetFolder = requireString(args, "targetFolder");
      const max = getBulkMaxBatchSize(args);
      const dryRun = normalizeBoolean(args.dryRun, false);

      // emailIds can span multiple configured accounts (a "<slug>::"
      // prefix names one; a plain id is the primary's) — group them so
      // each account's ids resolve/run against that account's own
      // imapService, then merge the per-group results back below. A
      // match-only call (no emailIds) works in the account it names
      // (`account`, or a prefixed folder), else the primary.
      const groups = emailIds
        ? groupEmailIdsByAccount(accountManager, emailIds)
        : new Map<string | undefined, { bundle: AccountBundle; restIds: string[] | undefined }>([
            [matchSlug, { bundle: matchBundle, restIds: undefined }],
          ]);
      // Whether the target is a Trash folder is a question about the accounts this call touches, not about every account.
      await ensureMoveTargetAllowed(config.runtime, [...groups.values()].map((group) => group.bundle.imapService), targetFolder);

      let totalUids = 0;
      const prepared: Array<{
        slug: string | undefined;
        bundle: AccountBundle;
        notFound: BulkExcludedEmailId[];
        run: () => Promise<BulkOperationResult>;
      }> = [];
      for (const [slug, group] of groups) {
        // Each account's ids say their own folder, so ids from different accounts may sit in different folders.
        const folder = bulkFolderOfIds(explicitFolder, group.restIds);
        // Only fetched (an extra STATUS round trip) when there are ids to
        // check against it — a match-only bulk_move has no ids that could
        // be stale, since match resolves directly against the live
        // mailbox each time.
        const currentUidValidity = await group.bundle.imapService.getMailboxUidValidity(folder);
        const notFoundEmailIds = getBulkNotFoundEmailIds(group.restIds, folder, currentUidValidity);
        // Resolve the match/emailIds set exactly once and reuse it for both
        // the preview and the real run — see resolveUidsForBulkOp's
        // comment for why re-resolving `match` a second time (the old
        // dry-run-then-real-run pattern) could silently exceed maxBatchSize.
        // Also excludes any id whose embedded UIDVALIDITY is stale.
        const uids = await group.bundle.imapService.resolveUidsForBulkOp(folder, group.restIds, match, currentUidValidity);
        totalUids += uids.length;
        prepared.push({
          slug,
          bundle: group.bundle,
          notFound: notFoundEmailIds,
          run: () =>
            group.bundle.imapService.bulkMove({
              emailIds: group.restIds,
              match,
              folder,
              targetFolder,
              resolvedUids: uids,
              uidValidity: currentUidValidity,
              dryRun,
            }),
        });
      }
      ensureBulkBatchSize(totalUids, max);

      const outputs: BulkOperationResult[] = [];
      for (const group of prepared) {
        const outputSlug = group.slug === primaryBundle.account.slug ? undefined : group.slug;
        const raw = dryRun ? await group.run() : await withAudit(group.bundle.auditService, name, args, group.run);
        outputs.push(withBulkNotFound(prefixBulkResult(raw, outputSlug), prefixNotFound(group.notFound, outputSlug)));
      }
      return createTextResult(mergeBulkResults(outputs));
    }

    case "bulk_delete": {
      const permanent = normalizeBoolean(args.permanent, false);
      if (permanent) ensureDestructiveConfirmed(config.runtime, (normalizeBoolean(args.confirmed, false) || normalizeBoolean(args.dryRun, false)), "Permanently delete multiple emails");
      // Same distinction as delete_email/delete_thread: a non-permanent
      // bulk_delete only moves messages to Trash, so it's gated as
      // "trash" (which a policy may allow independently of "delete").
      ensureEmailActionAllowed(config.runtime, permanent ? "delete" : "trash");
      const emailIds = Array.isArray(args.emailIds)
        ? (args.emailIds as unknown[]).map(String) : undefined;
      const match = args.match && typeof args.match === "object"
        ? (args.match as BulkMatchCriteria) : undefined;
      if (emailIds && emailIds.length === 0) throw new McpError(ErrorCode.InvalidParams, "emailIds must contain at least one email id.");
      if (!emailIds && !match) throw new McpError(ErrorCode.InvalidParams, "Provide emailIds or match.");
      if (emailIds && match) throw new McpError(ErrorCode.InvalidParams, "Provide emailIds OR match, not both.");
      // A call that selects by `match` works in one account: the `account` argument, or the "<slug>::" prefix on the
      // folder (as get_folders shows it), else the primary. Ids carry their own account.
      const requestedFolder = optionalString(args, "folder");
      const folderOwner = requestedFolder ? resolveFolderTarget(args, requestedFolder) : undefined;
      const matchBundle = folderOwner ? folderOwner.bundle : (resolveAccountArg(args) ?? primaryBundle);
      const matchSlug = matchBundle === primaryBundle ? undefined : matchBundle.account.slug;
      const explicitFolder = folderOwner ? folderOwner.paths[0] : undefined;
      const max = getBulkMaxBatchSize(args);
      const dryRun = normalizeBoolean(args.dryRun, false);

      // emailIds can span multiple configured accounts — group them so
      // each account's ids resolve/run against that account's own
      // imapService, then merge the per-group results back below. See
      // bulk_move's identical grouping comment. A match-only call stays
      // scoped to the primary account, unchanged.
      const groups = emailIds
        ? groupEmailIdsByAccount(accountManager, emailIds)
        : new Map<string | undefined, { bundle: AccountBundle; restIds: string[] | undefined }>([
            [matchSlug, { bundle: matchBundle, restIds: undefined }],
          ]);

      let totalUids = 0;
      const prepared: Array<{
        slug: string | undefined;
        bundle: AccountBundle;
        notFound: BulkExcludedEmailId[];
        run: () => Promise<BulkOperationResult>;
      }> = [];
      for (const [slug, group] of groups) {
        // Each account's ids say their own folder, so ids from different accounts may sit in different folders.
        const folder = bulkFolderOfIds(explicitFolder, group.restIds);
        // Fetched once, up front, and reused for both the notFound
        // reporting below and resolveUidsForBulkOp's own filtering — a
        // single shared point-in-time value, same "resolve once" spirit
        // as the uids resolution itself, so the ids this call reports as
        // excluded and the uids it actually acts on can never disagree
        // about which generation was current. Only fetched when there are
        // ids to check against it (a match-only call has none).
        const currentUidValidity = await group.bundle.imapService.getMailboxUidValidity(folder);
        const notFoundEmailIds = getBulkNotFoundEmailIds(group.restIds, folder, currentUidValidity);
        // Resolve the match/emailIds set exactly once and reuse it for both
        // the preview and the real run — see resolveUidsForBulkOp's
        // comment for why re-resolving `match` a second time (the old
        // dry-run-then-real-run pattern) could silently exceed maxBatchSize.
        // Also excludes any id whose embedded UIDVALIDITY is stale — see
        // resolveUidsForBulkOp's comment.
        const uids = await group.bundle.imapService.resolveUidsForBulkOp(folder, group.restIds, match, currentUidValidity);
        totalUids += uids.length;
        prepared.push({
          slug,
          bundle: group.bundle,
          notFound: notFoundEmailIds,
          run: () =>
            group.bundle.imapService.bulkDelete({
              emailIds: group.restIds,
              match,
              folder,
              permanent,
              resolvedUids: uids,
              uidValidity: currentUidValidity,
              dryRun,
            }),
        });
      }
      ensureBulkBatchSize(totalUids, max);

      const outputs: BulkOperationResult[] = [];
      for (const group of prepared) {
        const outputSlug = group.slug === primaryBundle.account.slug ? undefined : group.slug;
        const raw = dryRun ? await group.run() : await withAudit(group.bundle.auditService, name, args, group.run);
        outputs.push(withBulkNotFound(prefixBulkResult(raw, outputSlug), prefixNotFound(group.notFound, outputSlug)));
      }
      return createTextResult(mergeBulkResults(outputs));
    }

    case "bulk_update_flags": {
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
      ensureFlagChangeAllowed(config.runtime, flagsToAdd, flagsToRemove, normalizeBoolean(args.confirmed, false));
      // A call that selects by `match` works in one account: the `account` argument, or the "<slug>::" prefix on the
      // folder (as get_folders shows it), else the primary. Ids carry their own account.
      const requestedFolder = optionalString(args, "folder");
      const folderOwner = requestedFolder ? resolveFolderTarget(args, requestedFolder) : undefined;
      const matchBundle = folderOwner ? folderOwner.bundle : (resolveAccountArg(args) ?? primaryBundle);
      const matchSlug = matchBundle === primaryBundle ? undefined : matchBundle.account.slug;
      const explicitFolder = folderOwner ? folderOwner.paths[0] : undefined;
      const max = getBulkMaxBatchSize(args);
      const dryRun = normalizeBoolean(args.dryRun, false);

      // emailIds can span multiple configured accounts — group them so
      // each account's ids resolve/run against that account's own
      // imapService, then merge the per-group results back below. See
      // bulk_move's identical grouping comment. A match-only call stays
      // scoped to the primary account, unchanged.
      const groups = emailIds
        ? groupEmailIdsByAccount(accountManager, emailIds)
        : new Map<string | undefined, { bundle: AccountBundle; restIds: string[] | undefined }>([
            [matchSlug, { bundle: matchBundle, restIds: undefined }],
          ]);

      let totalUids = 0;
      const prepared: Array<{
        slug: string | undefined;
        bundle: AccountBundle;
        notFound: BulkExcludedEmailId[];
        run: () => Promise<BulkOperationResult>;
      }> = [];
      for (const [slug, group] of groups) {
        // Each account's ids say their own folder, so ids from different accounts may sit in different folders.
        const folder = bulkFolderOfIds(explicitFolder, group.restIds);
        // See the bulk_delete case above for why this is fetched once and
        // shared between notFound reporting and uid resolution.
        const currentUidValidity = await group.bundle.imapService.getMailboxUidValidity(folder);
        const notFoundEmailIds = getBulkNotFoundEmailIds(group.restIds, folder, currentUidValidity);
        // Resolve the match/emailIds set exactly once and reuse it for both
        // the preview and the real run — see resolveUidsForBulkOp's
        // comment for why re-resolving `match` a second time (the old
        // dry-run-then-real-run pattern) could silently exceed maxBatchSize.
        // Also excludes any id whose embedded UIDVALIDITY is stale.
        const uids = await group.bundle.imapService.resolveUidsForBulkOp(folder, group.restIds, match, currentUidValidity);
        totalUids += uids.length;
        prepared.push({
          slug,
          bundle: group.bundle,
          notFound: notFoundEmailIds,
          run: () =>
            group.bundle.imapService.bulkUpdateFlags({
              emailIds: group.restIds,
              match,
              folder,
              flagsToAdd,
              flagsToRemove,
              resolvedUids: uids,
              uidValidity: currentUidValidity,
              dryRun,
            }),
        });
      }
      ensureBulkBatchSize(totalUids, max);

      const outputs: BulkOperationResult[] = [];
      for (const group of prepared) {
        const outputSlug = group.slug === primaryBundle.account.slug ? undefined : group.slug;
        const raw = dryRun ? await group.run() : await withAudit(group.bundle.auditService, name, args, group.run);
        outputs.push(withBulkNotFound(prefixBulkResult(raw, outputSlug), prefixNotFound(group.notFound, outputSlug)));
      }
      return createTextResult(mergeBulkResults(outputs));
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
      // A call that selects by `match` works in one account: the `account` argument, or the "<slug>::" prefix on the
      // folder (as get_folders shows it), else the primary. Ids carry their own account.
      const requestedFolder = optionalString(args, "folder");
      const folderOwner = requestedFolder ? resolveFolderTarget(args, requestedFolder) : undefined;
      const matchBundle = folderOwner ? folderOwner.bundle : (resolveAccountArg(args) ?? primaryBundle);
      const matchSlug = matchBundle === primaryBundle ? undefined : matchBundle.account.slug;
      const explicitFolder = folderOwner ? folderOwner.paths[0] : undefined;
      const max = getBulkMaxBatchSize(args);
      const dryRun = normalizeBoolean(args.dryRun, false);

      // emailIds can span multiple configured accounts — group them so
      // each account's ids resolve/run against that account's own
      // imapService, then merge the per-group results back below. See
      // bulk_move's identical grouping comment. A match-only call stays
      // scoped to the primary account, unchanged.
      const groups = emailIds
        ? groupEmailIdsByAccount(accountManager, emailIds)
        : new Map<string | undefined, { bundle: AccountBundle; restIds: string[] | undefined }>([
            [matchSlug, { bundle: matchBundle, restIds: undefined }],
          ]);

      let totalUids = 0;
      const prepared: Array<{
        slug: string | undefined;
        bundle: AccountBundle;
        notFound: BulkExcludedEmailId[];
        run: () => Promise<BulkOperationResult>;
      }> = [];
      for (const [slug, group] of groups) {
        // Each account's ids say their own folder, so ids from different accounts may sit in different folders.
        const folder = bulkFolderOfIds(explicitFolder, group.restIds);
        // See the bulk_delete case above for why this is fetched once and
        // shared between notFound reporting and uid resolution.
        const currentUidValidity = await group.bundle.imapService.getMailboxUidValidity(folder);
        const notFoundEmailIds = getBulkNotFoundEmailIds(group.restIds, folder, currentUidValidity);
        // Resolve the match/emailIds set exactly once and reuse it for both
        // the preview and the real run — see resolveUidsForBulkOp's
        // comment for why re-resolving `match` a second time (the old
        // dry-run-then-real-run pattern) could silently exceed maxBatchSize.
        // Also excludes any id whose embedded UIDVALIDITY is stale.
        const uids = await group.bundle.imapService.resolveUidsForBulkOp(folder, group.restIds, match, currentUidValidity);
        totalUids += uids.length;
        prepared.push({
          slug,
          bundle: group.bundle,
          notFound: notFoundEmailIds,
          run: () =>
            group.bundle.imapService.bulkUpdateLabels({
              emailIds: group.restIds,
              match,
              folder,
              labelsToAdd,
              labelsToRemove,
              resolvedUids: uids,
              uidValidity: currentUidValidity,
              dryRun,
            }),
        });
      }
      ensureBulkBatchSize(totalUids, max);

      const outputs: BulkOperationResult[] = [];
      for (const group of prepared) {
        const outputSlug = group.slug === primaryBundle.account.slug ? undefined : group.slug;
        const raw = dryRun ? await group.run() : await withAudit(group.bundle.auditService, name, args, group.run);
        outputs.push(withBulkNotFound(prefixBulkResult(raw, outputSlug), prefixNotFound(group.notFound, outputSlug)));
      }
      return createTextResult(mergeBulkResults(outputs));
    }

    case "move_thread": {
      ensureEmailActionAllowed(config.runtime, "move");
      // A threadId only ever names ONE account — a thread can't span
      // multiple mailboxes/accounts — so this reuses
      // resolveAccountForEmailId's generic "<slug>::" prefix stripping
      // (it doesn't care that the string is an emailId vs a threadId) to
      // route the whole call to that account's own imapService/
      // auditService. A plain, unprefixed threadId keeps going to the
      // primary account, unchanged. Full cross-account thread resolution
      // (e.g. a match/threading key that could resolve differently per
      // account) is out of scope for this pass.
      const { bundle, rest: messageId } = resolveAccountForEmailId(requireString(args, "messageId"));
      await ensureMoveTargetAllowed(config.runtime, bundle.imapService, requireString(args, "destination"));
      const result = await withAudit(bundle.auditService, name, args, () =>
        bundle.imapService.moveThread({
          messageId,
          destination: requireString(args, "destination"),
          acrossFolders: normalizeBoolean(args.acrossFolders, false),
          dryRun: normalizeBoolean(args.dryRun, false),
          maxBatchSize: getBulkMaxBatchSize(args),
        })
      );
      return createTextResult(result);
    }

    case "delete_thread": {
      const permanentThread = normalizeBoolean(args.permanent, false);
      if (permanentThread) ensureDestructiveConfirmed(config.runtime, (normalizeBoolean(args.confirmed, false) || normalizeBoolean(args.dryRun, false)), "Permanently delete thread");
      // Same "trash" vs "delete" distinction as bulk_delete above.
      ensureEmailActionAllowed(config.runtime, permanentThread ? "delete" : "trash");
      // See move_thread's comment on scoping by the threadId's own
      // "<slug>::" prefix — same convention, same single-account
      // limitation.
      const { bundle, rest: messageId } = resolveAccountForEmailId(requireString(args, "messageId"));
      const result = await withAudit(bundle.auditService, name, args, () =>
        bundle.imapService.deleteThread({
          messageId,
          permanent: permanentThread,
          acrossFolders: normalizeBoolean(args.acrossFolders, false),
          dryRun: normalizeBoolean(args.dryRun, false),
          maxBatchSize: getBulkMaxBatchSize(args),
        })
      );
      return createTextResult(result);
    }

    case "flag_thread": {
      const flagsToAdd = Array.isArray(args.flagsToAdd) ? (args.flagsToAdd as unknown[]).map(String) : [];
      const flagsToRemove = Array.isArray(args.flagsToRemove) ? (args.flagsToRemove as unknown[]).map(String) : [];
      if (flagsToAdd.length === 0 && flagsToRemove.length === 0) throw new McpError(ErrorCode.InvalidParams, "Provide flagsToAdd or flagsToRemove.");
      ensureFlagChangeAllowed(config.runtime, flagsToAdd, flagsToRemove, normalizeBoolean(args.confirmed, false));
      // See move_thread's comment on scoping by the threadId's own
      // "<slug>::" prefix — same convention, same single-account
      // limitation.
      const { bundle, rest: messageId } = resolveAccountForEmailId(requireString(args, "messageId"));
      const result = await withAudit(bundle.auditService, name, args, () =>
        bundle.imapService.flagThread({
          messageId,
          flagsToAdd,
          flagsToRemove,
          acrossFolders: normalizeBoolean(args.acrossFolders, false),
          dryRun: normalizeBoolean(args.dryRun, false),
          maxBatchSize: getBulkMaxBatchSize(args),
        })
      );
      return createTextResult(result);
    }

    case "apply_thread_action":
    {
      // A threadId only ever names ONE account — see move_thread's
      // identical comment on reusing resolveAccountForEmailId's generic
      // "<slug>::" prefix stripping for threadIds. Every message in the
      // resolved thread therefore belongs to this same account, so
      // (unlike batch_email_action's emailIds) there is nothing to
      // group — the whole action runs against this one bundle's own
      // imapService/localIndexService/auditService. Full cross-account
      // thread resolution is out of scope for this pass.
      const { bundle, rest: threadId } = resolveAccountForEmailId(requireString(args, "threadId"));
      const outputSlug = bundle.account.slug === primaryBundle.account.slug ? undefined : bundle.account.slug;
      await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, {
        force: normalizeBoolean(args.syncBefore, false),
        folder: "INBOX",
        limitPerFolder: 100,
      });

      const thread = await bundle.localIndexService.getThreadById(threadId);
      const action = requireEmailAction(args);
      ensureEmailActionAllowed(config.runtime, action);
      if (action === "move" || action === "restore") {
        await ensureMoveTargetAllowed(config.runtime, bundle.imapService, optionalString(args, "targetFolder"));
      }
      const unreadOnly = normalizeBoolean(args.unreadOnly, false);
      const emailIds = [...new Set(
        thread.messages
          .filter((message) => !unreadOnly || !message.isRead)
          .map((message) => message.primaryEmailId),
      )];
      // Same safety rail as the bulk_* tools (bulk_delete etc.) — without
      // it, a thread with an arbitrarily large message count would be
      // processed in full with no size limit at all.
      ensureBulkBatchSize(emailIds.length, getBulkMaxBatchSize(args));
      if (action === "delete") {
        ensureDestructiveConfirmed(config.runtime, (normalizeBoolean(args.confirmed, false) || normalizeBoolean(args.dryRun, false)), `Permanently delete ${emailIds.length} email(s) in thread (cannot be recovered)`);
      }

      const result = await withAudit(bundle.auditService, name, args, async () =>
        applyBatchEmailAction(bundle.imapService, [], {
          emailIds,
          action,
          targetFolder: optionalString(args, "targetFolder"),
          continueOnError: normalizeBoolean(args.continueOnError, true),
          dryRun: normalizeBoolean(args.dryRun, false),
        }),
      );
      const prefixedResult: BatchActionResult = {
        ...result,
        results: result.results.map((entry) => ({ ...entry, emailId: withAccountPrefix(outputSlug, entry.emailId) })),
      };

      const sources = [
        threadSource(thread),
        ...result.results.flatMap((entry) => (entry.ok ? emailSourceFromActionResult(entry.result) : [])),
      ];

      return createTextResult(
        {
          threadId: withAccountPrefix(outputSlug, thread.id),
          unreadOnly,
          dryRun: normalizeBoolean(args.dryRun, false),
          ...prefixedResult,
        },
        false,
        sources,
      );
    }

    default:
      throw new Error(`handleMessageActionTool: unexpected tool ${name}`);
  }
}
