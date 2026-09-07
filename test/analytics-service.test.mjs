import test from "node:test";
import assert from "node:assert/strict";
import { AnalyticsService } from "../dist/services/analytics-service.js";

function email(overrides = {}) {
  return {
    id: overrides.id ?? "INBOX::1",
    folder: "INBOX",
    uid: 1,
    seq: 1,
    subject: "Subject",
    from: [{ address: "sender@example.com" }],
    to: [{ address: "owner@example.com" }],
    cc: [],
    bcc: [],
    replyTo: [],
    isRead: true,
    isStarred: false,
    flags: [],
    hasAttachments: false,
    attachments: [],
    labels: [],
    ...overrides,
  };
}

test("getContacts counts incoming/outgoing separately and excludes the owner", () => {
  const service = new AnalyticsService();
  const owner = "owner@example.com";
  const emails = [
    // Incoming: from a contact, to the owner.
    email({
      id: "INBOX::1",
      from: [{ address: "alice@example.com", name: "Alice" }],
      to: [{ address: owner }],
      internalDate: "2026-03-01T10:00:00.000Z",
    }),
    email({
      id: "INBOX::2",
      from: [{ address: "alice@example.com" }],
      to: [{ address: owner }],
      internalDate: "2026-03-02T10:00:00.000Z",
    }),
    // Outgoing: from the owner, to the same contact.
    email({
      id: "Sent::3",
      folder: "Sent",
      from: [{ address: owner }],
      to: [{ address: "alice@example.com" }],
      internalDate: "2026-03-03T10:00:00.000Z",
    }),
  ];

  const contacts = service.getContacts(emails, 100, owner);

  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].address, "alice@example.com");
  assert.equal(contacts[0].incoming, 2);
  assert.equal(contacts[0].outgoing, 1);
  assert.equal(contacts[0].totalMessages, 3);
  assert.equal(contacts[0].lastContactAt, "2026-03-03T10:00:00.000Z");
  // The owner's own address must never appear as a "contact" of themself.
  assert.ok(!contacts.some((contact) => contact.address === owner));
});

test("getContacts counts one email once even when a contact's address appears in multiple fields", () => {
  const service = new AnalyticsService();
  const owner = "owner@example.com";
  const emails = [
    // Reply-To equal to From (very common) plus the same contact in To and Cc —
    // must still count as exactly one message toward this one contact.
    email({
      id: "INBOX::1",
      from: [{ address: "alice@example.com", name: "Alice" }],
      replyTo: [{ address: "alice@example.com" }],
      to: [{ address: owner }, { address: "alice@example.com" }],
      cc: [{ address: "alice@example.com" }],
      internalDate: "2026-03-01T10:00:00.000Z",
    }),
  ];

  const contacts = service.getContacts(emails, 100, owner);

  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].totalMessages, 1);
  assert.equal(contacts[0].incoming, 1);
});

test("getContacts recognizes a self-sent message from a plus-addressed alias as self, not a contact", () => {
  const service = new AnalyticsService();
  const owner = "owner@example.com";
  const emails = [
    email({
      id: "INBOX::1",
      from: [{ address: "owner+newsletter@example.com" }],
      to: [{ address: owner }],
      internalDate: "2026-03-01T10:00:00.000Z",
    }),
  ];

  const contacts = service.getContacts(emails, 100, owner);

  assert.equal(contacts.length, 0, "the plus-addressed self alias must not appear as a contact");
});

test("getContacts ranks by totalMessages, then most recent contact, and respects limit", () => {
  const service = new AnalyticsService();
  const owner = "owner@example.com";
  const emails = [
    email({ id: "1", from: [{ address: "frequent@example.com" }], to: [{ address: owner }], internalDate: "2026-01-01T00:00:00.000Z" }),
    email({ id: "2", from: [{ address: "frequent@example.com" }], to: [{ address: owner }], internalDate: "2026-01-02T00:00:00.000Z" }),
    email({ id: "3", from: [{ address: "rare@example.com" }], to: [{ address: owner }], internalDate: "2026-01-03T00:00:00.000Z" }),
  ];

  const contacts = service.getContacts(emails, 1, owner);

  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].address, "frequent@example.com");
});

test("getVolumeTrends buckets by UTC day and aggregates unread/starred/attachment counts", () => {
  const service = new AnalyticsService();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  const emails = [
    email({ id: "1", internalDate: now.toISOString(), isRead: false, isStarred: true, hasAttachments: true }),
    email({ id: "2", internalDate: now.toISOString(), isRead: true, isStarred: false, hasAttachments: false }),
  ];

  const trends = service.getVolumeTrends(emails, 7);
  const todayPoint = trends.find((point) => point.date === today);

  assert.equal(trends.length, 7);
  assert.ok(todayPoint);
  assert.equal(todayPoint.count, 2);
  assert.equal(todayPoint.unreadCount, 1);
  assert.equal(todayPoint.starredCount, 1);
  assert.equal(todayPoint.attachmentCount, 1);
});

test("getVolumeTrends ignores emails outside the requested day window", () => {
  const service = new AnalyticsService();
  const farPast = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const emails = [email({ id: "1", internalDate: farPast })];

  const trends = service.getVolumeTrends(emails, 7);
  const totalCounted = trends.reduce((sum, point) => sum + point.count, 0);

  assert.equal(totalCounted, 0);
});

test("getEmailAnalytics excludes the owner from topSenders/topDomains and surfaces insights", () => {
  const service = new AnalyticsService();
  const owner = "owner@example.com";
  const emails = [
    email({ id: "1", from: [{ address: "vendor@shop.com" }], internalDate: "2026-03-01T09:00:00.000Z" }),
    email({ id: "2", from: [{ address: "vendor@shop.com" }], internalDate: "2026-03-01T09:30:00.000Z" }),
    email({ id: "3", from: [{ address: owner }], internalDate: "2026-03-01T09:00:00.000Z" }),
  ];

  const analytics = service.getEmailAnalytics(emails, owner);

  assert.ok(!analytics.topSenders.some((entry) => entry.address === owner));
  assert.equal(analytics.topSenders[0].address, "vendor@shop.com");
  assert.equal(analytics.topSenders[0].count, 2);
  assert.equal(analytics.topDomains[0].domain, "shop.com");
  assert.equal(analytics.sampleSize, 3);
  assert.equal(analytics.insights.length, 3);
});

test("getEmailStats sums folder totals and derives sample stats from the dedup'd set", () => {
  const service = new AnalyticsService();
  const folders = [
    { path: "INBOX", name: "INBOX", delimiter: "/", listed: true, subscribed: true, flags: [], messages: 10, unseen: 3 },
    { path: "Archive", name: "Archive", delimiter: "/", listed: true, subscribed: true, flags: [], messages: 5, unseen: 0 },
  ];
  const emails = [
    email({ id: "1", isStarred: true, hasAttachments: true }),
    email({ id: "2", isStarred: false, hasAttachments: false }),
  ];

  const stats = service.getEmailStats(emails, folders, "owner@example.com");

  assert.equal(stats.mailbox.totalMessages, 15);
  assert.equal(stats.mailbox.unreadMessages, 3);
  assert.equal(stats.mailbox.folderCount, 2);
  assert.equal(stats.sample.size, 2);
  assert.equal(stats.sample.starredMessages, 1);
  assert.equal(stats.sample.messagesWithAttachments, 1);
});
