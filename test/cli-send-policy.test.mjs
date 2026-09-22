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

// Found live: archive/trash/restore/mark-read/star already call
// ensureEmailActionAllowed (each pinned with its own comment in cli.ts), but
// move and delete still called ensureMailboxWriteAllowed only — so
// PROTONMAIL_ALLOWED_ACTIONS excluding "move"/"delete" had no effect on
// these two CLI shortcuts, even though the matching MCP tools (move_email,
// delete_email) enforce it. Same gap for delete-folder vs delete_folder/
// delete_label. Structural check, same style as the reply/forward test
// above: no server is spun up here, this pins that the right gate is wired
// into the right command.
test("CLI move/delete/delete-folder call ensureEmailActionAllowed, not just ensureMailboxWriteAllowed", async () => {
  const source = await readFile(new URL("../dist/cli.js", import.meta.url), "utf8");
  const body = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));

  const moveBody = body("async function runMove", "async function runArchive");
  assert.match(moveBody, /ensureEmailActionAllowed\(config\.runtime, "move"\)/);

  const deleteBody = body("async function runDelete", "async function runSend");
  assert.match(deleteBody, /ensureEmailActionAllowed\(config\.runtime, "delete"\)/);

  const deleteFolderBody = source.slice(source.indexOf("async function runDeleteFolder"));
  assert.match(deleteFolderBody, /ensureEmailActionAllowed\(config\.runtime, "delete"\)/);
});
