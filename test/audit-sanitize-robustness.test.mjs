import test from "node:test";
import assert from "node:assert/strict";
import { withAudit } from "../dist/index.js";

// Found by the first run against a real Bridge: list_scheduled_sends / list_snoozed
// returned `{ bundle, items }` from inside withAudit; with a live IMAP connection in the
// bundle the audit sanitizer recursed through it and overflowed the stack, failing the tool.

function recorder() {
  const records = [];
  return { records, async record(entry) { records.push(entry); } };
}

test("withAudit survives a result holding a cyclic, service-laden account bundle and never dumps its internals", async () => {
  class FakeImapService { constructor() { this.socket = { owner: this }; this.password = "hunter2"; } }
  const bundle = { account: { slug: "a" }, imapService: new FakeImapService() };
  bundle.self = bundle;
  const audit = recorder();

  const result = await withAudit(audit, "list_scheduled_sends", {}, async () => [{ bundle, items: [{ id: "1" }] }]);

  assert.equal(result[0].bundle, bundle, "the real result is returned untouched");
  const logged = JSON.stringify(audit.records[0].result);
  assert.ok(!logged.includes("hunter2"));
  assert.match(logged, /\[account bundle\]/);
  assert.match(logged, /"id":"1"/, "ordinary data is still audited");
});

test("withAudit handles a very deep object and class instances without overflowing", async () => {
  let deep = { end: true };
  for (let i = 0; i < 5000; i++) deep = { next: deep };
  const audit = recorder();
  await withAudit(audit, "t", { deep }, async () => ({ instance: new (class Foo { constructor() { this.x = 1; } })(), deep }));
  assert.equal(audit.records[0].status, "success");
  assert.match(JSON.stringify(audit.records[0].result), /\[Foo\]/);
});

test("existing audit redaction is unchanged (secrets, bodies, long strings, attachments)", async () => {
  const audit = recorder();
  await withAudit(audit, "t", { body: "secret text", apiToken: "x", note: "y".repeat(400), attachments: [{ filename: "f", contentType: "c", content: "AAAA" }] }, async () => "ok");
  const input = audit.records[0].input;
  assert.equal(input.body, "[redacted]");
  assert.equal(input.apiToken, "[redacted]");
  assert.match(input.note, /^\[redacted:400 chars\]$/);
  assert.deepEqual(input.attachments, [{ filename: "f", contentType: "c", cid: undefined }]);
});
