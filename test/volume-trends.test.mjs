import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalIndexService } from "../dist/services/local-index-service.js";

// get_volume_trends counted from a sample of the newest 3000 messages, so on a mailbox with more mail than that
// in the window the oldest days came out too low (34 against an actual 130) with no sign that anything was cut.

function createConfig(dataDir) {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" },
    dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false,
      autoSyncLimitPerFolder: 100, idleWatchEnabled: false, idleMaxSeconds: 30 },
  };
}

const dayAgo = (n, hour = 12) => {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};
const key = (iso) => iso.slice(0, 10);

function mail(uid, date, extra = {}) {
  return {
    id: `INBOX::${uid}`, folder: "INBOX", uid, seq: uid, messageId: `<v${uid}@x.example>`, subject: `S${uid}`,
    from: [{ address: "a@x.example" }], to: [{ address: "owner@example.com" }], cc: [], bcc: [], replyTo: [],
    date, internalDate: date, isRead: true, isStarred: false, flags: [], preview: "p", hasAttachments: false, attachments: [], labels: [], ...extra,
  };
}

async function withIndex(emails, fn) {
  const dir = await mkdtemp(join(tmpdir(), "protonmail-volume-"));
  const service = new LocalIndexService(createConfig(dir));
  try {
    await service.recordSnapshot({
      syncedAt: new Date().toISOString(),
      folders: [{ path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", listed: true, subscribed: true, flags: [], messages: emails.length, unseen: 0 }],
      folderStats: [{ folder: "INBOX", fetched: emails.length, total: emails.length, strategy: "recent" }],
      emails,
    });
    await fn(service);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("daily volume counts every message in the window, not a sample of the newest 3000", async () => {
  const old = dayAgo(5);
  const emails = [
    ...Array.from({ length: 3500 }, (_, i) => mail(i + 1, dayAgo(1, 8 + (i % 4)))),
    ...Array.from({ length: 130 }, (_, i) => mail(4000 + i, old)),
  ];
  await withIndex(emails, async (service) => {
    const points = await service.getDailyVolume(30);
    const byDay = new Map(points.map((p) => [p.date, p]));
    assert.equal(byDay.get(key(dayAgo(1))).count, 3500);
    assert.equal(byDay.get(key(old)).count, 130, "the older day is not cut by a sample limit");
  });
});

test("daily volume has one point per day, zero-filled, oldest first, for the requested number of days", async () => {
  await withIndex([mail(1, dayAgo(2))], async (service) => {
    const points = await service.getDailyVolume(7);
    assert.equal(points.length, 7);
    assert.deepEqual(points.map((p) => p.date), [...points.map((p) => p.date)].sort());
    assert.equal(points.at(-1).date, key(new Date().toISOString()));
    assert.equal(points.filter((p) => p.count > 0).length, 1);
    assert.equal(points.find((p) => p.date === key(dayAgo(2))).count, 1);
  });
});

test("daily volume counts unread, starred and attachment messages", async () => {
  const day = dayAgo(1);
  await withIndex([
    mail(1, day, { isRead: false }), mail(2, day, { isRead: false, isStarred: true }), mail(3, day, { hasAttachments: true, attachments: [{ filename: "a.pdf", contentType: "application/pdf", kind: "document" }] }), mail(4, day),
  ], async (service) => {
    const point = (await service.getDailyVolume(5)).find((p) => p.date === key(day));
    assert.deepEqual([point.count, point.unreadCount, point.starredCount, point.attachmentCount], [4, 2, 1, 1]);
  });
});

test("a message that appears in two folders (same Message-ID) is counted once", async () => {
  const day = dayAgo(1);
  const first = mail(1, day);
  const copy = { ...mail(2, day), messageId: first.messageId, folder: "Archive", id: "Archive::2" };
  const dir = await mkdtemp(join(tmpdir(), "protonmail-volume-dup-"));
  const service = new LocalIndexService(createConfig(dir));
  try {
    await service.recordSnapshot({
      syncedAt: new Date().toISOString(),
      folders: [
        { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", listed: true, subscribed: true, flags: [], messages: 1, unseen: 0 },
        { path: "Archive", name: "Archive", delimiter: "/", specialUse: "\\Archive", listed: true, subscribed: true, flags: [], messages: 1, unseen: 0 },
      ],
      folderStats: [{ folder: "INBOX", fetched: 1, total: 1, strategy: "recent" }, { folder: "Archive", fetched: 1, total: 1, strategy: "recent" }],
      emails: [first, copy],
    });
    const point = (await service.getDailyVolume(5)).find((p) => p.date === key(day));
    assert.equal(point.count, 1);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("messages older than the window are not counted", async () => {
  await withIndex([mail(1, dayAgo(40)), mail(2, dayAgo(1))], async (service) => {
    const points = await service.getDailyVolume(10);
    assert.equal(points.reduce((sum, p) => sum + p.count, 0), 1);
  });
});
