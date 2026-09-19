import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// A01 (audit 2.1.19): `reply` and `forward` built the message in the CLI process and
// called SMTP directly, bypassing RESTRICT_OUTBOUND_TO_SELF, CONFIRM_DESTRUCTIVE and
// the undo-send delay that every MCP send path enforces. They must go through the
// shared MCP handlers. There is no mail server here to prove the policy end to end, so
// this pins the structure that makes the bypass impossible: no direct SMTP call remains
// in the CLI, and both commands call the MCP tools.
test("CLI reply/forward delegate to the MCP handlers instead of calling SMTP directly", async () => {
  const source = await readFile(new URL("../dist/cli.js", import.meta.url), "utf8");
  assert.ok(!/smtpService\.sendEmail/.test(source), "the CLI must not send mail directly");
  const replyBody = source.slice(source.indexOf("async function runReply"), source.indexOf("async function runForward"));
  const forwardBody = source.slice(source.indexOf("async function runForward"), source.indexOf("async function runCreateFolder"));
  assert.match(replyBody, /name: "reply_to_email"/);
  assert.match(forwardBody, /name: "forward_email"/);
});
