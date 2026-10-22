import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { createEmailId, slugifyAccountAddress } from "../dist/utils/helpers.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";


function accountConfig(dataDir, address) {
  return {
    address, slug: slugifyAccountAddress(address),
    imap: { host: "127.0.0.1", port: 9, secure: false, username: address, password: "x" },
    smtp: { host: "127.0.0.1", port: 9, secure: false, username: address, password: "x" },
    dataDir,
  };
}

async function withServer(addresses, fn, allowedActions = ["delete"]) {
  const dirs = await Promise.all(addresses.map(() => mkdtemp(join(tmpdir(), "folder-account-"))));
  const accounts = addresses.map((address, i) => accountConfig(dirs[i], address));
  const config = {
    smtp: accounts[0].smtp, imap: accounts[0].imap, dataDir: dirs[0], debug: false, cacheEnabled: true,
    analyticsEnabled: true, autoSync: false, syncInterval: 5,
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions, startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
      confirmDestructive: false, allowEmptyFolder: true, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0 },
    accounts,
  };
  const { server, accountManager } = createServer(config, { startBackgroundSync: false });
  const bundles = accountManager.all();
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try { await fn({ client, bundles }); } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
  }
}



// A tool that ran and failed answers with an isError result carrying the real message, so Claude Desktop shows it to
// the model (it hides protocol errors behind a generic "connector returned an error"). Only a tool that does not
// exist is still a protocol error. The CLI starts the server with PROTONMAIL_TOOL_ERRORS=protocol to keep its stderr.

test("a refused call comes back as an isError result with the message, not as a thrown protocol error", async () => {
  await withServer(["owner@example.com"], async ({ client }) => {
    const result = await client.callTool({ name: "mark_email_read", arguments: { emailId: "INBOX::1", isRead: "perhaps" } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /true or false/i);
    assert.doesNotMatch(result.content[0].text, /^MCP error/);
  });
});

test("an argument problem, a policy refusal and a missing resource all read the same way", async () => {
  await withServer(["owner@example.com"], async ({ client }) => {
    for (const [name, args, message] of [
      ["get_email_by_id", { emailId: "not-an-id" }, /emailId|identifier/i],
      ["send_email", { to: "a@b.test" }, /subject|body|required/i],
      ["bulk_delete", { folder: "INBOX", match: { from: "a@b.test" } }, /disabled by the current runtime policy/i],
    ]) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, name);
      assert.match(result.content[0].text, message, name);
    }
  });
});

test("a tool that does not exist is still a protocol error", async () => {
  await withServer(["owner@example.com"], async ({ client }) => {
    await assert.rejects(client.callTool({ name: "no_such_tool", arguments: {} }), /Unknown tool/);
  });
});

test("PROTONMAIL_TOOL_ERRORS=protocol (the CLI's setting) keeps the thrown error", async () => {
  const saved = process.env.PROTONMAIL_TOOL_ERRORS;
  process.env.PROTONMAIL_TOOL_ERRORS = "protocol";
  try {
    await withServer(["owner@example.com"], async ({ client }) => {
      await assert.rejects(client.callTool({ name: "mark_email_read", arguments: { emailId: "INBOX::1", isRead: "perhaps" } }), /true or false/i);
    });
  } finally {
    if (saved === undefined) delete process.env.PROTONMAIL_TOOL_ERRORS; else process.env.PROTONMAIL_TOOL_ERRORS = saved;
  }
});

test("a failed connection says what to do: wrong password, Bridge not running, TLS mode", async () => {
  await withServer(["owner@example.com"], async ({ client, bundles }) => {
    const cases = [
      [new Error("Invalid credentials: login failed"), /Bridge password/],
      [Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1143"), { code: "ECONNREFUSED" }), /Bridge app is running/],
      [Object.assign(new Error("wrong version number"), { code: "EPROTO" }), /implicit TLS vs STARTTLS/],
    ];
    for (const [error, expected] of cases) {
      bundles[0].imapService.getFolders = async () => { throw error; };
      const result = await client.callTool({ name: "get_folders", arguments: {} });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, expected);
    }
  });
});

test("a protocol error carries its MCP prefix once, not once per layer", async () => {
  const previous = process.env.PROTONMAIL_TOOL_ERRORS;
  process.env.PROTONMAIL_TOOL_ERRORS = "protocol";
  try {
    await withServer(["owner@example.com"], async ({ client }) => {
      await assert.rejects(client.callTool({ name: "get_email_by_id", arguments: { emailId: "bad-id" } }), (error) => {
        assert.equal((error.message.match(/MCP error/g) ?? []).length, 1, error.message);
        return true;
      });
    });
  } finally {
    if (previous === undefined) delete process.env.PROTONMAIL_TOOL_ERRORS; else process.env.PROTONMAIL_TOOL_ERRORS = previous;
  }
});

test("import_email goes to the account named by the argument or the folder prefix, and move_email prefixes every id it returns", async () => {
  await withServer(["owner@example.com", "work@example.com"], async ({ client, bundles }) => {
    const [primary, work] = bundles;
    const calls = [];
    primary.imapService.importEmail = async (input) => { calls.push(["primary", input.targetFolder]); return { folder: input.targetFolder, uid: 1, emailId: "INBOX::1::x" }; };
    work.imapService.importEmail = async (input) => { calls.push(["work", input.targetFolder]); return { folder: input.targetFolder, uid: 2, emailId: "Archive::2::y" }; };
    const raw = "From: a@example.com\r\nSubject: s\r\n\r\nbody";
    const byArgument = await client.callTool({ name: "import_email", arguments: { raw, account: "work@example.com", targetFolder: "Archive" } });
    const byPrefix = await client.callTool({ name: "import_email", arguments: { raw, targetFolder: `${work.account.slug}::Archive` } });
    const plain = await client.callTool({ name: "import_email", arguments: { raw } });
    assert.deepEqual(calls, [["work", "Archive"], ["work", "Archive"], ["primary", "INBOX"]]);
    assert.ok(JSON.parse(byArgument.content[0].text).emailId.startsWith(`${work.account.slug}::`));
    assert.ok(JSON.parse(byPrefix.content[0].text).emailId.startsWith(`${work.account.slug}::`));
    assert.equal(JSON.parse(plain.content[0].text).emailId, "INBOX::1::x", "the primary account keeps bare ids");

    const folders = [{ path: "Archive", name: "Archive", delimiter: "/", flags: [], listed: true, subscribed: true }];
    work.imapService.getFolders = async () => folders;
    work.imapService.getFolderStructure = async () => folders;
    work.imapService.isTrashFolder = async () => false;
    work.imapService.moveEmail = async (emailId) => ({ emailId, sourceEmailId: emailId, fromFolder: "INBOX", targetFolder: "Archive", uid: 1, targetUid: 2, targetEmailId: "Archive::2::y" });
    const moved = await client.callTool({ name: "move_email", arguments: { emailId: `${work.account.slug}::${createEmailId("INBOX", 1, "100")}`, targetFolder: "Archive" } });
    const parsed = JSON.parse(moved.content[0].text);
    for (const key of ["emailId", "sourceEmailId", "targetEmailId"]) {
      assert.ok(parsed[key].startsWith(`${work.account.slug}::`), `${key} is prefixed: ${parsed[key]}`);
    }
  }, ["delete", "move"]);
});

test("every tool that names a message answers with the account's prefix on a non-primary account", async () => {
  await withServer(["owner@example.com", "work@example.com"], async ({ client, bundles }) => {
    const work = bundles[1];
    const slug = work.account.slug;
    const folders = [{ path: "Archive", name: "Archive", delimiter: "/", flags: [], listed: true, subscribed: true, specialUse: "\\Archive" }, { path: "Trash", name: "Trash", delimiter: "/", flags: [], listed: true, subscribed: true, specialUse: "\\Trash" }];
    work.imapService.getFolders = async () => folders;
    work.imapService.getFolderStructure = async () => folders;
    work.imapService.isTrashFolder = async (path) => path === "Trash";
    const moved = async (emailId) => ({ emailId, sourceEmailId: emailId, fromFolder: "INBOX", targetFolder: "Archive", uid: 1, targetUid: 2, targetEmailId: "Archive::2::y" });
    work.imapService.archiveEmail = moved;
    work.imapService.trashEmail = moved;
    work.imapService.restoreEmail = moved;
    work.imapService.moveEmail = moved;
    work.imapService.markEmailRead = async (emailId, isRead) => ({ emailId, isRead });
    work.imapService.starEmail = async (emailId, isStarred) => ({ emailId, isStarred });
    work.imapService.deleteEmail = async (emailId) => ({ emailId, deleted: true });
    const id = `${slug}::${createEmailId("INBOX", 1, "100")}`;
    const calls = {
      archive_email: {}, trash_email: {}, restore_email: { targetFolder: "INBOX" }, move_email: { targetFolder: "Archive" },
      mark_email_read: {}, star_email: {}, delete_email: { confirmed: true, permanent: true },
    };
    const ids = (value) => ["emailId", "sourceEmailId", "targetEmailId"].filter((key) => typeof value[key] === "string").map((key) => [key, value[key]]);
    for (const [tool, extra] of Object.entries(calls)) {
      const result = await client.callTool({ name: tool, arguments: { emailId: id, ...extra } });
      assert.ok(!result.isError, `${tool}: ${result.content[0].text}`);
      const found = ids(JSON.parse(result.content[0].text));
      assert.ok(found.length > 0, `${tool} names a message`);
      for (const [key, value] of found) assert.ok(value.startsWith(`${slug}::`), `${tool}.${key} is not prefixed: ${value}`);
    }
  }, ["delete", "move", "archive", "trash", "restore", "mark_read", "mark_unread", "star", "unstar"]);
});

test("get_emails and folder_stats ask every account, report the one that lacks the folder, and honour a <slug>:: prefix", async () => {
  await withServer(["owner@example.com", "work@example.com"], async ({ client, bundles }) => {
    const [primary, work] = bundles;
    const asked = [];
    const page = (total) => ({ folder: "Folders/News", total, limit: 50, offset: 0, emails: [] });
    primary.imapService.getEmails = async () => { throw new Error("Command failed: no such mailbox"); };
    work.imapService.getEmails = async (input) => { asked.push(input.folder); return page(3); };
    primary.imapService.getFolderStats = async () => { throw new Error("Command failed: no such mailbox"); };
    work.imapService.getFolderStats = async () => ({ folder: "Folders/News", total: 3, unseen: 1, uidNext: 4, uidValidity: "1" });

    const emails = JSON.parse((await client.callTool({ name: "get_emails", arguments: { folder: "Folders/News" } })).content[0].text);
    assert.equal(emails.total, 3);
    assert.equal(emails.failedAccounts.length, 1, "the account without the folder is reported, not fatal");
    assert.match(emails.failedAccounts[0].error, /no such mailbox/);

    const stats = JSON.parse((await client.callTool({ name: "folder_stats", arguments: { folder: "Folders/News" } })).content[0].text);
    assert.deepEqual([stats.total, stats.unseen, stats.failedAccounts.length], [3, 1, 1]);

    asked.length = 0;
    const prefixed = JSON.parse((await client.callTool({ name: "get_emails", arguments: { folder: `${work.account.slug}::Folders/News` } })).content[0].text);
    assert.equal(prefixed.failedAccounts, undefined, "the prefix names the account, so the other is not asked");
    assert.deepEqual(asked, ["Folders/News"], "and the folder reaches it without the prefix");
    const prefixedStats = JSON.parse((await client.callTool({ name: "folder_stats", arguments: { folder: `${work.account.slug}::Folders/News` } })).content[0].text);
    assert.equal(prefixedStats.byAccount.length, 1);

    primary.imapService.getEmails = async () => { throw new Error("boom one"); };
    work.imapService.getEmails = async () => { throw new Error("boom two"); };
    const allFail = await client.callTool({ name: "get_emails", arguments: { folder: "Folders/News" } });
    assert.equal(allFail.isError, true, "every account failing is still an error");
  });
});

test("bulk calls with ids and no folder look in the folder the ids come from", async () => {
  await withServer(["owner@example.com", "work@example.com"], async ({ client, bundles }) => {
    const seen = [];
    bundles[0].imapService.getMailboxUidValidity = async (folder) => { seen.push(folder); throw new Error("stop here"); };
    const id = createEmailId("Archive", 7, "100");
    for (const [tool, extra] of [["bulk_update_flags", { flagsToAdd: ["\\Seen"] }], ["bulk_move", { targetFolder: "Trash" }], ["bulk_delete", {}], ["bulk_update_labels", { labelsToAdd: ["X"] }]]) {
      seen.length = 0;
      await client.callTool({ name: tool, arguments: { emailIds: [id], ...extra } });
      assert.deepEqual(seen.slice(0, 1), ["Archive"], `${tool} must look in Archive`);
    }
    seen.length = 0;
    const mixed = await client.callTool({ name: "bulk_update_flags", arguments: { emailIds: [id, createEmailId("INBOX", 1, "200")], flagsToAdd: ["\\Seen"] } });
    assert.equal(mixed.isError, true);
    assert.match(mixed.content[0].text, /different folders/);
    await client.callTool({ name: "bulk_update_flags", arguments: { emailIds: [id], folder: "INBOX", flagsToAdd: ["\\Seen"] } });
    assert.deepEqual(seen.slice(0, 1), ["INBOX"], "an explicit folder still wins");
  }, ["delete", "move", "trash", "mark_read", "mark_unread", "star", "unstar", "archive"]);
});

test("a bulk call that selects by match works in the account it is told to, by argument or by <slug>:: prefix", async () => {
  await withServer(["owner@example.com", "work@example.com"], async ({ client, bundles }) => {
    const [primary, work] = bundles;
    const seen = [];
    for (const [label, bundle] of [["primary", primary], ["work", work]]) {
      bundle.imapService.getMailboxUidValidity = async (folder) => { seen.push(`${label}:${folder}`); throw new Error("stop here"); };
    }
    const match = { from: "someone@example.com" };
    for (const tool of ["bulk_update_flags", "bulk_move", "bulk_delete", "bulk_update_labels"]) {
      const extra = { bulk_update_flags: { flagsToAdd: ["\\Seen"] }, bulk_move: { targetFolder: "Trash" }, bulk_delete: {}, bulk_update_labels: { labelsToAdd: ["X"] } }[tool];
      seen.length = 0;
      await client.callTool({ name: tool, arguments: { match, folder: "Sent", account: work.account.address, dryRun: true, ...extra } });
      assert.deepEqual(seen.slice(0, 1), ["work:Sent"], `${tool} with account must work in that account`);
      seen.length = 0;
      await client.callTool({ name: tool, arguments: { match, folder: `${work.account.slug}::Sent`, dryRun: true, ...extra } });
      assert.deepEqual(seen.slice(0, 1), ["work:Sent"], `${tool} with a prefixed folder must work in that account`);
      seen.length = 0;
      await client.callTool({ name: tool, arguments: { match, folder: "Sent", dryRun: true, ...extra } });
      assert.deepEqual(seen.slice(0, 1), ["primary:Sent"], `${tool} without either stays in the primary account`);
    }
    // The Trash check for a move's target asks the accounts the call touches, not every account.
    primary.imapService.isTrashFolder = async () => { throw new Error("the primary account must not be asked"); };
    work.imapService.isTrashFolder = async () => false;
    const moved = await client.callTool({ name: "bulk_move", arguments: { match, folder: "Sent", account: work.account.address, targetFolder: "Archive", dryRun: true } });
    assert.doesNotMatch(moved.content[0].text, /primary account must not be asked|Cannot tell whether/, moved.content[0].text);
    const clash = await client.callTool({ name: "bulk_update_flags", arguments: { match, folder: `${work.account.slug}::Sent`, account: primary.account.address, flagsToAdd: ["\\Seen"], dryRun: true } });
    assert.equal(clash.isError, true, "an account and a prefix that name different accounts are refused");
  }, ["delete", "move", "trash", "mark_read", "mark_unread", "star", "unstar", "archive"]);
});

test("ids from two accounts may sit in different folders: each account's ids are looked up in their own folder", async () => {
  await withServer(["owner@example.com", "work@example.com"], async ({ client, bundles }) => {
    const [primary, work] = bundles;
    const seen = [];
    primary.imapService.getMailboxUidValidity = async (folder) => { seen.push(`primary:${folder}`); throw new Error("stop here"); };
    work.imapService.getMailboxUidValidity = async (folder) => { seen.push(`work:${folder}`); throw new Error("stop here"); };
    const ids = [createEmailId("Sent", 1, "100"), `${work.account.slug}::${createEmailId("Archive", 2, "200")}`];
    await client.callTool({ name: "bulk_update_flags", arguments: { emailIds: ids, flagsToAdd: ["\\Seen"], dryRun: true } });
    assert.ok(seen.includes("primary:Sent") || seen.includes("work:Archive"), JSON.stringify(seen));
    const result = await client.callTool({ name: "bulk_update_flags", arguments: { emailIds: ids, flagsToAdd: ["\\Seen"], dryRun: true } });
    assert.doesNotMatch(result.content[0].text, /different folders/, "two accounts, two folders, one each: fine");
  }, ["delete", "move", "trash", "mark_read", "mark_unread", "star", "unstar", "archive"]);
});

test("a tool that takes a folder or a match but no account argument is on the list of tools whose account comes from an id", async () => {
  const { TOOLS } = await import("../dist/tools/definitions.js");
  const withoutAccount = TOOLS
    .filter((tool) => {
      const props = Object.keys(tool.inputSchema.properties ?? {});
      return !props.includes("account") && (props.includes("folder") || props.includes("path") || props.includes("match") || props.includes("targetFolder"));
    })
    .map((tool) => tool.name)
    .sort();
  // These take ids (which carry their account) and a target folder on that same account. A new tool with a folder or
  // a match and no `account` must either take one or be added here on purpose.
  assert.deepEqual(withoutAccount, ["apply_thread_action", "batch_email_action", "move_email", "restore_email"]);
});

test("an account that failed is reported with the server's reason, not imapflow's bare 'Command failed'", async () => {
  const { describeAccountFailure } = await import("../dist/tools/merge.js");
  const bare = Object.assign(new Error("Command failed"), { responseText: "no such mailbox", serverResponseCode: "NONEXISTENT" });
  assert.match(describeAccountFailure(bare), /no such mailbox/i);
  assert.equal(describeAccountFailure(new Error("plain")), "plain");
  assert.equal(describeAccountFailure("text"), "text");
});
