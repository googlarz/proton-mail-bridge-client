import { ensureMailboxWriteAllowed } from "../utils/runtime-policy.js";
import { withAudit } from "./audit.js";
import { buildThreadBrief } from "./actions.js";
import { type ActionableThreadSummary, type EmailAddress, type ThreadDetail } from "../types/index.js";
import { refreshIndexForSearch, maybeRefreshLocalIndex, getAnalyticsSampleFromIndex } from "./index-refresh.js";
import { type AccountBundle } from "../services/account-manager.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { assessMail } from "../utils/mail-security.js";
import { formatEmailDetailOutput, extractUnsubscribeInfo } from "./compose.js";
import { describeAccountFailure, accountSlugForTag, sortByDateDesc, paginateMergedAccountResults, trimThreadsToBudget, paginationFields, tagAccountIds, THREAD_LIST_RESPONSE_BUDGET_CHARS, mergeCountedEntries, mergeContactStats, mergeVolumeTrends } from "./merge.js";
import { emailSource, attachmentSource, threadSource } from "./resources.js";
import { createTextResult } from "./results.js";
import { optionalString, parseFieldsArg, requireString, parseStringListArg } from "./args.js";
import { normalizeLimit, optionalInteger, normalizeBoolean, projectFields, withAccountPrefix, optionalBoolean, optionalNumber, splitAccountPrefix, trimAttachmentsForListing } from "../utils/helpers.js";
import type { ToolContext } from "./context.js";
import type { ToolResult } from "./results.js";

// Reading and searching mail, threads and statistics: lists, single messages, search (live and indexed), digests, follow-ups, contacts, volume, and exporting or importing a message.

const MAX_IMPORT_MESSAGE_BYTES = 50 * 1024 * 1024;
const MAX_QUERY_VARIANTS = 8;
const RRF_K = 60;

export async function handleReadingTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { config, accountManager, imapService, analyticsService, auditService, localIndexService, resolveAccountArg, resolveFolderTarget, selectedBundles, evaluateReminders, resolveAccountForEmailId, prefixedIdFor, slugForBundle, taint } = ctx;
  switch (name) {
    case "get_emails": {
      const effectiveLimit = normalizeLimit(args.limit, 50);
      // A "<slug>::" prefix on the folder (as get_folders shows it) names the account, like the account argument; the two
      // must not name different accounts.
      const requestedFolder = optionalString(args, "folder");
      const folderOwner = requestedFolder ? resolveFolderTarget(args, requestedFolder) : undefined;
      const prefixedSlug = requestedFolder ? splitAccountPrefix(requestedFolder, accountManager.additionalSlugs()).accountSlug : undefined;
      const namedAccount = resolveAccountArg(args) ?? (prefixedSlug ? folderOwner?.bundle : undefined);
      const getEmailsInput = {
        folder: folderOwner ? folderOwner.paths[0] : requestedFolder,
        limit: effectiveLimit,
        offset: optionalInteger(args.offset, 0, 1_000_000),
        beforeUid: typeof args?.beforeUid === "number" ? args.beforeUid : undefined,
        sortByUid: (args?.sortByUid === "asc" || args?.sortByUid === "desc" ? args.sortByUid : undefined) as "asc" | "desc" | undefined,
        includeSnippet: normalizeBoolean(args.includeSnippet, false),
      };
      if (accountManager.all().length === 1) {
        resolveAccountArg(args);
        const result = await imapService.getEmails(getEmailsInput);
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
      const getEmailsBundles = namedAccount ? [namedAccount] : accountManager.all();
      // Merge strategy: an `offset` applied separately to each account's own page
      // BEFORE merging is wrong — e.g. offset=25,limit=25 (page 2) would skip each
      // account's own first 25 messages independently, then concatenate their
      // page-2 results, which is not the same as page 2 of the globally-merged,
      // newest-first timeline (found live with interleaved messages across two
      // accounts: page 2 skipped the second-newest message overall). Fixed by
      // always fetching from offset 0 up to (requestedOffset + limit) from EVERY
      // account — enough that each account's true contribution to the global top
      // (requestedOffset + limit) is fully captured, since getEmails already
      // returns newest-first — then merging, re-sorting, and applying the
      // requested offset/limit to that merged superset instead of per account.
      const primarySlug = accountManager.primary().account.slug;
      const requestedOffset = getEmailsInput.offset ?? 0;
      // +1 beyond what's strictly needed to fill the page: whether that extra
      // item actually comes back is what tells us hasMore, independent of any
      // filter (beforeUid etc.) or of how the raw mailbox total compares to the
      // page window. Two things were tried and each broke a different case:
      // (1) using mergedAll.length > offset+limit as hasMore, with NO extra
      // overfetch — a lopsided distribution (e.g. 300 messages in one account,
      // 0 in another) fetches exactly offset+limit from the big account, so
      // mergedAll.length can never exceed that window even though hundreds
      // more exist, reporting hasMore:false wrongly.
      // (2) using the raw summed mailbox `total` for hasMore instead — correct
      // for that case, but wrong under a restrictive filter like beforeUid:
      // `total` is the UNFILTERED mailbox message count, not the count of
      // messages actually matching the filter, so a beforeUid narrowing 300
      // messages down to 2 matches still compared against total=300 and
      // reported hasMore:true with nothing left to page to.
      // Fetching one extra item fixes both: it directly observes whether a
      // NEXT matching item exists, under whatever filter is active, rather
      // than inferring it from a count that can be either capped-by-fetch or
      // filter-blind depending on which one you pick.
      const perAccountFetchLimit = requestedOffset + effectiveLimit + 1;
      // One account lacking the folder (or unreachable) must not fail the whole page: report it and return the rest,
      // as count_messages and search_emails do. Every account failing still throws.
      const settledEmails = await Promise.allSettled(
        getEmailsBundles.map(async (bundle) => {
          const result = await bundle.imapService.getEmails({ ...getEmailsInput, offset: 0, limit: perAccountFetchLimit });
          return { bundle, result };
        }),
      );
      const perAccount = settledEmails.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []));
      if (perAccount.length === 0) throw (settledEmails[0] as PromiseRejectedResult).reason;
      const failedAccounts = settledEmails.flatMap((entry, index) =>
        entry.status === "rejected"
          ? [{ account: getEmailsBundles[index].account.slug, error: describeAccountFailure(entry.reason) }]
          : [],
      );
      const taggedEmails = perAccount.flatMap(({ bundle, result }) =>
        result.emails.map((email) => ({ ...email, id: withAccountPrefix(accountSlugForTag(bundle, primarySlug), email.id) })),
      );
      const mergedAll = sortByDateDesc(taggedEmails, (email) => email.internalDate || email.date);
      const { page: merged, hasMore } = paginateMergedAccountResults(mergedAll, requestedOffset, effectiveLimit);
      const total = perAccount.reduce((sum, { result }) => sum + result.total, 0);
      return createTextResult(
        {
          folder: getEmailsInput.folder?.trim() || "INBOX",
          total,
          limit: effectiveLimit,
          offset: requestedOffset,
          emails: projectFields(merged, parseFieldsArg(args.fields)),
          returned: merged.length,
          hasMore,
          ...(failedAccounts.length > 0 ? { failedAccounts } : {}),
          byAccount: perAccount.map(({ bundle, result }) => ({ slug: bundle.account.slug, total: result.total })),
        },
        false,
        merged.map(emailSource),
      );
    }

    case "get_email_by_id": {
      const rawEmailId = requireString(args, "emailId");
      const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
      const detail = await bundle.imapService.getEmailById(emailId);
      const preferHtml = normalizeBoolean(args.preferHtml, false);
      const maxBodyLength = normalizeLimit(args.maxBodyLength, undefined as unknown as number, 1, 500_000);
      const showHeaders = normalizeBoolean(args.showHeaders, false);

      const output = formatEmailDetailOutput(detail, preferHtml, maxBodyLength);
      // formatEmailDetailOutput always strips the full raw header map (needless
      // token bloat by default) — re-add it only when explicitly requested.
      // showHeaders already existed but previously only added a 2-field duplicate
      // on top without ever removing the always-present full map.
      if (showHeaders) output.headers = detail.headers;

      const prefixedEmailId = prefixedIdFor(bundle, detail.id);
      output.id = prefixedEmailId;
      const security = assessMail({ ...detail, automated: detail.isAutomated });
      if (security.level !== "ok") {
        output.risk = security;
        taint.mark(prefixedEmailId, security);
      }
      return createTextResult(output, false, [emailSource({ ...detail, id: prefixedEmailId }), ...detail.attachments.map((attachment) => attachmentSource(prefixedEmailId, attachment))]);
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

      // Found live (external review): every id went straight to the primary
      // account's imapService regardless of its own "<slug>::" prefix, so a
      // non-primary account's id in the list either resolved the wrong
      // message on primary or (more often) just failed to be found — the
      // list [primaryId, secondary::id] reported succeeded:1 instead of 2.
      // Each id is now resolved to its own account first, same as every
      // other emailId-taking tool, and the returned id keeps its prefix.
      const results = await Promise.all(
        emailIds.map(async (emailId) => {
          try {
            const { bundle, rest } = resolveAccountForEmailId(emailId);
            const detail = await bundle.imapService.getEmailById(rest);
            const output = formatEmailDetailOutput(detail, preferHtml, maxBodyLength);
            output.id = prefixedIdFor(bundle, detail.id);
            const security = assessMail({ ...detail, automated: detail.isAutomated });
            if (security.level !== "ok") {
              output.risk = security;
              taint.mark(output.id as string, security);
            }
            return { emailId, ok: true as const, email: output };
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
      const effectiveLimit = normalizeLimit(args.limit, 50);
      try {
        const searchAccount = resolveAccountArg(args);
        const liveSearchInput = {
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
            optionalBoolean(args.hasAttachment),
          attachmentName: optionalString(args, "attachmentName"),
          isRead: optionalBoolean(args.isRead),
          isStarred: optionalBoolean(args.isStarred),
          dateFrom: optionalString(args, "dateFrom"),
          dateTo: optionalString(args, "dateTo"),
          sizeLarger: optionalNumber(args.sizeLarger, 0, Number.MAX_SAFE_INTEGER),
          sizeSmaller: optionalNumber(args.sizeSmaller, 0, Number.MAX_SAFE_INTEGER),
          listId: optionalString(args, "listId"),
          limit: effectiveLimit,
          includeSnippet: normalizeBoolean(args.includeSnippet, false),
        };
        let result: Awaited<ReturnType<typeof imapService.searchEmails>>;
        let liveHasMore = false;
        let liveFailedAccounts: Array<{ account: string; error: string }> = [];
        if (accountManager.all().length === 1) {
          result = await imapService.searchEmails(liveSearchInput);
          // The service also knows when it cut its candidates short (e.g. the non-ASCII scan checks
          // only the newest 500), which a full page alone does not show.
          liveHasMore = result.hasMore || result.emails.length === effectiveLimit;
        } else {
          // Merge strategy (mirrors search_indexed_emails): each account has its own
          // single IMAP connection, so search the selected accounts strictly one after
          // another, tag non-primary ids with the account slug, re-sort newest-first
          // and re-apply the limit across the merged set.
          const primarySlugForLive = accountManager.primary().account.slug;
          const targets = searchAccount ? [searchAccount] : accountManager.all();
          const perAccountLive: Array<{ bundle: AccountBundle; result: Awaited<ReturnType<typeof imapService.searchEmails>> }> = [];
          const failedAccounts: Array<{ account: string; error: string }> = [];
          let firstFailure: unknown;
          for (const bundle of targets) {
            try {
              perAccountLive.push({ bundle, result: await bundle.imapService.searchEmails(liveSearchInput) });
            } catch (error) {
              // An implicit all-accounts search must not fail because ONE account is unreachable or
              // lacks the requested folder/label; report it and return the rest. An explicit
              // `account`, a bad argument (dates), or every account failing still throws.
              const invalidArgument = error instanceof Error && error.message.includes("Invalid date");
              if (searchAccount || invalidArgument || targets.length === 1) throw error;
              firstFailure ??= error;
              failedAccounts.push({ account: bundle.account.slug, error: error instanceof Error ? error.message : String(error) });
            }
          }
          if (perAccountLive.length === 0) throw firstFailure;
          liveFailedAccounts = failedAccounts;
          const tagged = perAccountLive.flatMap(({ bundle, result: r }) =>
            r.emails.map((email) => ({ ...email, id: withAccountPrefix(accountSlugForTag(bundle, primarySlugForLive), email.id) })),
          );
          const merged = sortByDateDesc(tagged, (email) => email.internalDate || email.date).slice(0, effectiveLimit);
          result = {
            folders: [...new Set(perAccountLive.flatMap(({ result: r }) => r.folders))],
            limit: effectiveLimit,
            total: perAccountLive.reduce((sum, { result: r }) => sum + r.total, 0),
            totalMatched: perAccountLive.reduce((sum, { result: r }) => sum + r.totalMatched, 0),
            hasMore: false,
            emails: merged,
          };
          liveHasMore = merged.length === effectiveLimit || perAccountLive.some(({ result: r }) => r.hasMore);
        }
        return createTextResult(
          {
            ...result,
            emails: projectFields(result.emails, parseFieldsArg(args.fields)),
            returned: result.emails.length,
            hasMore: liveHasMore,
            ...(liveFailedAccounts.length > 0 ? { failedAccounts: liveFailedAccounts } : {}),
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

    case "search_indexed_emails":
    {
      const searchIndexedInput = {
        query: optionalString(args, "query"),
        folder: optionalString(args, "folder"),
        label: optionalString(args, "label"),
        threadId: optionalString(args, "threadId"),
        from: optionalString(args, "from"),
        to: optionalString(args, "to"),
        senderDomain: optionalString(args, "senderDomain"),
        subject: optionalString(args, "subject"),
        hasAttachment:
          optionalBoolean(args.hasAttachment),
        attachmentName: optionalString(args, "attachmentName"),
        isRead: optionalBoolean(args.isRead),
        isStarred: optionalBoolean(args.isStarred),
        mailboxRole: optionalString(args, "mailboxRole"),
        dateFrom: optionalString(args, "dateFrom"),
        dateTo: optionalString(args, "dateTo"),
        limit: optionalInteger(args.limit, 1, 1000),
      };
      const indexedAccount = resolveAccountArg(args);
      // Serve fresh data: a cheap UIDNEXT/message-count probe, refreshing only when the
      // mailbox moved. This search used to read the index as-is, so mail that arrived
      // after the last sync was reported missing. A refresh failure (Bridge down) must
      // never block serving the local index, which is the point of this tool.
      const refreshTargets = indexedAccount ? [indexedAccount] : accountManager.all();
      await Promise.all(refreshTargets.map((bundle) => refreshIndexForSearch(bundle)));
      const primarySlugForSearch = accountManager.primary().account.slug;
      // One search over the index, in this account or merged over all: each account is searched on its own, ids are
      // tagged with the account slug and the lists are put newest first (each account's list already arrives
      // relevance-sorted, so this approximates one global ranking) before the limit is applied.
      const searchOnce = async (input: typeof searchIndexedInput) => {
        if (accountManager.all().length === 1) {
          const result = await localIndexService.search(input);
          return { total: result.total, emails: result.emails, lastSyncAt: result.lastSyncAt, warnings: result.warnings ?? [], raw: result };
        }
        const perAccount = await Promise.all((indexedAccount ? [indexedAccount] : accountManager.all()).map(async (bundle) => ({ bundle, result: await bundle.localIndexService.search(input) })));
        const tagged = perAccount.flatMap(({ bundle, result }) => result.emails.map((email) => ({ ...email, id: withAccountPrefix(accountSlugForTag(bundle, primarySlugForSearch), email.id) })));
        const primaryEntry = perAccount.find(({ bundle }) => bundle.account.slug === primarySlugForSearch) ?? perAccount[0];
        return {
          total: perAccount.reduce((sum, { result }) => sum + result.total, 0),
          emails: sortByDateDesc(tagged, (email) => email.internalDate || email.date).slice(0, input.limit ?? 50),
          lastSyncAt: primaryEntry?.result.lastSyncAt,
          warnings: perAccount.flatMap(({ result }) => result.warnings ?? []),
          raw: undefined,
        };
      };

      const variants = args.queries === undefined ? [] : [...new Set(parseStringListArg(args, "queries"))];
      if (variants.length > 0) {
        // Several wordings of one question (synonyms, other languages): each is searched, and the results are fused by
        // reciprocal rank, so a message that several wordings find comes first. `matchedBy` says which found it.
        if (variants.length > MAX_QUERY_VARIANTS) throw new McpError(ErrorCode.InvalidParams, `At most ${MAX_QUERY_VARIANTS} queries.`);
        const finalLimit = searchIndexedInput.limit ?? 50;
        const perQuery = Math.min(Math.max(finalLimit * 2, 20), 200);
        const fused = new Map<string, { email: Awaited<ReturnType<typeof searchOnce>>["emails"][number]; score: number; matchedBy: string[] }>();
        const warnings: string[] = [];
        let lastSyncAt: string | undefined;
        for (const variant of variants) {
          const result = await searchOnce({ ...searchIndexedInput, query: variant, limit: perQuery });
          lastSyncAt = lastSyncAt ?? result.lastSyncAt;
          warnings.push(...result.warnings);
          result.emails.forEach((email, rank) => {
            const entry = fused.get(email.id) ?? { email, score: 0, matchedBy: [] };
            entry.score += 1 / (RRF_K + rank + 1);
            entry.matchedBy.push(variant);
            fused.set(email.id, entry);
          });
        }
        const ranked = [...fused.values()].sort((a, b) => b.score - a.score);
        const emails = ranked.slice(0, finalLimit).map(({ email, matchedBy }) => ({ ...email, matchedBy }));
        return createTextResult(
          {
            total: ranked.length,
            hasMore: ranked.length > emails.length,
            queries: variants,
            emails: projectFields(emails, parseFieldsArg(args.fields)),
            lastSyncAt,
            ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
          },
          false,
          emails.map(emailSource),
        );
      }

      const single = await searchOnce(searchIndexedInput);
      if (single.raw) {
        // One account: the result as the index gives it, with its freshness and stale-index fields.
        return createTextResult({ ...single.raw, emails: projectFields(single.raw.emails, parseFieldsArg(args.fields)) }, false, single.raw.emails.map(emailSource));
      }
      return createTextResult(
        {
          total: single.total,
          hasMore: single.total > single.emails.length,
          emails: projectFields(single.emails, parseFieldsArg(args.fields)),
          lastSyncAt: single.lastSyncAt,
          ...(single.warnings.length > 0 ? { warnings: single.warnings } : {}),
        },
        false,
        single.emails.map(emailSource),
      );
    }

    case "get_threads":
    {
      const threadsInput = {
        query: optionalString(args, "query"),
        label: optionalString(args, "label"),
        folder: optionalString(args, "folder"),
        limit: optionalInteger(args.limit, 1, 1000),
        offset: optionalInteger(args.offset, 0, 1_000_000),
      };
      if (accountManager.all().length === 1) {
        resolveAccountArg(args);
        await maybeRefreshLocalIndex(imapService, localIndexService, {
          folder: "INBOX",
          limitPerFolder: 100,
        });
        const result = await localIndexService.getThreads(threadsInput);
        const budgeted = trimThreadsToBudget(result.threads);
        return createTextResult(
          { ...result, threads: budgeted.threads, ...paginationFields(result.total, result.offset, budgeted.threads.length, budgeted.trimmed) },
          false,
          budgeted.threads.map(threadSource),
        );
      }
      // Merge strategy: refresh and query each account's own thread index
      // independently, tag thread ids with the account slug, concatenate,
      // re-sort newest-first by latestDate, then re-apply the requested
      // limit across the merged set and sum totals/hasMore.
      const primarySlugForThreads = accountManager.primary().account.slug;
      const threadsPerAccount = await Promise.all(
        selectedBundles(args).map(async (bundle) => {
          await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, {
            folder: "INBOX",
            limitPerFolder: 100,
          });
          return {
            bundle,
            result: await bundle.localIndexService.getThreads({
              ...threadsInput,
              limit: (threadsInput.limit ?? 100) + (threadsInput.offset ?? 0),
              offset: 0,
            }),
          };
        }),
      );
      const threadsLimit = threadsInput.limit ?? 100;
      const taggedThreads = threadsPerAccount.flatMap(({ bundle, result }) =>
        result.threads.map((thread) => ({
          ...thread,
          id: withAccountPrefix(accountSlugForTag(bundle, primarySlugForThreads), thread.id),
          messageIds: thread.messageIds.map((id) => withAccountPrefix(accountSlugForTag(bundle, primarySlugForThreads), id)),
        })),
      );
      const threadsOffset = threadsInput.offset ?? 0;
      const pagedThreads = sortByDateDesc(taggedThreads, (thread) => thread.latestDate).slice(threadsOffset, threadsOffset + threadsLimit);
      const budgetedThreads = trimThreadsToBudget(pagedThreads);
      const mergedThreads = budgetedThreads.threads;
      const totalThreads = threadsPerAccount.reduce((sum, { result }) => sum + result.total, 0);
      return createTextResult(
        {
          total: totalThreads,
          ...paginationFields(totalThreads, threadsOffset, mergedThreads.length, budgetedThreads.trimmed),
          threads: mergedThreads,
        },
        false,
        mergedThreads.map(threadSource),
      );
    }

    case "get_actionable_threads":
    {
      const limit = normalizeLimit(args.limit, 50, 1, 1000);
      const offset = normalizeLimit(args.offset, 0, 0, 1_000_000);
      // Fan-out merge: ask every account for its own top-`limit` actionable threads
      // (each account's own getActionableThreads already sorts by score, then
      // recency — see local-index-service.ts), tag every thread/message id with its
      // account's slug, then merge all accounts' lists, re-sort by that exact same
      // (score, then latestDate) order, and take the top `limit` of the MERGED set —
      // never per-account. Requesting `limit` (not divided) from each account is what
      // makes this correct: any thread in the true global top-`limit` must already
      // rank within its own account's top-`limit`, since a lower rank there would mean
      // at least `limit` better-or-equal threads exist ahead of it account-wide alone.
      const perAccount = await Promise.all(
        selectedBundles(args).map(async (bundle) => {
          const refresh = await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, {
            force: normalizeBoolean(args.syncBefore, false),
            folder: "INBOX",
            limitPerFolder: 100,
          });
          const result = await bundle.localIndexService.getActionableThreads({
            query: optionalString(args, "query"),
            label: optionalString(args, "label"),
            pendingOn:
              args.pendingOn === "you" || args.pendingOn === "them" || args.pendingOn === "any"
                ? args.pendingOn
                : undefined,
            unreadOnly: normalizeBoolean(args.unreadOnly, true),
            limit: limit + offset,
          });
          return { bundle, refresh, result };
        }),
      );
      const mergedThreads = perAccount
        .flatMap(({ bundle, result }) => tagAccountIds(slugForBundle(bundle), result.threads))
        .sort((left: ActionableThreadSummary, right: ActionableThreadSummary) => {
          if (right.score !== left.score) return right.score - left.score;
          return new Date(right.latestDate || 0).getTime() - new Date(left.latestDate || 0).getTime();
        })
        .slice(offset, offset + limit);
      const budgetedActionable = trimThreadsToBudget(mergedThreads);
      const totalCount = perAccount.reduce((sum, { result }) => sum + result.total, 0);
      const messagesCapped = perAccount.some(({ result }) => result.messagesCapped);
      const latestRefresh = perAccount.map(({ refresh }) => refresh).find((refresh) => refresh);
      const actionableFreshness = perAccount.find(({ result }) => result.lastSyncAt)?.result;
      return createTextResult(
        {
          total: totalCount,
          ...paginationFields(totalCount, offset, budgetedActionable.threads.length, budgetedActionable.trimmed),
          threads: budgetedActionable.threads,
          ...(actionableFreshness?.lastSyncAt ? { lastSyncAt: actionableFreshness.lastSyncAt, indexFreshnessMinutes: actionableFreshness.indexFreshnessMinutes } : {}),
          ...(perAccount.some(({ result }) => result.stale) ? { stale: true } : {}),
          ...(messagesCapped ? { messagesCapped: true } : {}),
          ...(latestRefresh ? { indexUpdatedAt: latestRefresh.indexStatus.updatedAt } : {}),
        },
        false,
        budgetedActionable.threads.map(threadSource),
      );
    }

    case "get_inbox_digest":
    {
      const limit = normalizeLimit(args.limit, 10, 1, 1000);
      const offset = normalizeLimit(args.offset, 0, 0, 1_000_000);
      // Each account is asked for offset+limit+1 rows per section: enough to slice the requested
      // page from the merged list and to know whether another page exists.
      const perAccountWindow = offset + limit + 1;
      // Fan-out merge: get_inbox_digest already internally aggregates two lists
      // (topThreads by score/recency, staleAwaitingYou by score/recency) plus a
      // `counts` summary — mirror that same internal merge style across accounts.
      // Ask each account for its own top-`limit` of both lists, tag ids with the
      // account's slug, concatenate each list across accounts, re-sort by the same
      // (score, then latestDate) order the single-account version uses, and take the
      // top `limit` of the MERGED list (never per-account — see get_actionable_threads
      // for why requesting `limit`, not limit/accounts, per account is what makes this
      // correct). `counts` is summed across accounts field-by-field.
      const perAccount = await Promise.all(
        selectedBundles(args).map(async (bundle) => {
          await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, {
            force: normalizeBoolean(args.syncBefore, false),
            folder: "INBOX",
            limitPerFolder: 100,
          });
          const result = await bundle.localIndexService.getInboxDigest({
            limit: perAccountWindow,
            minAgeHours: optionalNumber(args.minAgeHours, 0, 87_600),
          });
          const slug = slugForBundle(bundle);
          return {
            counts: (result.counts ?? {}) as Record<string, number>,
            countsCapped: result.countsCapped === true,
            indexUpdatedAt: result.indexUpdatedAt as string | undefined,
            topThreads: tagAccountIds(slug, (result.topThreads ?? []) as ActionableThreadSummary[]),
            staleAwaitingYou: tagAccountIds(slug, (result.staleAwaitingYou ?? []) as ActionableThreadSummary[]),
          };
        }),
      );
      const byScoreThenDate = (left: ActionableThreadSummary, right: ActionableThreadSummary) => {
        if (right.score !== left.score) return right.score - left.score;
        return new Date(right.latestDate || 0).getTime() - new Date(left.latestDate || 0).getTime();
      };
      const mergedTop = perAccount.flatMap((entry) => entry.topThreads).sort(byScoreThenDate);
      const mergedStale = perAccount.flatMap((entry) => entry.staleAwaitingYou).sort(byScoreThenDate);
      const topBudget = trimThreadsToBudget(mergedTop.slice(offset, offset + limit), THREAD_LIST_RESPONSE_BUDGET_CHARS / 2);
      const staleBudget = trimThreadsToBudget(mergedStale.slice(offset, offset + limit), THREAD_LIST_RESPONSE_BUDGET_CHARS / 2);
      const topThreads = topBudget.threads;
      const staleAwaitingYou = staleBudget.threads;
      const countKeys = new Set(perAccount.flatMap((entry) => Object.keys(entry.counts)));
      const counts: Record<string, number> = {};
      for (const key of countKeys) {
        counts[key] = perAccount.reduce((sum, entry) => sum + (entry.counts[key] ?? 0), 0);
      }
      // Reply reminders whose date has passed with no answer: they belong in a triage summary.
      const dueReminders = (await evaluateReminders(selectedBundles(args))).filter((reminder) => reminder.state === "due");
      const result = {
        generatedAt: new Date().toISOString(),
        indexUpdatedAt: perAccount.map((entry) => entry.indexUpdatedAt).filter(Boolean).sort().reverse()[0],
        counts,
        ...(perAccount.some((entry) => entry.countsCapped)
          ? { countsCapped: true, countsNote: "counts and topThreads cover only the newest 5000 indexed messages per account; counts.staleAwaitingYou covers every thread in the index, so it is not comparable with them." }
          : {}),
        topThreads,
        staleAwaitingYou,
        ...(dueReminders.length > 0 ? { repliesDue: dueReminders.slice(0, 10), repliesDueTotal: dueReminders.length } : {}),
        // Each section pages independently with the same offset/limit: pass nextOffset back as
        // `offset` to continue (a section with hasMore:false is exhausted).
        paging: {
          topThreads: paginationFields(mergedTop.length, offset, topThreads.length, topBudget.trimmed),
          staleAwaitingYou: paginationFields(mergedStale.length, offset, staleAwaitingYou.length, staleBudget.trimmed),
        },
        ...(topBudget.trimmed > 0 || staleBudget.trimmed > 0 ? { truncatedForSize: true } : {}),
      };
      return createTextResult(
        result,
        false,
        [...topThreads, ...staleAwaitingYou].map(threadSource),
      );
    }

    case "get_follow_up_candidates":
    {
      const limit = normalizeLimit(args.limit, 25, 1, 1000);
      const offset = normalizeLimit(args.offset, 0, 0, 1_000_000);
      // Fan-out merge: ask every account for its own top-`limit` follow-up
      // candidates (each account's own getFollowUpCandidates sorts by ageHours, then
      // score), tag ids with the account's slug, concatenate, re-sort by that same
      // (ageHours, then score) order, and take the top `limit` of the MERGED set —
      // same correctness argument as get_actionable_threads' fan-out.
      const perAccount = await Promise.all(
        selectedBundles(args).map(async (bundle) => {
          await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, {
            force: normalizeBoolean(args.syncBefore, false),
            folder: "INBOX",
            limitPerFolder: 100,
          });
          const result = await bundle.localIndexService.getFollowUpCandidates({
            limit: limit + offset,
            minAgeHours: optionalNumber(args.minAgeHours, 0, 87_600),
            pendingOn:
              args.pendingOn === "you" || args.pendingOn === "them" || args.pendingOn === "any"
                ? args.pendingOn
                : undefined,
          });
          return {
            bundle,
            indexUpdatedAt: result.indexUpdatedAt as string | undefined,
            threads: tagAccountIds(slugForBundle(bundle), (result.threads ?? []) as (ActionableThreadSummary & { ageHours?: number })[]),
            total: (result.total as number) ?? 0,
          };
        }),
      );
      const threads = perAccount
        .flatMap((entry) => entry.threads)
        .sort((left, right) => {
          if ((right.ageHours ?? 0) !== (left.ageHours ?? 0)) return (right.ageHours ?? 0) - (left.ageHours ?? 0);
          return right.score - left.score;
        })
        .slice(offset, offset + limit);
      const followUpBudget = trimThreadsToBudget(threads);
      const totalCount = perAccount.reduce((sum, entry) => sum + entry.total, 0);
      const result = {
        generatedAt: new Date().toISOString(),
        indexUpdatedAt: perAccount.map((entry) => entry.indexUpdatedAt).filter(Boolean).sort().reverse()[0],
        minAgeHours: (optionalNumber(args.minAgeHours, 0, 87_600) ?? 24),
        pendingOn: args.pendingOn === "you" || args.pendingOn === "them" || args.pendingOn === "any" ? args.pendingOn : "you",
        total: totalCount,
        ...paginationFields(totalCount, offset, followUpBudget.threads.length, followUpBudget.trimmed),
        threads: followUpBudget.threads,
      };
      return createTextResult(
        result,
        false,
        followUpBudget.threads
          .filter((thread): thread is ActionableThreadSummary & { ageHours?: number } & { id: string; subject: string; latestDate?: string; messageCount: number; normalizedLabels?: string[]; participants?: EmailAddress[] } =>
            Boolean(thread && typeof thread === "object" && "id" in thread),
          )
          .map(threadSource),
      );
    }

    case "find_document_threads":
    {
      const limit = normalizeLimit(args.limit, 25, 1, 1000);
      // Fan-out merge: ask every account for its own top-`limit` document threads
      // (each account's own findDocumentThreads sorts by document count, then
      // recency), tag ids (including each document's own emailId) with the
      // account's slug, concatenate, re-sort by that same order, and take the top
      // `limit` of the MERGED set — same correctness argument as
      // get_actionable_threads' fan-out.
      const category =
        args.category === "document" ||
        args.category === "invoice" ||
        args.category === "contract" ||
        args.category === "travel" ||
        args.category === "calendar"
          ? args.category
          : "document";
      const perAccount = await Promise.all(
        selectedBundles(args).map(async (bundle) => {
          await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, {
            force: normalizeBoolean(args.syncBefore, false),
            folder: "INBOX",
            limitPerFolder: 100,
          });
          const result = await bundle.localIndexService.findDocumentThreads({
            category,
            query: optionalString(args, "query"),
            limit,
          });
          type DocumentThread = ThreadDetail & { documents: { emailId: string; subject: string; filename?: string; kind?: string; contentType?: string }[] };
          return {
            indexUpdatedAt: result.indexUpdatedAt as string | undefined,
            threads: tagAccountIds(slugForBundle(bundle), (result.threads ?? []) as DocumentThread[]),
            total: (result.total as number) ?? 0,
          };
        }),
      );
      const threads = perAccount
        .flatMap((entry) => entry.threads)
        .sort((left, right) => {
          if (right.documents.length !== left.documents.length) return right.documents.length - left.documents.length;
          return new Date(right.latestDate || 0).getTime() - new Date(left.latestDate || 0).getTime();
        })
        .slice(0, limit);
      const totalCount = perAccount.reduce((sum, entry) => sum + entry.total, 0);
      const result = {
        generatedAt: new Date().toISOString(),
        indexUpdatedAt: perAccount.map((entry) => entry.indexUpdatedAt).filter(Boolean).sort().reverse()[0],
        category,
        total: totalCount,
        hasMore: totalCount > limit,
        threads,
      };
      return createTextResult(
        result,
        false,
        threads.map(threadSource),
      );
    }

    case "prepare_meeting_context":
    {
      const limit = normalizeLimit(args.limit, 10, 1, 1000);
      // Fan-out merge: ask every account for its own top-`limit` meeting-prep
      // threads (each account's own getMeetingPrep sorts by recency — see
      // local-index-service.ts), tag ids with the account's slug, concatenate,
      // re-sort by that same recency order, and take the top `limit` of the
      // MERGED set — same correctness argument as get_actionable_threads' fan-out.
      const perAccount = await Promise.all(
        selectedBundles(args).map(async (bundle) => {
          await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, {
            force: normalizeBoolean(args.syncBefore, false),
            folder: "INBOX",
            limitPerFolder: 100,
          });
          const result = await bundle.localIndexService.getMeetingPrep({
            person: optionalString(args, "person"),
            domain: optionalString(args, "domain"),
            limit,
          });
          return {
            indexUpdatedAt: result.indexUpdatedAt as string | undefined,
            threads: tagAccountIds(slugForBundle(bundle), (result.threads ?? []) as ThreadDetail[]),
            total: (result.total as number) ?? 0,
          };
        }),
      );
      const threads = perAccount
        .flatMap((entry) => entry.threads)
        .sort((left, right) => new Date(right.latestDate || 0).getTime() - new Date(left.latestDate || 0).getTime())
        .slice(0, limit);
      const totalCount = perAccount.reduce((sum, entry) => sum + entry.total, 0);
      const result = {
        generatedAt: new Date().toISOString(),
        indexUpdatedAt: perAccount.map((entry) => entry.indexUpdatedAt).filter(Boolean).sort().reverse()[0],
        total: totalCount,
        hasMore: totalCount > limit,
        threads,
      };
      return createTextResult(
        result,
        false,
        threads.map(threadSource),
      );
    }

    case "get_thread_brief":
    {
      // Fanned out across accounts the same way emailId-targeted tools resolve a
      // specific account: the threadId's optional "<slug>::" prefix (from a merged
      // digest/follow-up/etc. result above) picks the owning account's bundle, same
      // pattern as resolveAccountForEmailId. A plain, unprefixed threadId still
      // means the primary account, unchanged from single-account behavior.
      const { bundle, rest } = resolveAccountForEmailId(requireString(args, "threadId"));
      const slug = slugForBundle(bundle);
      await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, {
        folder: "INBOX",
        limitPerFolder: 100,
      });
      const rawThread = await bundle.localIndexService.getThreadById(rest);
      const thread = tagAccountIds(slug, rawThread);
      const result = buildThreadBrief(thread, bundle.config.smtp.username);
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
      // A threadId is only ever valid within the single account it was
      // produced by (see get_threads/search_indexed_emails above) — this is
      // a routed lookup, not a fan-out/merge: resolve the optional
      // "<slug>::" prefix (added when the id came from a non-primary
      // account) back to that account's bundle, defaulting to the primary
      // for a plain id exactly as before multi-account support existed.
      const rawThreadId = requireString(args, "threadId");
      const { accountSlug: threadAccountSlug, rest: unprefixedThreadId } = splitAccountPrefix(
        rawThreadId,
        accountManager.additionalSlugs(),
      );
      const threadBundle = accountManager.bySlugOrPrimary(threadAccountSlug);
      await maybeRefreshLocalIndex(threadBundle.imapService, threadBundle.localIndexService, {
        folder: "INBOX",
        limitPerFolder: 100,
      });
      const rawFolders = args?.folders;
      const threadFolders = Array.isArray(rawFolders) ? rawFolders.filter((f): f is string => typeof f === "string") : undefined;
      const rawThread = await threadBundle.localIndexService.getThreadById(unprefixedThreadId);
      const thread = threadAccountSlug
        ? {
            ...rawThread,
            id: withAccountPrefix(threadAccountSlug, rawThread.id),
            messageIds: rawThread.messageIds.map((id) => withAccountPrefix(threadAccountSlug, id)),
          }
        : rawThread;
      const filteredThread = threadFolders && threadFolders.length > 0
        ? {
            ...thread,
            messages: thread.messages.filter((message) => threadFolders.includes(message.folder)),
            messageCount: thread.messages.filter((message) => threadFolders.includes(message.folder)).length,
            unreadCount: thread.messages.filter((message) => threadFolders.includes(message.folder) && !message.isRead).length,
          }
        : thread;
      // Same per-call attachment trimming as every search/list tool — see
      // projectFields' comment. get_thread_by_id's messages carry full
      // MailboxMessage/EmailSummary objects (unlike get_threads' lean
      // ThreadSummary list, which has no per-message attachments at all).
      const result = { ...filteredThread, messages: filteredThread.messages.map(trimAttachmentsForListing) };
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

    case "top_senders": {
      const topSendersLimit = optionalInteger(args.limit, 1, 200);
      const topSendersInput = {
        folder: optionalString(args, "folder"),
        since: optionalString(args, "since"),
        before: optionalString(args, "before"),
        limit: topSendersLimit,
        scanLimit: optionalInteger(args.scanLimit, 1, 20_000),
        excludeSelf: normalizeBoolean(args.excludeSelf, true),
      };
      if (accountManager.all().length === 1) {
        resolveAccountArg(args);
        const result = await imapService.topSenders(topSendersInput);
        return createTextResult(result);
      }
      // Merge strategy: scan each account's folder independently, merge
      // sender frequency by address (summing counts across accounts), then
      // re-sort and re-apply the requested top-N limit over the merged set.
      // Each account is asked for its WHOLE table, not just its own top N: a sender in the middle of every
      // account's table can still be first in total, and cutting each table first made it disappear.
      const perAccount = await Promise.all(
        selectedBundles(args).map(async (bundle) => ({
          bundle,
          result: await bundle.imapService.topSenders({ ...topSendersInput, limit: 10_000 }),
        })),
      );
      const senderMap = new Map<string, { address: string; name?: string; count: number; direction: "self" | "received" }>();
      for (const { result } of perAccount) {
        for (const sender of result.senders) {
          const existing = senderMap.get(sender.address);
          if (existing) {
            existing.count += sender.count;
          } else {
            senderMap.set(sender.address, { ...sender });
          }
        }
      }
      const mergedSenders = [...senderMap.values()].sort((left, right) => right.count - left.count).slice(0, topSendersLimit ?? 20);
      return createTextResult({
        folder: topSendersInput.folder?.trim() || "INBOX",
        scanned: perAccount.reduce((sum, { result }) => sum + result.scanned, 0),
        senders: mergedSenders,
        byAccount: perAccount.map(({ bundle, result }) => ({ slug: bundle.account.slug, scanned: result.scanned })),
      });
    }

    case "get_email_stats": {
      const statsDays = normalizeLimit(args.days, 30, 1, 365);
      const statsLimit = normalizeLimit(args.limit, 2000, 1, 10_000);
      if (accountManager.all().length === 1) {
        resolveAccountArg(args);
        const folders = await imapService.getFolders();
        const sample = await getAnalyticsSampleFromIndex(imapService, localIndexService, statsDays, statsLimit);
        return createTextResult(analyticsService.getEmailStats(sample, folders, config.smtp.username));
      }
      // Merge strategy: compute each account's own stats independently
      // (self-detection needs each account's own address), then sum the
      // numeric mailbox/sample fields and merge folder lists (non-primary
      // folder paths tagged with their account slug to avoid collisions).
      const primarySlugForStats = accountManager.primary().account.slug;
      const statsPerAccount = await Promise.all(
        selectedBundles(args).map(async (bundle) => {
          const folders = await bundle.imapService.getFolders();
          const sample = await getAnalyticsSampleFromIndex(bundle.imapService, bundle.localIndexService, statsDays, statsLimit);
          return {
            bundle,
            stats: analyticsService.getEmailStats(sample, folders, bundle.config.smtp.username),
          };
        }),
      );
      return createTextResult({
        generatedAt: new Date().toISOString(),
        mailbox: {
          folderCount: statsPerAccount.reduce((sum, { stats }) => sum + stats.mailbox.folderCount, 0),
          totalMessages: statsPerAccount.reduce((sum, { stats }) => sum + stats.mailbox.totalMessages, 0),
          unreadMessages: statsPerAccount.reduce((sum, { stats }) => sum + stats.mailbox.unreadMessages, 0),
        },
        sample: {
          size: statsPerAccount.reduce((sum, { stats }) => sum + stats.sample.size, 0),
          starredMessages: statsPerAccount.reduce((sum, { stats }) => sum + stats.sample.starredMessages, 0),
          messagesWithAttachments: statsPerAccount.reduce((sum, { stats }) => sum + stats.sample.messagesWithAttachments, 0),
          uniqueContacts: statsPerAccount.reduce((sum, { stats }) => sum + stats.sample.uniqueContacts, 0),
        },
        folders: statsPerAccount.flatMap(({ bundle, stats }) => {
          const slug = accountSlugForTag(bundle, primarySlugForStats);
          return stats.folders.map((folder) => (slug ? { ...folder, path: `${slug}::${folder.path}` } : folder));
        }),
        byAccount: statsPerAccount.map(({ bundle, stats }) => ({ slug: bundle.account.slug, mailbox: stats.mailbox, sample: stats.sample })),
      });
    }

    case "get_email_analytics": {
      const analyticsDays = normalizeLimit(args.days, 30, 1, 365);
      const analyticsLimit = normalizeLimit(args.limit, 2000, 1, 10_000);
      if (accountManager.all().length === 1) {
        resolveAccountArg(args);
        const sample = await getAnalyticsSampleFromIndex(imapService, localIndexService, analyticsDays, analyticsLimit);
        return createTextResult(analyticsService.getEmailAnalytics(sample, config.smtp.username, analyticsDays));
      }
      // Merge strategy: compute each account's own analytics independently
      // (self-detection needs each account's own address), then merge the
      // top-N breakdowns (hours/senders/domains) by summing counts per key
      // and re-sorting, and recompute busiestDay/insights from the merged
      // results.
      const analyticsPerAccount = await Promise.all(
        selectedBundles(args).map(async (bundle) => {
          const sample = await getAnalyticsSampleFromIndex(bundle.imapService, bundle.localIndexService, analyticsDays, analyticsLimit);
          return analyticsService.getEmailAnalytics(sample, bundle.config.smtp.username, analyticsDays);
        }),
      );
      const busiestHours = mergeCountedEntries(
        analyticsPerAccount.map((entry) => entry.busiestHours),
        (entry) => entry.hour,
        5,
      );
      const topSenders = mergeCountedEntries(
        analyticsPerAccount.map((entry) => entry.topSenders),
        (entry) => entry.address,
        10,
      );
      const topDomains = mergeCountedEntries(
        analyticsPerAccount.map((entry) => entry.topDomains),
        (entry) => entry.domain,
        10,
      );
      const busiestDayCandidates = analyticsPerAccount.flatMap((entry) => (entry.busiestDay ? [entry.busiestDay] : []));
      const busiestDay = busiestDayCandidates.length > 0
        ? busiestDayCandidates.reduce((best, candidate) => (candidate.count > best.count ? candidate : best))
        : undefined;
      return createTextResult({
        generatedAt: new Date().toISOString(),
        sampleSize: analyticsPerAccount.reduce((sum, entry) => sum + entry.sampleSize, 0),
        busiestHours,
        topSenders,
        topDomains,
        busiestDay,
        insights: [
          busiestHours[0]
            ? `Peak sampled activity occurs around ${busiestHours[0].hour}.`
            : "No recent activity was available for hourly analysis.",
          topSenders[0]
            ? `Top sender in the sampled window: ${topSenders[0].address}.`
            : "No sender data was available in the sampled window.",
          busiestDay
            ? `Busiest sampled day was ${busiestDay.date} with ${busiestDay.count} messages.`
            : "No day-level trend data was available.",
        ],
      });
    }

    case "get_contacts": {
      // limit is "how many contacts to return", not "how many messages to
      // sample" — unlike get_email_stats/get_email_analytics (which return
      // one aggregate object, so their limit genuinely means sample size),
      // get_contacts returns a ranked list. Reusing limit as the sample size
      // meant limit: 5 silently ranked contacts from only 5 messages total.
      const limit = normalizeLimit(args.limit, 100);
      if (accountManager.all().length === 1) {
        resolveAccountArg(args);
        const sample = await getAnalyticsSampleFromIndex(imapService, localIndexService, 30, 3000);
        return createTextResult(analyticsService.getContacts(sample, limit, config.smtp.username));
      }
      // Merge strategy: compute each account's own contact list independently
      // (self-detection needs each account's own address), then merge same
      // address across accounts by summing incoming/outgoing/totalMessages
      // and keeping the most recent lastContactAt, and re-apply the
      // requested limit over the merged, re-sorted set.
      const contactsPerAccount = await Promise.all(
        selectedBundles(args).map(async (bundle) => {
          const sample = await getAnalyticsSampleFromIndex(bundle.imapService, bundle.localIndexService, 30, 3000);
          return analyticsService.getContacts(sample, Number.MAX_SAFE_INTEGER, bundle.config.smtp.username);
        }),
      );
      return createTextResult(mergeContactStats(contactsPerAccount, limit));
    }

    case "get_volume_trends": {
      const days = normalizeLimit(args.days, 30, 1, 365);
      // Counted in SQL over the whole index (a sample of the newest 3000 messages cut the older days short).
      if (accountManager.all().length === 1) {
        resolveAccountArg(args);
        await maybeRefreshLocalIndex(imapService, localIndexService, {});
        return createTextResult(await localIndexService.getDailyVolume(days));
      }
      // Merge strategy: compute each account's own daily trend points
      // independently, then sum count/unreadCount/starredCount/attachmentCount
      // for matching dates across accounts.
      const trendsPerAccount = await Promise.all(
        selectedBundles(args).map(async (bundle) => {
          await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, {});
          return bundle.localIndexService.getDailyVolume(days);
        }),
      );
      return createTextResult(mergeVolumeTrends(trendsPerAccount));
    }

    case "export_email": {
      const rawEmailId = requireString(args, "emailId");
      const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
      const result = await withAudit(auditService, name, args, async () =>
        bundle.imapService.exportEmail(emailId, optionalString(args, "outputPath")),
      );
      result.emailId = prefixedIdFor(bundle, result.emailId);
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
      // Bounded before the bytes are decoded: base64 is about a third larger than what it encodes.
      if ((rawBase64 ?? rawText ?? "").length > MAX_IMPORT_MESSAGE_BYTES * (rawBase64 ? 4 / 3 : 1)) {
        throw new McpError(ErrorCode.InvalidParams, `The message is larger than the ${Math.round(MAX_IMPORT_MESSAGE_BYTES / 1024 / 1024)} MB import limit.`);
      }
      const raw = rawBase64
        ? Buffer.from(rawBase64, "base64")
        : Buffer.from(rawText as string, "utf8");
      const { bundle: importBundle, paths: [importFolder] } = resolveFolderTarget(args, optionalString(args, "targetFolder") ?? "INBOX");
      const result = await withAudit(importBundle.auditService, name, args, async () =>
        importBundle.imapService.importEmail({
          raw,
          targetFolder: importFolder,
          flags: normalizeBoolean(args.markAsRead, false) ? ["\\Seen"] : [],
        }),
      );
      return createTextResult({
        ...result,
        ...(result.emailId ? { emailId: prefixedIdFor(importBundle, result.emailId) } : {}),
        ...(result.existingEmailId ? { existingEmailId: prefixedIdFor(importBundle, result.existingEmailId) } : {}),
      });
    }

    case "get_unsubscribe_info": {
      const rawEmailId = requireString(args, "emailId");
      const { bundle, rest: emailId } = resolveAccountForEmailId(rawEmailId);
      const detail = await bundle.imapService.getEmailById(emailId);
      const info = extractUnsubscribeInfo(detail);
      return createTextResult({
        emailId: prefixedIdFor(bundle, detail.id),
        hasUnsubscribeHeader: Boolean(info.mailto || info.url),
        mailto: info.mailto,
        ...(info.mailtoSubject ? { mailtoSubject: info.mailtoSubject } : {}),
        ...(info.mailtoBody ? { mailtoBody: info.mailtoBody } : {}),
        url: info.url,
        note: info.url
          ? "This server never auto-fetches unsubscribe URLs — open the url yourself, or use unsubscribe_sender if mailto is also set."
          : undefined,
      });
    }

    default:
      throw new Error(`handleReadingTool: unexpected tool ${name}`);
  }
}
