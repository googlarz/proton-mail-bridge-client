import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { normalizeBoolean, normalizeLimit, optionalBoolean, optionalNumber, splitAccountPrefix } from "../utils/helpers.js";
import { withAudit } from "./audit.js";
import { requireString, optionalString } from "./args.js";
import { ensureMailboxWriteAllowed, ensureEmailActionAllowed, ensureDestructiveConfirmed } from "../utils/runtime-policy.js";
import { accountSlugForTag, describeAccountFailure, mergeMailboxLabels } from "./merge.js";
import { createTextResult } from "./results.js";
import type { ToolContext } from "./context.js";
import type { ToolResult } from "./results.js";

// Folders and labels: list, create, rename, delete, statistics, counts, and emptying a folder.

export async function handleFolderTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { config, accountManager, primaryBundle, imapService, auditService, localIndexService, resolveAccountArg, resolveFolderTarget, selectedBundles } = ctx;
  switch (name) {
    case "get_folders": {
      if (accountManager.all().length === 1) {
        resolveAccountArg(args);
        return createTextResult(await imapService.getFolders());
      }
      // Merge strategy: fetch each account's own folder list (LIVE IMAP) and
      // tag each folder's path with its account slug (except the primary's,
      // which is left bare) so the merged list stays unambiguous while a
      // single-account setup's own folder paths are completely untouched.
      const primarySlug = accountManager.primary().account.slug;
      const perAccount = await Promise.all(
        selectedBundles(args).map(async (bundle) => ({ bundle, folders: await bundle.imapService.getFolders() })),
      );
      const merged = perAccount.flatMap(({ bundle, folders }) =>
        folders.map((folder) => {
          const slug = accountSlugForTag(bundle, primarySlug);
          return slug ? { ...folder, path: `${slug}::${folder.path}`, account: slug } : folder;
        }),
      );
      return createTextResult(merged);
    }

    case "sync_folders":
      return createTextResult(await (resolveAccountArg(args) ?? primaryBundle).imapService.syncFolders());

    case "create_folder": {
      ensureMailboxWriteAllowed(config.runtime);
      const { bundle: folderBundle, paths: [folderPath] } = resolveFolderTarget(args, requireString(args, "path"));
      return createTextResult(
        await withAudit(folderBundle.auditService, name, args, async () =>
          folderBundle.imapService.createFolder(folderPath),
        ),
      );
    }

    case "rename_folder": {
      ensureMailboxWriteAllowed(config.runtime);
      const { bundle: folderBundle, paths: [fromPath, toPath] } = resolveFolderTarget(args, requireString(args, "path"), requireString(args, "newPath"));
      return createTextResult(
        await withAudit(folderBundle.auditService, name, args, async () =>
          folderBundle.imapService.renameFolder(fromPath, toPath),
        ),
      );
    }

    case "delete_folder": {
      ensureEmailActionAllowed(config.runtime, "delete");
      const { bundle: folderBundle, paths: [folderPath] } = resolveFolderTarget(args, requireString(args, "path"));
      ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args?.confirmed, false), "Permanently delete folder and all messages in it: " + requireString(args, "path"));
      return createTextResult(
        await withAudit(folderBundle.auditService, name, args, async () =>
          folderBundle.imapService.deleteFolder(folderPath),
        ),
      );
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
      ensureEmailActionAllowed(config.runtime, "delete");
      const rawName = requireString(args, "name");
      if (!rawName.trim()) throw new McpError(ErrorCode.InvalidParams, "Label name cannot be empty.");
      const labelPath = rawName.startsWith("Labels/") ? rawName : `Labels/${rawName}`;
      ensureDestructiveConfirmed(config.runtime, normalizeBoolean(args?.confirmed, false), "Permanently delete label: " + labelPath);
      const result = await withAudit(auditService, name, args, () =>
        imapService.deleteFolder(labelPath)
      );
      return createTextResult(result);
    }

    case "folder_stats": {
      const requestedStatsFolder = optionalString(args, "folder");
      // A "<slug>::" prefix on the folder names the account, like the account argument.
      const statsOwner = requestedStatsFolder ? resolveFolderTarget(args, requestedStatsFolder) : undefined;
      const statsPrefixed = requestedStatsFolder ? splitAccountPrefix(requestedStatsFolder, accountManager.additionalSlugs()).accountSlug : undefined;
      const statsNamed = resolveAccountArg(args) ?? (statsPrefixed ? statsOwner?.bundle : undefined);
      const folderStatsFolder = statsOwner ? statsOwner.paths[0] : requestedStatsFolder;
      if (accountManager.all().length === 1) {
        resolveAccountArg(args);
        const result = await imapService.getFolderStats(folderStatsFolder);
        return createTextResult(result);
      }
      // Merge strategy: fetch stats for the same folder in every account and
      // sum the numeric fields (total/unseen); uidNext/uidValidity are
      // per-account concepts and only make sense in the breakdown.
      // One account lacking the folder (or unreachable) must not fail the whole call: report it and return the rest.
      // Every account failing still throws.
      const statsBundles = statsNamed ? [statsNamed] : accountManager.all();
      const settledStats = await Promise.allSettled(
        statsBundles.map(async (bundle) => ({
          slug: bundle.account.slug,
          ...(await bundle.imapService.getFolderStats(folderStatsFolder)),
        })),
      );
      const perAccount = settledStats.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []));
      if (perAccount.length === 0) throw (settledStats[0] as PromiseRejectedResult).reason;
      const failedStats = settledStats.flatMap((entry, index) =>
        entry.status === "rejected"
          ? [{ account: statsBundles[index].account.slug, error: describeAccountFailure(entry.reason) }]
          : [],
      );
      return createTextResult({
        folder: folderStatsFolder ?? "INBOX",
        total: perAccount.reduce((sum, entry) => sum + entry.total, 0),
        unseen: perAccount.reduce((sum, entry) => sum + entry.unseen, 0),
        ...(failedStats.length > 0 ? { failedAccounts: failedStats } : {}),
        byAccount: perAccount,
      });
    }

    case "empty_folder": {
      if (!config.runtime.allowEmptyFolder) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "empty_folder is disabled. Set PROTONMAIL_ALLOW_EMPTY_FOLDER=true to enable.",
        );
      }
      ensureEmailActionAllowed(config.runtime, "delete");
      const { bundle: emptyBundle, paths: [folder] } = resolveFolderTarget(args, requireString(args, "folder"));
      const confirmed = normalizeBoolean(args.confirmed, false);
      if (!confirmed) {
        ensureDestructiveConfirmed(config.runtime, confirmed, "Delete all messages in folder " + folder);
        const stats = await emptyBundle.imapService.getFolderStats(folder);
        return createTextResult({
          preview: true,
          folder,
          wouldDelete: stats.total,
          message: `This would permanently delete ${stats.total} messages from "${folder}". Call again with confirmed:true to execute.`,
        });
      }
      ensureDestructiveConfirmed(config.runtime, confirmed, "Delete all messages in folder " + folder);
      const result = await withAudit(emptyBundle.auditService, name, args, async () =>
        emptyBundle.imapService.emptyFolder(folder),
      );
      return createTextResult(result);
    }

    case "get_labels":
    {
      const labelsLimit = normalizeLimit(args.limit, 250);
      if (accountManager.all().length === 1) {
        resolveAccountArg(args);
        const labels = await localIndexService.getLabels(labelsLimit);
        return createTextResult({
          total: labels.length,
          labels,
        });
      }
      // Merge strategy: fetch each account's own label list and sum
      // messageCount/unreadCount/threadCount for labels that share the same
      // name+type across accounts, so e.g. "INBOX" folders from two accounts
      // combine into one row rather than appearing as unrelated duplicates.
      const perAccountLabels = await Promise.all(
        selectedBundles(args).map((bundle) => bundle.localIndexService.getLabels(labelsLimit)),
      );
      const mergedLabels = mergeMailboxLabels(perAccountLabels).slice(0, labelsLimit);
      return createTextResult({
        total: mergedLabels.length,
        labels: mergedLabels,
      });
    }

    case "count_messages": {
      const countInput = {
        folder: optionalString(args, "folder"),
        query: optionalString(args, "query"),
        from: optionalString(args, "from"),
        to: optionalString(args, "to"),
        subject: optionalString(args, "subject"),
        hasAttachment:
          optionalBoolean(args.hasAttachment),
        label: optionalString(args, "label"),
        threadId: optionalString(args, "threadId"),
        senderDomain: optionalString(args, "senderDomain"),
        isRead: optionalBoolean(args.isRead),
        isStarred: optionalBoolean(args.isStarred),
        dateFrom: optionalString(args, "dateFrom"),
        dateTo: optionalString(args, "dateTo"),
        sizeLarger: optionalNumber(args.sizeLarger, 0, Number.MAX_SAFE_INTEGER),
        sizeSmaller: optionalNumber(args.sizeSmaller, 0, Number.MAX_SAFE_INTEGER),
      };
      if (accountManager.all().length === 1) {
        resolveAccountArg(args);
        const result = await imapService.countMessages(countInput);
        return createTextResult(result);
      }
      // Merge strategy: count in every account's mailbox and sum — folder is
      // reported from the request (all accounts are counted against the same
      // folder name), with a per-account breakdown alongside the total.
      // One account lacking the folder or label (or unreachable) must not fail the whole count, as in
      // search_emails: report it and return the rest. Every account failing still throws.
      const settled = await Promise.allSettled(
        selectedBundles(args).map(async (bundle) => ({
          slug: bundle.account.slug,
          ...(await bundle.imapService.countMessages(countInput)),
        })),
      );
      const perAccount = settled.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []));
      if (perAccount.length === 0) {
        throw (settled[0] as PromiseRejectedResult).reason;
      }
      const failedAccounts = settled.flatMap((entry, index) =>
        entry.status === "rejected"
          ? [{ account: selectedBundles(args)[index].account.slug, error: describeAccountFailure(entry.reason) }]
          : [],
      );
      return createTextResult({
        folder: countInput.folder ?? "INBOX",
        count: perAccount.reduce((sum, entry) => sum + entry.count, 0),
        ...(perAccount.some((entry) => entry.approximate) ? { approximate: true } : {}),
        ...(failedAccounts.length > 0 ? { failedAccounts } : {}),
        byAccount: perAccount,
      });
    }

    default:
      throw new Error(`handleFolderTool: unexpected tool ${name}`);
  }
}
