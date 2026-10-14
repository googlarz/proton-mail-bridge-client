import test from "node:test";
import assert from "node:assert/strict";
import { classifyAttachment, isTextLikeMimeType, mimeHeaderString } from "../dist/utils/helpers.js";

test("mimeHeaderString returns strings unchanged and reduces structured header values", () => {
  assert.equal(mimeHeaderString("Text/Calendar"), "Text/Calendar");
  assert.equal(mimeHeaderString({ value: "application/pdf", params: { name: "a.pdf" } }), "application/pdf");
  assert.equal(mimeHeaderString(["image/png"]), "image/png");
  assert.equal(mimeHeaderString([{ value: "text/plain" }, "ignored"]), "text/plain");
  assert.equal(mimeHeaderString([undefined, "", "message/rfc822"]), "message/rfc822");
  for (const empty of [undefined, null, 42, true, {}, [], [{}], { value: 7 }]) {
    assert.equal(mimeHeaderString(empty), "", `expected "" for ${JSON.stringify(empty)}`);
  }
});

test("classifyAttachment does not throw on non-string header values from malformed messages", () => {
  // Found live: a legacy imported message made the background index sync fail on every tick with
  // "input.contentType?.toLowerCase is not a function".
  assert.deepEqual(classifyAttachment({ contentType: { value: "text/calendar" } }), {
    kind: "calendar",
    isCalendarInvite: true,
    isSignature: false,
  });
  assert.equal(classifyAttachment({ contentType: ["application/pkcs7-signature"] }).kind, "signature");
  assert.equal(classifyAttachment({ filename: { value: "photo.JPG" } }).kind, "image");
  assert.equal(classifyAttachment({ contentType: 42, filename: null, disposition: {}, cid: [] }).kind, "other");
});

test("classifyAttachment behaves as before for ordinary string values", () => {
  assert.equal(classifyAttachment({ contentType: "TEXT/CALENDAR" }).kind, "calendar");
  assert.equal(classifyAttachment({ filename: "smime.p7s" }).kind, "signature");
  assert.equal(classifyAttachment({ contentType: "image/png" }).kind, "image");
  assert.equal(classifyAttachment({ contentType: "message/rfc822" }).kind, "message");
});

test("isTextLikeMimeType accepts structured values and rejects non-strings", () => {
  assert.equal(isTextLikeMimeType({ value: "application/json" }), true);
  assert.equal(isTextLikeMimeType(["text/csv"]), true);
  assert.equal(isTextLikeMimeType(42), false);
  assert.equal(isTextLikeMimeType(undefined), false);
  assert.equal(isTextLikeMimeType("image/png"), false);
});
