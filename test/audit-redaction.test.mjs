import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditService } from "../dist/services/audit-service.js";
import { withAudit } from "../dist/index.js";

// The audit log is meant to record what was done, not the content of the mail or any secret. It stored message text
// under keys other than "body" (markdownBody, bodyEdits' find/replace, notes), several credential-like keys, and its
// error scrubber missed common secret shapes and mangled harmless text. A failed audit write also turned an
// operation that had already run into a tool error, so a client could retry a move or a send.

function recordingAudit() {
  const entries = [];
  return { entries, record: async (entry) => { entries.push(entry); } };
}

const run = async (input, result = { ok: true }) => {
  const audit = recordingAudit();
  await withAudit(audit, "send_email", input, async () => result);
  return audit.entries[0];
};

test("message text is redacted under every key it can arrive under", async () => {
  const entry = await run({
    body: "SECRET-BODY", markdownBody: "SECRET-MARKDOWN", htmlBody: "<p>SECRET-HTML</p>", textBody: "SECRET-TEXT",
    notes: "SECRET-NOTES", raw: "SECRET-RAW", rawBase64: "U0VDUkVU", content: "SECRET-CONTENT",
    bodyEdits: [{ find: "old password hunter2", replace: "new password hunter3" }],
  });
  const text = JSON.stringify(entry);
  for (const secret of ["SECRET-BODY", "SECRET-MARKDOWN", "SECRET-HTML", "SECRET-TEXT", "SECRET-NOTES", "SECRET-RAW", "U0VDUkVU", "SECRET-CONTENT", "hunter2", "hunter3"]) {
    assert.ok(!text.includes(secret), `${secret} leaked into the audit entry`);
  }
});

test("credential-like keys are redacted", async () => {
  const entry = await run({ password: "p1", pass: "p2", passwd: "p3", apiKey: "p4", api_key: "p5", authorization: "p6", credentials: "p7", clientSecret: "p8", accessToken: "p9", cookie: "p10" });
  const text = JSON.stringify(entry);
  for (const secret of ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10"]) {
    assert.ok(!new RegExp(`"${secret}"`).test(text), `${secret} leaked`);
  }
});

test("the things an audit log is for are still recorded", async () => {
  const entry = await run({ emailId: "INBOX::1::abc", action: "archive", folder: "Archive", dryRun: false, limit: 5 });
  assert.deepEqual(entry.input, { emailId: "INBOX::1::abc", action: "archive", folder: "Archive", dryRun: false, limit: 5 });
  assert.equal(entry.status, "success");
});

test("a failed audit write does not turn a successful operation into an error", async () => {
  const audit = { record: async () => { throw new Error("ENOSPC: no space left on device"); } };
  const result = await withAudit(audit, "move_email", {}, async () => ({ moved: true }));
  assert.deepEqual(result, { moved: true });
});

test("a failed audit write does not hide the operation's own error", async () => {
  const audit = { record: async () => { throw new Error("ENOSPC: no space left on device"); } };
  await assert.rejects(withAudit(audit, "move_email", {}, async () => { throw new Error("message not found"); }), /message not found/);
});

async function scrubbed(error) {
  const dir = await mkdtemp(join(tmpdir(), "audit-scrub-"));
  try {
    const service = new AuditService({
      smtp: { host: "h", port: 1, secure: false, username: "o@example.com", password: "x" },
      imap: { host: "h", port: 1, secure: false, username: "o@example.com", password: "x" },
      dataDir: dir, debug: false, runtime: {},
    });
    await service.record({ timestamp: new Date().toISOString(), tool: "t", status: "error", durationMs: 1, input: {}, error });
    return (await service.list(5))[0].error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("error text loses the secrets that commonly appear in it", async () => {
  for (const [input, secret] of [
    ["connect failed: password=hunter2 refused", "hunter2"],
    ["auth failed pass=hunter2", "hunter2"],
    ["bad token: token=abc123def", "abc123def"],
    ["api_key=sk-live-123", "sk-live-123"],
    ["Authorization: Bearer abc.def.ghi", "abc.def.ghi"],
    ["password: hunter2", "hunter2"],
    ['A1 LOGIN user@example.com "s3cret pw"', "s3cret pw"],
    ["connect imap://user:s3cret@127.0.0.1:1143 failed", "s3cret"],
  ]) {
    assert.ok(!(await scrubbed(input)).includes(secret), `${input} -> secret survived`);
  }
});

test("error text that is not secret is left readable (an address after 'From:' is not credentials)", async () => {
  assert.equal(await scrubbed("Message from: boss@example.com was not found"), "Message from: boss@example.com was not found");
  assert.equal(await scrubbed("Mailbox does not exist"), "Mailbox does not exist");
});
