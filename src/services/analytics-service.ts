import type {
  ContactStats,
  EmailAddress,
  EmailSummary,
  FolderInfo,
  VolumeTrendPoint,
} from "../types/index.js";
import { dedupeEmails, extractDomain, isSelfAddress, lowerCaseAddress } from "../utils/helpers.js";

function extractAddresses(email: EmailSummary): EmailAddress[] {
  return [...email.from, ...email.to, ...email.cc, ...email.bcc, ...email.replyTo];
}

function toDayKey(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString().slice(0, 10);
}

export class AnalyticsService {
  clearCache(): void {
    return;
  }

  getEmailStats(emails: EmailSummary[], folders: FolderInfo[], ownerEmail?: string) {
    const deduped = dedupeEmails(emails);
    const totalMessages = folders.reduce((sum, folder) => sum + (folder.messages ?? 0), 0);
    const unreadMessages = folders.reduce((sum, folder) => sum + (folder.unseen ?? 0), 0);
    const contacts = this.getContacts(deduped, Number.MAX_SAFE_INTEGER, ownerEmail);

    return {
      generatedAt: new Date().toISOString(),
      mailbox: {
        folderCount: folders.length,
        totalMessages,
        unreadMessages,
      },
      sample: {
        size: deduped.length,
        starredMessages: deduped.filter((email) => email.isStarred).length,
        messagesWithAttachments: deduped.filter((email) => email.hasAttachments).length,
        uniqueContacts: contacts.length,
      },
      folders: folders.map((folder) => ({
        path: folder.path,
        messages: folder.messages ?? 0,
        unseen: folder.unseen ?? 0,
        specialUse: folder.specialUse,
      })),
    };
  }

  getEmailAnalytics(emails: EmailSummary[], ownerEmail?: string) {
    const deduped = dedupeEmails(emails);
    const hourCounts = new Map<number, number>();
    const senderCounts = new Map<string, number>();
    const domainCounts = new Map<string, number>();

    for (const email of deduped) {
      const date = new Date(email.internalDate || email.date || 0);
      if (!Number.isNaN(date.getTime())) {
        hourCounts.set(date.getUTCHours(), (hourCounts.get(date.getUTCHours()) ?? 0) + 1);
      }

      for (const sender of email.from) {
        const address = lowerCaseAddress(sender.address);
        // isSelfAddress also normalizes "+tag" plus-addressing — see its
        // definition for why a bare equality check on the owner's address
        // missed self-sent mail using a "+tag" alias.
        if (!address || isSelfAddress(address, ownerEmail)) {
          continue;
        }
        senderCounts.set(address, (senderCounts.get(address) ?? 0) + 1);

        const domain = extractDomain(address);
        if (domain) {
          domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
        }
      }
    }

    const busiestHours = [...hourCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([hour, count]) => ({
        hour: `${String(hour).padStart(2, "0")}:00Z`,
        count,
      }));

    const topSenders = [...senderCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 10)
      .map(([address, count]) => ({ address, count }));

    const topDomains = [...domainCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 10)
      .map(([domain, count]) => ({ domain, count }));

    const trends = this.getVolumeTrends(deduped, 30);
    const busiestDay = [...trends].sort((left, right) => right.count - left.count)[0];

    return {
      generatedAt: new Date().toISOString(),
      sampleSize: deduped.length,
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
    };
  }

  getContacts(emails: EmailSummary[], limit = 100, ownerEmail?: string): ContactStats[] {
    const contacts = new Map<string, ContactStats>();

    for (const email of dedupeEmails(emails)) {
      const fromAddresses = email.from
        .map((value) => ({ ...value, address: lowerCaseAddress(value.address) }))
        .filter((value) => Boolean(value.address));
      const toAddresses = [...email.to, ...email.cc, ...email.bcc]
        .map((value) => ({ ...value, address: lowerCaseAddress(value.address) }))
        .filter((value) => Boolean(value.address));

      const emailTimestamp = email.internalDate || email.date;
      const emailFromOwner = fromAddresses.some((value) => isSelfAddress(value.address, ownerEmail));

      // extractAddresses concatenates from/to/cc/bcc/replyTo without
      // deduping — very common for Reply-To to equal From, or for an
      // address to appear in both To and Cc. Iterating that raw list
      // counted the same email multiple times toward one contact's
      // totalMessages/incoming/outgoing. Dedupe per email first (first
      // occurrence's name wins) so one email always contributes at most
      // once per distinct contact.
      const seenInThisEmail = new Map<string, EmailAddress>();
      for (const address of extractAddresses(email)) {
        const normalizedAddress = lowerCaseAddress(address.address);
        if (normalizedAddress && !seenInThisEmail.has(normalizedAddress)) {
          seenInThisEmail.set(normalizedAddress, address);
        }
      }

      for (const [normalizedAddress, address] of seenInThisEmail) {
        if (isSelfAddress(normalizedAddress, ownerEmail)) {
          continue;
        }

        const contact = contacts.get(normalizedAddress) ?? {
          address: normalizedAddress,
          name: address.name,
          incoming: 0,
          outgoing: 0,
          totalMessages: 0,
          lastContactAt: undefined,
        };

        contact.totalMessages += 1;
        if (emailFromOwner) {
          if (toAddresses.some((value) => value.address === normalizedAddress)) {
            contact.outgoing += 1;
          }
        } else if (fromAddresses.some((value) => value.address === normalizedAddress)) {
          contact.incoming += 1;
        }

        if (
          emailTimestamp &&
          (!contact.lastContactAt ||
            new Date(emailTimestamp).getTime() > new Date(contact.lastContactAt).getTime())
        ) {
          contact.lastContactAt = new Date(emailTimestamp).toISOString();
        }

        contacts.set(normalizedAddress, contact);
      }
    }

    return [...contacts.values()]
      .sort((left, right) => {
        if (right.totalMessages !== left.totalMessages) {
          return right.totalMessages - left.totalMessages;
        }
        return (right.lastContactAt ?? "").localeCompare(left.lastContactAt ?? "");
      })
      .slice(0, limit);
  }

  getVolumeTrends(emails: EmailSummary[], days = 30): VolumeTrendPoint[] {
    const trendMap = new Map<string, VolumeTrendPoint>();
    const now = new Date();

    for (let index = days - 1; index >= 0; index -= 1) {
      const current = new Date(now.getTime() - index * 24 * 60 * 60 * 1000);
      const key = current.toISOString().slice(0, 10);
      trendMap.set(key, {
        date: key,
        count: 0,
        unreadCount: 0,
        starredCount: 0,
        attachmentCount: 0,
      });
    }

    for (const email of dedupeEmails(emails)) {
      const key = toDayKey(email.internalDate || email.date);
      if (!key || !trendMap.has(key)) {
        continue;
      }

      const point = trendMap.get(key)!;
      point.count += 1;
      if (!email.isRead) {
        point.unreadCount += 1;
      }
      if (email.isStarred) {
        point.starredCount += 1;
      }
      if (email.hasAttachments) {
        point.attachmentCount += 1;
      }
    }

    return [...trendMap.values()];
  }
}
