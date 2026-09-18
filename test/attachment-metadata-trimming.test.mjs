import test from "node:test";
import assert from "node:assert/strict";
import { projectFields, trimAttachmentsForListing } from "../dist/utils/helpers.js";

// Regression test for a token-efficiency finding made live at the user's own
// request ("dla mnie wazne jest by nie zrzeralo duzo tokenow niepotrzebnie" /
// "bardziej mi chodzi o oszczednosc w uzywaniu a nie tylko odpalaniu" — savings
// during actual per-call USE, not just session-start tool-schema cost).
// Confirmed live via search_indexed_emails: every attachment on every search/
// list result carried all 12 EmailAttachmentSummary fields (id, filename,
// contentType, size, disposition, part, cid, checksum, isInline, kind,
// isCalendarInvite, isSignature) regardless of whether the caller ever used
// the extra 7 — on every single call, not once per session. Trimmed to the 5
// fields actually needed to see and act on a result (id is required for
// get_attachment_content/save_attachment/list_attachments); full detail
// remains available via list_attachments(emailId) or get_email_by_id.

function makeAttachment(overrides = {}) {
  return {
    id: "att-1",
    filename: "invoice.pdf",
    contentType: "application/pdf",
    size: 199942,
    disposition: "attachment",
    part: "2",
    cid: "39D4751A@example.com",
    checksum: "bfa47b067753908a26d62113abd8c231",
    isInline: false,
    kind: "document",
    isCalendarInvite: false,
    isSignature: false,
    ...overrides,
  };
}

test("trimAttachmentsForListing keeps only the essential fields per attachment", () => {
  const email = { id: "e1", subject: "Invoice", attachments: [makeAttachment()] };
  const result = trimAttachmentsForListing(email);
  assert.deepEqual(result.attachments[0], {
    id: "att-1",
    filename: "invoice.pdf",
    contentType: "application/pdf",
    size: 199942,
    disposition: "attachment",
  });
  assert.ok(!("checksum" in result.attachments[0]));
  assert.ok(!("cid" in result.attachments[0]));
  assert.ok(!("kind" in result.attachments[0]));
  assert.ok(!("isCalendarInvite" in result.attachments[0]));
  assert.ok(!("isSignature" in result.attachments[0]));
});

test("trimAttachmentsForListing is a no-op for an item with no attachments", () => {
  const email = { id: "e1", subject: "No attachments" };
  const result = trimAttachmentsForListing(email);
  assert.deepEqual(result, email);
});

test("trimAttachmentsForListing does not mutate the original item", () => {
  const email = { id: "e1", attachments: [makeAttachment()] };
  trimAttachmentsForListing(email);
  assert.equal(email.attachments[0].checksum, "bfa47b067753908a26d62113abd8c231", "the original object must be untouched");
});

// Regression test: attachmentText is up to 8,000 chars of extracted text PER
// text/html, text/calendar, or plain-text attachment (populated by default
// during indexing so keyword search can match document content) — found live
// to be echoed in full on every search/list result that has one, same
// over-sharing class of bug as the 12-field attachment metadata above.
test("trimAttachmentsForListing drops attachmentText entirely (key absent, not just empty)", () => {
  const email = { id: "e1", subject: "Meeting invite", attachmentText: "BEGIN:VCALENDAR\n".repeat(500) };
  const result = trimAttachmentsForListing(email);
  assert.equal("attachmentText" in result, false, "the key must be absent, not present with an empty/undefined value");
  assert.equal(result.subject, "Meeting invite", "other fields must survive unchanged");
});

test("trimAttachmentsForListing drops attachmentText even when there are no attachments in the summary array", () => {
  // attachmentText can be populated from an attachment that itself isn't
  // otherwise listed in `attachments` in some edge cases — the two fields are
  // independent, so this must not depend on `attachments` being present.
  const email = { id: "e1", attachmentText: "some extracted text" };
  const result = trimAttachmentsForListing(email);
  assert.equal("attachmentText" in result, false);
});

// Regression test: references is the RFC 2822 Message-ID chain for the whole
// thread — can be a dozen-plus entries for a message deep in a long thread.
// Nothing here ever reads it back FROM a search/list result: reply/forward/
// draft tools all re-fetch the original message's full detail internally
// (getEmailById) to build their own references, never from a caller-supplied
// value. Found live carried on every search/list result regardless.
test("trimAttachmentsForListing drops references entirely (key absent, not just empty)", () => {
  const email = { id: "e1", subject: "Deep thread reply", references: ["<a@example.com>", "<b@example.com>", "<c@example.com>"] };
  const result = trimAttachmentsForListing(email);
  assert.equal("references" in result, false, "the key must be absent, not present with an empty/undefined value");
  assert.equal(result.subject, "Deep thread reply", "other fields must survive unchanged");
});

test("trimAttachmentsForListing drops references even when there are no attachments or attachmentText", () => {
  const email = { id: "e1", references: ["<only-one@example.com>"] };
  const result = trimAttachmentsForListing(email);
  assert.equal("references" in result, false);
});

test("projectFields trims attachments even when no fields filter is requested (the default case)", () => {
  const items = [{ id: "e1", subject: "Invoice", attachments: [makeAttachment()] }];
  const result = projectFields(items);
  assert.equal(result[0].subject, "Invoice", "non-attachment fields must survive unchanged with no fields filter");
  assert.deepEqual(Object.keys(result[0].attachments[0]).sort(), ["contentType", "disposition", "filename", "id", "size"]);
});

test("projectFields trims attachments in combination with an explicit fields filter too", () => {
  const items = [{ id: "e1", subject: "Invoice", from: [{ address: "a@example.com" }], attachments: [makeAttachment()] }];
  const result = projectFields(items, ["subject", "attachments"]);
  assert.deepEqual(Object.keys(result[0]).sort(), ["attachments", "id", "subject"]);
  assert.deepEqual(Object.keys(result[0].attachments[0]).sort(), ["contentType", "disposition", "filename", "id", "size"]);
});
