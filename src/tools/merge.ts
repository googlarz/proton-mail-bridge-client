import { type MailboxLabel, type ContactStats, type VolumeTrendPoint } from "../types/index.js";
import { type AccountBundle } from "../services/account-manager.js";
import { withAccountPrefix } from "../utils/helpers.js";
// Putting the answers of several accounts together (sorted, paginated, counted), tagging ids with the account, and keeping a list within the size a client can take.

// Recursively prefixes every id-bearing field on a thread (or array of threads) with
// the owning account's slug via withAccountPrefix, so ids returned by a tool fanned
// out across accounts (see accountManager.all() usages below) stay globally unique
// and resolvable back to the right account by splitAccountPrefix. slug is undefined
// for the primary account, and withAccountPrefix(undefined, id) === id, so the
// primary's own threads/messages are returned byte-for-byte unchanged — zero
// behavior change for single-account setups. Deep-clones via JSON round-trip since
// every field tagged here is plain, already-JSON-serializable data.
export function tagAccountIds<T>(slug: string | undefined, value: T): T {
  if (!slug || value === undefined || value === null) {
    return value;
  }
  const clone = JSON.parse(JSON.stringify(value));
  const prefix = (id: unknown) => (typeof id === "string" ? withAccountPrefix(slug, id) : id);
  const tagThread = (thread: unknown) => {
    if (!thread || typeof thread !== "object") {
      return;
    }
    const t = thread as Record<string, unknown>;
    if (typeof t.id === "string") t.id = prefix(t.id);
    if (typeof t.latestEmailId === "string") t.latestEmailId = prefix(t.latestEmailId);
    if (Array.isArray(t.messageIds)) t.messageIds = t.messageIds.map(prefix);
    if (Array.isArray(t.documents)) {
      for (const doc of t.documents) {
        if (doc && typeof doc === "object" && typeof (doc as Record<string, unknown>).emailId === "string") {
          (doc as Record<string, unknown>).emailId = prefix((doc as Record<string, unknown>).emailId);
        }
      }
    }
    if (Array.isArray(t.messages)) {
      for (const message of t.messages) {
        if (!message || typeof message !== "object") continue;
        const m = message as Record<string, unknown>;
        if (typeof m.id === "string") m.id = prefix(m.id);
        if (typeof m.primaryEmailId === "string") m.primaryEmailId = prefix(m.primaryEmailId);
        if (typeof m.canonicalId === "string") m.canonicalId = prefix(m.canonicalId);
        if (Array.isArray(m.locations)) {
          for (const loc of m.locations) {
            if (loc && typeof loc === "object" && typeof (loc as Record<string, unknown>).emailId === "string") {
              (loc as Record<string, unknown>).emailId = prefix((loc as Record<string, unknown>).emailId);
            }
          }
        }
      }
    }
  };
  if (Array.isArray(clone)) {
    clone.forEach(tagThread);
  } else {
    tagThread(clone);
  }
  return clone as T;
}

// Default cap on the serialized size of a thread-list response (get_actionable_threads,
// get_threads, get_follow_up_candidates, get_inbox_digest). Per-thread payloads are already
// bounded (shapeThreadForList); this is the backstop that keeps a large `limit` from
// producing a response over the client's tool-output limit. Rows past the budget are dropped
// from the end and reported via truncatedForSize/nextOffset so the caller can page on.
export const THREAD_LIST_RESPONSE_BUDGET_CHARS = 60_000;

export function trimThreadsToBudget<T>(
  threads: T[],
  budgetChars = THREAD_LIST_RESPONSE_BUDGET_CHARS,
): { threads: T[]; trimmed: number } {
  let used = 0;
  const kept: T[] = [];
  for (const thread of threads) {
    const size = JSON.stringify(thread).length;
    if (kept.length > 0 && used + size > budgetChars) {
      break;
    }
    used += size;
    kept.push(thread);
  }
  return { threads: kept, trimmed: threads.length - kept.length };
}

export function paginationFields(total: number, offset: number, shown: number, trimmed: number) {
  const nextOffset = offset + shown;
  return {
    hasMore: total > nextOffset,
    offset,
    ...(total > nextOffset ? { nextOffset } : {}),
    ...(trimmed > 0 ? { truncatedForSize: true } : {}),
  };
}

export function accountSlugForTag(bundle: AccountBundle, primarySlug: string): string | undefined {
  return bundle.account.slug === primarySlug ? undefined : bundle.account.slug;
}

// Re-sorts a merged, cross-account list of date-bearing items newest-first.
// Each account's own list already arrives pre-sorted (by relevance, then
// recency) — this is a reasonable global approximation once several
// independently-sorted lists are interleaved, not a re-derivation of each
// service's original relevance score.
export function sortByDateDesc<T>(items: T[], dateOf: (item: T) => string | undefined): T[] {
  return [...items].sort((left, right) => {
    const leftTime = new Date(dateOf(left) || 0).getTime();
    const rightTime = new Date(dateOf(right) || 0).getTime();
    return rightTime - leftTime;
  });
}

// get_emails' multi-account offset/limit pagination math, pulled out for direct
// testing. Applying `offset` separately to EACH account's own page before merging
// is wrong — page 2 (offset=25,limit=25) would skip each account's own first 25
// messages independently, then concatenate their page-2 results, which drops
// items relative to page 2 of the globally-merged, newest-first timeline (found
// live with interleaved messages across two accounts: page 2 skipped the
// second-newest message overall). The caller is expected to have already fetched
// each account from offset 0 up to (offset + limit) — since every account's own
// list already arrives newest-first, that's guaranteed to include every item that
// could rank in the global top (offset + limit) — and passes the sorted,
// concatenated superset in here to be paginated as one timeline.
export function paginateMergedAccountResults<T>(sortedMerged: T[], offset: number, limit: number): { page: T[]; hasMore: boolean } {
  return {
    page: sortedMerged.slice(offset, offset + limit),
    hasMore: sortedMerged.length > offset + limit,
  };
}

export function mergeMailboxLabels(perAccountLabels: MailboxLabel[][]): MailboxLabel[] {
  const merged = new Map<string, MailboxLabel>();
  for (const labels of perAccountLabels) {
    for (const label of labels) {
      const key = `${label.type}:${label.name}`;
      const existing = merged.get(key);
      if (existing) {
        existing.messageCount += label.messageCount;
        existing.unreadCount += label.unreadCount;
        existing.threadCount += label.threadCount;
      } else {
        merged.set(key, { ...label });
      }
    }
  }
  return [...merged.values()];
}

export function mergeContactStats(perAccountContacts: ContactStats[][], limit: number): ContactStats[] {
  const merged = new Map<string, ContactStats>();
  for (const contacts of perAccountContacts) {
    for (const contact of contacts) {
      const existing = merged.get(contact.address);
      if (existing) {
        existing.incoming += contact.incoming;
        existing.outgoing += contact.outgoing;
        existing.totalMessages += contact.totalMessages;
        if (
          contact.lastContactAt &&
          (!existing.lastContactAt || new Date(contact.lastContactAt).getTime() > new Date(existing.lastContactAt).getTime())
        ) {
          existing.lastContactAt = contact.lastContactAt;
        }
      } else {
        merged.set(contact.address, { ...contact });
      }
    }
  }
  return [...merged.values()]
    .sort((left, right) => {
      if (right.totalMessages !== left.totalMessages) {
        return right.totalMessages - left.totalMessages;
      }
      return (right.lastContactAt ?? "").localeCompare(left.lastContactAt ?? "");
    })
    .slice(0, limit);
}

export function mergeCountedEntries<T extends { count: number }>(
  perAccountEntries: T[][],
  keyOf: (entry: T) => string,
  topN: number,
): T[] {
  const merged = new Map<string, T>();
  for (const entries of perAccountEntries) {
    for (const entry of entries) {
      const key = keyOf(entry);
      const existing = merged.get(key);
      if (existing) {
        existing.count += entry.count;
      } else {
        merged.set(key, { ...entry });
      }
    }
  }
  return [...merged.values()].sort((left, right) => right.count - left.count).slice(0, topN);
}

export function mergeVolumeTrends(perAccountTrends: VolumeTrendPoint[][]): VolumeTrendPoint[] {
  const merged = new Map<string, VolumeTrendPoint>();
  for (const trends of perAccountTrends) {
    for (const point of trends) {
      const existing = merged.get(point.date);
      if (existing) {
        existing.count += point.count;
        existing.unreadCount += point.unreadCount;
        existing.starredCount += point.starredCount;
        existing.attachmentCount += point.attachmentCount;
      } else {
        merged.set(point.date, { ...point });
      }
    }
  }
  return [...merged.values()].sort((left, right) => left.date.localeCompare(right.date));
}

export function paginateRecentRecords<T>(records: T[], limit: number, offset: number): T[] {
  return records.slice(offset, offset + limit);
}
