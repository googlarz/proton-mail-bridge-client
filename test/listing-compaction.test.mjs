import test from "node:test";
import assert from "node:assert/strict";
import { compactListingFields, projectFields } from "../dist/utils/helpers.js";

// Found live on real search_indexed_emails output: each result still carried
// seq, empty bcc/labels/attachments arrays, replyTo identical to from,
// internalDate seconds off date, "name":"" on nameless addresses, and
// flags:["\\Seen"] restating isRead:true. All lossless to drop — absent key
// means empty / equal / derivable.

const base = () => ({
  id: "INBOX::1::14::abcd",
  folder: "INBOX",
  uid: 14,
  seq: 12,
  subject: "Hi",
  from: [{ name: "Ann", address: "ann@example.com" }],
  to: [{ name: "", address: "me@example.com" }],
  cc: [],
  bcc: [],
  replyTo: [{ name: "Ann", address: "ANN@example.com" }],
  date: "2026-09-08T12:55:35.000Z",
  internalDate: "2026-09-08T12:55:37.000Z",
  isRead: true,
  isStarred: false,
  flags: ["\\Seen"],
  labels: [],
  attachments: [],
});

test("compactListingFields drops seq, empty arrays, and derivable flags", () => {
  const out = compactListingFields(base());
  for (const key of ["seq", "cc", "bcc", "labels", "attachments", "flags"]) {
    assert.equal(key in out, false, `${key} should be absent`);
  }
  assert.equal(out.uid, 14, "uid must stay — it's the beforeUid pagination cursor");
});

test("compactListingFields drops replyTo only when it equals from (case-insensitive)", () => {
  assert.equal("replyTo" in compactListingFields(base()), false);
  const different = { ...base(), replyTo: [{ address: "other@example.com" }] };
  assert.equal(compactListingFields(different).replyTo[0].address, "other@example.com");
});

test("compactListingFields drops internalDate only when within a minute of date", () => {
  assert.equal("internalDate" in compactListingFields(base()), false);
  const far = { ...base(), internalDate: "2026-09-09T12:55:37.000Z" };
  assert.ok("internalDate" in compactListingFields(far));
});

test("compactListingFields drops empty address names but keeps real ones", () => {
  const out = compactListingFields(base());
  assert.deepEqual(out.to, [{ address: "me@example.com" }]);
  assert.equal(out.from[0].name, "Ann");
});

test("compactListingFields keeps flags beyond Seen/Flagged (e.g. Answered)", () => {
  const out = compactListingFields({ ...base(), flags: ["\\Answered", "\\Seen"] });
  assert.deepEqual(out.flags, ["\\Answered"]);
});

test("compactListingFields does not mutate its input and leaves non-objects alone", () => {
  const input = base();
  compactListingFields(input);
  assert.equal(input.seq, 12);
  assert.equal(input.bcc.length, 0);
  assert.equal(compactListingFields(null), null);
});

test("projectFields applies the compaction on the default (no fields) path", () => {
  const [out] = projectFields([base()]);
  assert.equal("seq" in out, false);
  assert.equal(out.subject, "Hi");
});
