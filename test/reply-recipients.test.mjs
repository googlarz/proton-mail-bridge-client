import test from "node:test";
import assert from "node:assert/strict";
import { getReplyRecipients } from "../dist/index.js";

function detailWithFrom(fromAddresses, { to = [], cc = [], replyTo = [] } = {}) {
  return {
    id: "INBOX::1",
    folder: "INBOX",
    uid: 1,
    seq: 1,
    subject: "Test",
    from: fromAddresses.map((address) => ({ address })),
    to: to.map((address) => ({ address })),
    cc: cc.map((address) => ({ address })),
    bcc: [],
    replyTo: replyTo.map((address) => ({ address })),
    isRead: false,
    isStarred: false,
    flags: [],
    hasAttachments: false,
    attachments: [],
    labels: [],
  };
}

test("getReplyRecipients replies to the sender when it isn't the owner", () => {
  const detail = detailWithFrom(["someone@example.com"]);
  const recipients = getReplyRecipients(detail, "owner@example.com", false);
  assert.deepEqual(recipients.to, ["someone@example.com"]);
});

test("getReplyRecipients falls back to the owner's own address for a self-addressed email", () => {
  // Reproduces the real bug: a "note to self" email has from === owner, so
  // stripping the owner out left zero recipients and every reply threw
  // "Unable to infer reply recipient." Found live replying to a self-sent
  // test fixture. Every real mail client replies back to the same address.
  const detail = detailWithFrom(["owner@example.com"]);
  const recipients = getReplyRecipients(detail, "owner@example.com", false);
  assert.deepEqual(recipients.to, ["owner@example.com"]);
});

test("getReplyRecipients replyAll still excludes the owner from cc when self-addressed", () => {
  const detail = detailWithFrom(["owner@example.com"], { to: ["owner@example.com"], cc: ["third@example.com"] });
  const recipients = getReplyRecipients(detail, "owner@example.com", true);
  assert.deepEqual(recipients.to, ["owner@example.com"]);
  assert.deepEqual(recipients.cc, ["third@example.com"]);
});

test("getReplyRecipients on a message the owner SENT replies to the original To, not to self", () => {
  const detail = detailWithFrom(["owner@example.com"], { to: ["alice@example.com"], cc: ["bob@example.com"] });
  const single = getReplyRecipients(detail, "owner@example.com", false);
  assert.deepEqual(single.to, ["alice@example.com"]);
  assert.deepEqual(single.cc, []);
  const all = getReplyRecipients(detail, "owner@example.com", true);
  assert.deepEqual(all.to, ["alice@example.com"]);
  assert.deepEqual(all.cc, ["bob@example.com"]);
});

test("getReplyRecipients treats a +tag alias of the owner as self on a sent message", () => {
  const detail = detailWithFrom(["owner+news@example.com"], { to: ["alice@example.com", "owner@example.com"] });
  const recipients = getReplyRecipients(detail, "owner@example.com", true);
  assert.deepEqual(recipients.to, ["alice@example.com"]);
  assert.deepEqual(recipients.cc, []);
});

test("getReplyRecipients treats other configured accounts as self", () => {
  const detail = detailWithFrom(["work@example.com"], { to: ["alice@example.com", "owner@example.com"] });
  const recipients = getReplyRecipients(detail, "owner@example.com", true, ["work@example.com", "owner@example.com"]);
  assert.deepEqual(recipients.to, ["alice@example.com"]);
  assert.deepEqual(recipients.cc, []);
});

test("getReplyRecipients keeps replying to self for a note-to-self even with other accounts configured", () => {
  const detail = detailWithFrom(["owner@example.com"], { to: ["owner@example.com"] });
  const recipients = getReplyRecipients(detail, "owner@example.com", false, ["work@example.com"]);
  assert.deepEqual(recipients.to, ["owner@example.com"]);
});

test("a reply to a message we sent ignores our own Reply-To and goes to the original recipients", () => {
  const detail = {
    from: [{ address: "me@example.com" }],
    replyTo: [{ address: "alias@elsewhere.test" }],
    to: [{ address: "bob@example.org" }],
    cc: [{ address: "alice@example.org" }],
  };
  assert.deepEqual(getReplyRecipients(detail, "me@example.com", false), { to: ["bob@example.org"], cc: [] });
  assert.deepEqual(getReplyRecipients(detail, "me@example.com", true), { to: ["bob@example.org"], cc: ["alice@example.org"] });
});

test("a reply to someone else's message still honours that message's Reply-To", () => {
  const detail = { from: [{ address: "list@example.org" }], replyTo: [{ address: "owner@example.org" }], to: [{ address: "me@example.com" }], cc: [] };
  assert.deepEqual(getReplyRecipients(detail, "me@example.com", false), { to: ["owner@example.org"], cc: [] });
});

test("reply-all keeps the original sender in Cc when Reply-To redirects the To", () => {
  const detail = detailWithFrom(["alice@example.com"], { to: ["owner@example.com", "bob@example.com"], replyTo: ["list@example.com"] });
  const recipients = getReplyRecipients(detail, "owner@example.com", true);
  assert.deepEqual(recipients.to, ["list@example.com"]);
  assert.deepEqual(recipients.cc.sort(), ["alice@example.com", "bob@example.com"]);
  assert.deepEqual(getReplyRecipients(detail, "owner@example.com", false).cc, []);
});

test("reply-all without Reply-To does not duplicate the sender", () => {
  const detail = detailWithFrom(["alice@example.com"], { to: ["owner@example.com", "bob@example.com"] });
  const recipients = getReplyRecipients(detail, "owner@example.com", true);
  assert.deepEqual(recipients.to, ["alice@example.com"]);
  assert.deepEqual(recipients.cc, ["bob@example.com"]);
});
