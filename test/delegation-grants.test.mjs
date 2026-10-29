import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GrantService, grantStatus } from "../dist/services/grant-service.js";
import { GRANTABLE_TOOLS, normalizeRecipient, normalizeRecipientPattern, parseDelegationEnv, recipientsCovered } from "../dist/utils/delegation.js";
import { parseGrantExpiry } from "../dist/cli.js";
import { buildConfigFromEnv } from "../dist/config-env.js";
import { TOOLS } from "../dist/tools/definitions.js";

const ADDRESS = "owner@example.com";
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const CHILD = fileURLToPath(new URL("./helpers/grant-child.mjs", import.meta.url));
const HOUR = 3_600_000;
const posix = process.platform !== "win32";

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "grants-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const serviceFor = (dir) => new GrantService({ dataDir: dir, smtp: { username: ADDRESS } }, ADDRESS);
const grantInput = (extra = {}) => ({ tools: ["send_email"], recipients: ["bob@example.com"], maxUses: 2, expiresAt: new Date(Date.now() + HOUR), ...extra });

test("recipients are compared as exact ASCII-lowercased addresses; display names are ignored", () => {
  assert.equal(normalizeRecipient("Bob@Example.COM"), "bob@example.com");
  assert.equal(normalizeRecipient("Bob Smith <Bob@Example.com>"), "bob@example.com");
  assert.equal(normalizeRecipient('"evil@attacker.example" <bob@example.com>'), "bob@example.com", "an address inside the display name does not count");
  assert.equal(normalizeRecipient("bob+tag@example.com"), "bob+tag@example.com", "plus tags are different addresses");
  assert.equal(normalizeRecipient("  bob@example.com\n"), "bob@example.com", "surrounding whitespace is trimmed, as the send paths do");

  // Cannot be read with certainty: matches nothing.
  for (const bad of ["", "bob", "bob@", "@example.com", "bob@example", "bob @example.com", "bob@example.com\u0000", "bob@exa\u200bmple.com", "bob@exam\nple.com", "bob@example.com\n.evil", "<>", "<a@b.co><c@d.co>", 42, null, undefined, {}]) {
    assert.equal(normalizeRecipient(bad), undefined, JSON.stringify(bad));
  }
  // Look-alikes: a Cyrillic "а", a fullwidth "ｂ", an IDN domain, and the Kelvin sign, which String.toLowerCase folds into an ASCII "k".
  for (const lookalike of ["bоb@example.com", "ｂob@example.com", "bob@exаmple.com", "bob@bücher.example", "bob@examplK.com".replace("K", "\u212a"), "bo\u212a@example.com"]) {
    assert.equal(normalizeRecipient(lookalike), undefined, lookalike);
  }
  assert.equal(normalizeRecipientPattern("@Example.COM"), "@example.com");
  assert.equal(normalizeRecipientPattern("@example.com\u212a"), undefined);
  assert.equal(normalizeRecipientPattern("*@example.com"), undefined, "there are no wildcards");
  for (const bad of ["@com", "@", "@*.example.com", "Bob <bob@example.com>", "bob", "@exa mple.com", ""]) assert.equal(normalizeRecipientPattern(bad), undefined, bad);
});

test("a call is covered only when EVERY recipient matches an exact address or exactly the domain", () => {
  const patterns = ["bob@example.com", "@acme.org"];
  assert.equal(recipientsCovered(patterns, ["Bob@Example.com"]), true);
  assert.equal(recipientsCovered(patterns, ["bob@example.com", "anyone@acme.org"]), true);
  assert.equal(recipientsCovered(patterns, ["bob@example.com", "eve@example.com"]), false, "one extra recipient breaks the match");
  assert.equal(recipientsCovered(patterns, ["anyone@sub.acme.org"]), false, "a subdomain is not the domain");
  assert.equal(recipientsCovered(patterns, ["anyone@notacme.org"]), false);
  assert.equal(recipientsCovered(patterns, ["bob+tag@example.com"]), false);
  assert.equal(recipientsCovered(patterns, []), false, "no recipients match nothing");
  assert.equal(recipientsCovered(patterns, ["bob@example.com", "not an address"]), false, "an unreadable recipient matches nothing");
  assert.equal(recipientsCovered(patterns, ["bob@example.com", "bo\u212a@example.com"]), false);
});

test("the grantable tools are exactly the six that send to a nameable recipient", () => {
  assert.deepEqual([...GRANTABLE_TOOLS], ["send_email", "reply_to_email", "reply_all_email", "forward_email", "send_draft", "schedule_draft"]);
  assert.equal(parseDelegationEnv("PROTONMAIL_DELEGATION_UNSET_FOR_TEST"), "off");
});

test("a grant is made with its limits checked, and kept in an owner-only file", async () => {
  await withDir(async (dir) => {
    const grants = serviceFor(dir);
    for (const tool of ["delete_email", "empty_folder", "set_rule", "set_autoresponder", "approve_plan", "unsubscribe_sender", "send_test_email", "respond_to_invite", "bulk_delete"]) {
      await assert.rejects(grants.createGrant(grantInput({ tools: [tool] })), /can cover only send_email/, tool);
      await assert.rejects(grants.createGrant(grantInput({ tools: ["send_email", tool] })), /can cover only/, tool);
    }
    await assert.rejects(grants.createGrant(grantInput({ tools: [] })), /can cover only/);
    await assert.rejects(grants.createGrant(grantInput({ recipients: [] })), /recipient must be/);
    await assert.rejects(grants.createGrant(grantInput({ recipients: ["bob@example.com", "*@example.com"] })), /not valid: \*@example\.com/);
    await assert.rejects(grants.createGrant(grantInput({ recipients: ["bо@example.com"] })), /recipient must be/);
    await assert.rejects(grants.createGrant(grantInput({ maxUses: 0 })), /1 to 50/);
    await assert.rejects(grants.createGrant(grantInput({ maxUses: 51 })), /1 to 50/);
    await assert.rejects(grants.createGrant(grantInput({ maxUses: 1.5 })), /1 to 50/);
    await assert.rejects(grants.createGrant(grantInput({ expiresAt: new Date(Date.now() - 1000) })), /in the future/);
    await assert.rejects(grants.createGrant(grantInput({ expiresAt: new Date(Date.now() + 31 * 24 * HOUR) })), /at most 30 days/);
    await assert.rejects(grants.createGrant(grantInput({ expiresAt: new Date("nonsense") })), /in the future/);
    assert.deepEqual(await grants.list(), [], "nothing was stored by the refused attempts");

    const grant = await grants.createGrant(grantInput({ tools: ["send_email", "forward_email"], recipients: ["Bob@Example.com", "@acme.org", "bob@example.com"], maxUses: 50, expiresAt: new Date(Date.now() + 30 * 24 * HOUR - 1000), note: "Quarterly  report" }));
    assert.match(grant.id, /^g-[0-9a-f]{8}$/);
    assert.deepEqual(grant.recipients, ["bob@example.com", "@acme.org"], "normalised and de-duplicated");
    assert.equal(grant.account, ADDRESS);
    assert.equal(grant.usedCount, 0);
    assert.equal(grant.revoked, false);
    assert.equal(grant.note, "Quarterly report");
    assert.equal(grantStatus(grant), "active");
    if (posix) assert.equal((await stat(join(dir, "grants.json"))).mode & 0o777, 0o600);
  });
});

test("each send spends exactly one use, and a grant is refused after maxUses", async () => {
  await withDir(async (dir) => {
    const grants = serviceFor(dir);
    const grant = await grants.createGrant(grantInput({ maxUses: 2 }));
    const call = { tool: "send_email", recipients: ["bob@example.com"] };
    assert.equal((await grants.find(call))?.id, grant.id);
    assert.equal((await grants.find(call))?.usedCount, 0, "finding spends nothing");
    assert.equal((await grants.claim(call))?.remaining, 1);
    assert.equal((await grants.claim(call))?.remaining, 0);
    assert.equal(await grants.claim(call), undefined, "the third send is refused");
    assert.equal(await grants.find(call), undefined);
    const [stored] = await grants.list();
    assert.equal(stored.usedCount, 2);
    assert.equal(grantStatus(stored), "used up");
    if (posix) assert.equal((await stat(join(dir, "grants.json"))).mode & 0o777, 0o600, "still owner-only after the writes");
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock")), []);
  });
});

test("an expired, revoked or not-yet-covering grant is never claimed", async () => {
  await withDir(async (dir) => {
    const grants = serviceFor(dir);
    const call = { tool: "send_email", recipients: ["bob@example.com"] };

    const soon = await grants.createGrant(grantInput({ expiresAt: new Date(Date.now() + HOUR) }));
    assert.ok(await grants.find(call, Date.now()));
    assert.equal(await grants.find(call, Date.now() + 2 * HOUR), undefined, "expired");
    assert.equal(await grants.claim(call, Date.now() + 2 * HOUR), undefined, "expired grants cannot be claimed");
    assert.equal(grantStatus(soon, Date.now() + 2 * HOUR), "expired");

    assert.deepEqual(await grants.revokeGrant(soon.id), { id: soon.id, found: true, alreadyRevoked: false });
    assert.deepEqual(await grants.revokeGrant(soon.id), { id: soon.id, found: true, alreadyRevoked: true });
    assert.deepEqual(await grants.revokeGrant("g-00000000"), { id: "g-00000000", found: false, alreadyRevoked: false });
    assert.equal(await grants.claim(call), undefined, "revoked");
    assert.equal(grantStatus((await grants.list())[0]), "revoked");

    // Wrong tool, a recipient that is not on it, one extra recipient, a draft-style call with no recipients.
    await grants.createGrant(grantInput({ maxUses: 5 }));
    assert.equal(await grants.claim({ tool: "forward_email", recipients: ["bob@example.com"] }), undefined, "tool not listed");
    assert.equal(await grants.claim({ tool: "send_email", recipients: ["eve@example.com"] }), undefined, "recipient not on the grant");
    assert.equal(await grants.claim({ tool: "send_email", recipients: ["bob@example.com", "eve@example.com"] }), undefined, "one extra recipient");
    assert.equal(await grants.claim({ tool: "send_email", recipients: [] }), undefined);
    assert.equal(await grants.claim({ tool: "delete_email", recipients: ["bob@example.com"] }), undefined);
    assert.equal((await grants.list()).find((grant) => grant.usedCount > 0), undefined, "none of that spent a use");
  });
});

test("of several grants the one that lapses first is spent first", async () => {
  await withDir(async (dir) => {
    const grants = serviceFor(dir);
    const later = await grants.createGrant(grantInput({ expiresAt: new Date(Date.now() + 5 * HOUR) }));
    const sooner = await grants.createGrant(grantInput({ expiresAt: new Date(Date.now() + HOUR) }));
    assert.equal((await grants.claim({ tool: "send_email", recipients: ["bob@example.com"] }))?.grant.id, sooner.id);
    assert.equal((await grants.list()).find((grant) => grant.id === later.id)?.usedCount, 0);
  });
});

test("a store that was tampered with or damaged honours nothing it should not", async () => {
  await withDir(async (dir) => {
    const grants = serviceFor(dir);
    const good = await grants.createGrant(grantInput());
    const file = join(dir, "grants.json");
    const stored = JSON.parse(await readFile(file, "utf8"));
    const template = stored.grants[0];
    stored.grants.push(
      { ...template, id: "g-aaaaaaa1", tools: ["delete_email", "approve_plan"] },
      { ...template, id: "g-aaaaaaa2", recipients: ["*", "*@example.com", "@com"] },
      { ...template, id: "g-aaaaaaa3", maxUses: 9999 },
      { ...template, id: "g-aaaaaaa4", account: "someone-else@example.com" },
      { ...template, id: "g-aaaaaaa5", usedCount: "none" },
      { ...template, id: "g-aaaaaaa6", revoked: "no" },
      { ...template, id: "g-aaaaaaa7", expiresAt: "soon" },
      { ...template, id: "not-an-id" },
      { ...template, id: "g-aaaaaaa8", tools: ["send_email", "delete_email"], recipients: ["eve@example.com", "*"], note: "x\u202eevil" },
      "garbage",
      null,
    );
    await writeFile(file, JSON.stringify(stored));
    const read = await serviceFor(dir).list();
    assert.deepEqual(read.map((grant) => grant.id).sort(), [good.id, "g-aaaaaaa5", "g-aaaaaaa6", "g-aaaaaaa8"].sort());
    const narrowed = read.find((grant) => grant.id === "g-aaaaaaa8");
    assert.deepEqual([narrowed.tools, narrowed.recipients], [["send_email"], ["eve@example.com"]], "doubtful parts are dropped, never widened");
    assert.equal(narrowed.note, "x evil", "a bidi override in a note is stripped");
    assert.equal(grantStatus(read.find((grant) => grant.id === "g-aaaaaaa5")), "used up", "an unreadable count counts as used up");
    assert.equal(grantStatus(read.find((grant) => grant.id === "g-aaaaaaa6")), "revoked", "an unreadable revoked flag counts as revoked");

    // A store that is not JSON covers nothing, and is kept for the person to look at.
    await writeFile(file, "{ not json");
    assert.deepEqual(await serviceFor(dir).list(), []);
    assert.equal(await serviceFor(dir).claim({ tool: "send_email", recipients: ["bob@example.com"] }), undefined);
    assert.equal(await readFile(`${file}.corrupt`, "utf8"), "{ not json");
  });
});

test("two server processes racing for the last use: the use is given once", async () => {
  await withDir(async (dir) => {
    const grants = serviceFor(dir);
    await grants.createGrant(grantInput({ maxUses: 3 }));
    const run = (mode, extra = []) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [CHILD, mode, dir, "6", ...extra], { stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        child.stdout.on("data", (chunk) => { out += chunk; });
        child.on("error", reject);
        child.on("exit", () => resolve(JSON.parse(out.trim().split("\n").at(-1))));
      });
    const results = await Promise.all([run("claim"), run("claim"), run("claim")]);
    assert.equal(results.reduce((sum, result) => sum + result.claimed, 0), 3, JSON.stringify(results));
    assert.equal(results.reduce((sum, result) => sum + result.refused, 0), 15);
    assert.equal((await grants.list())[0].usedCount, 3, "never above maxUses");
  });
});

test("two whole servers racing: the mail goes out once per use, never more", async () => {
  await withDir(async (dir) => {
    const grants = serviceFor(dir);
    await grants.createGrant(grantInput({ maxUses: 3 }));
    const sendsFile = join(dir, "sends.txt");
    await writeFile(sendsFile, "");
    const run = () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [CHILD, "send", dir, "5", sendsFile], { stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        child.stdout.on("data", (chunk) => { out += chunk; });
        child.on("error", reject);
        child.on("exit", () => resolve(JSON.parse(out.trim().split("\n").at(-1))));
      });
    const results = await Promise.all([run(), run()]);
    const sends = (await readFile(sendsFile, "utf8")).split("\n").filter(Boolean);
    assert.equal(sends.length, 3, `${sends.length} mails went out for 3 uses: ${JSON.stringify(results)}`);
    assert.equal(results.reduce((sum, result) => sum + result.sent, 0), 3);
    assert.equal(results.reduce((sum, result) => sum + result.refused, 0), 7);
    assert.equal((await grants.list())[0].usedCount, 3);
  });
});

test("no tool can make, change or revoke a grant: the model has no way to grant itself anything", async () => {
  const names = TOOLS.map((tool) => tool.name);
  assert.deepEqual(names.filter((name) => /grant|delegat|permission|allow|approv/i.test(name)).sort(), ["approve_plan", "list_grants"], "only list_grants (and the older, unrelated approve_plan)");
  const list = TOOLS.find((tool) => tool.name === "list_grants");
  assert.equal(list.annotations?.readOnlyHint, true);
  assert.deepEqual(Object.keys(list.inputSchema.properties), ["account"], "it takes no argument that could carry a grant");
  // Nothing in any tool's arguments is named like a grant either.
  for (const tool of TOOLS) {
    for (const key of Object.keys(tool.inputSchema?.properties ?? {})) assert.doesNotMatch(key, /grant|delegat/i, `${tool.name}.${key}`);
  }

  // And in the code: only the CLI and the store itself know how to make or revoke one.
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".ts"));
  const users = [];
  for (const file of files) {
    if (/\b(createGrant|revokeGrant)\b/.test(await readFile(join(root, file), "utf8"))) users.push(file.split("\\").join("/"));
  }
  assert.deepEqual(users.sort(), ["cli.ts", "services/grant-service.ts"]);
});

test("PROTONMAIL_DELEGATION defaults to off, accepts on, and is shown in the runtime status", () => {
  const base = { PROTONMAIL_USERNAME: "owner@example.com", PROTONMAIL_PASSWORD: "x" };
  const saved = { ...process.env };
  try {
    for (const [value, expected] of [[undefined, "off"], ["", "off"], ["off", "off"], ["on", "on"], [" ON ", "on"], ["${user_config.delegation}", "off"]]) {
      process.env = { ...saved, ...base };
      if (value === undefined) delete process.env.PROTONMAIL_DELEGATION;
      else process.env.PROTONMAIL_DELEGATION = value;
      assert.equal(buildConfigFromEnv().runtime.delegation, expected, String(value));
    }
    process.env = { ...saved, ...base, PROTONMAIL_DELEGATION: "yes" };
    assert.throws(() => buildConfigFromEnv(), /PROTONMAIL_DELEGATION must be one of: off, on/);
  } finally {
    process.env = saved;
  }
});

// ---- the CLI ----

function runCli(args, dir, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, PROTONMAIL_USERNAME: ADDRESS, PROTONMAIL_PASSWORD: "dummy", PROTONMAIL_IMAP_PORT: "9", PROTONMAIL_SMTP_PORT: "9", PROTONMAIL_DATA_DIR: dir, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("grant-create, grant-list and grant-revoke work end to end, with usage errors exiting 2", async () => {
  await withDir(async (dir) => {
    const created = runCli(["grant-create", "--tools", "send_email,reply_to_email", "--recipients", "Bob@Example.com,@acme.org", "--expires", "2d", "--uses", "3", "--note", "for the audit", "--json"], dir);
    assert.equal(created.code, 0, created.stderr);
    const grant = JSON.parse(created.stdout);
    assert.deepEqual([grant.tools, grant.recipients, grant.maxUses, grant.note, grant.account], [["send_email", "reply_to_email"], ["bob@example.com", "@acme.org"], 3, "for the audit", ADDRESS]);
    assert.ok(Date.parse(grant.expiresAt) > Date.now() + 47 * HOUR && Date.parse(grant.expiresAt) < Date.now() + 49 * HOUR);
    if (posix) assert.equal((await stat(join(dir, "grants.json"))).mode & 0o777, 0o600);

    const listed = runCli(["grant-list"], dir);
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(listed.stdout.trim().split("\n").length, 1);
    assert.match(listed.stdout.trim(), new RegExp(`^${grant.id} \\| ${ADDRESS} \\| send_email,reply_to_email \\| bob@example.com,@acme.org \\| 3/3 uses left \\| expires \\d{4}-.*\\| "for the audit"$`));

    // The tool form reads the same store through the server.
    const asTool = runCli(["list-grants", "--json"], dir);
    assert.equal(asTool.code, 0, asTool.stderr);
    assert.deepEqual(JSON.parse(asTool.stdout).structuredContent.grants.map((entry) => entry.id), [grant.id]);

    const revoked = runCli(["grant-revoke", grant.id], dir);
    assert.equal(revoked.code, 0, revoked.stderr);
    assert.match(revoked.stdout, new RegExp(`^Revoked: ${grant.id}`));
    assert.match(runCli(["grant-list"], dir).stdout, /^No active grants\./);
    assert.match(runCli(["grant-list", "--all"], dir).stdout, /revoked/);
    assert.equal(runCli(["grant-revoke", grant.id], dir).stdout.startsWith("Already revoked"), true);
    assert.equal(runCli(["grant-revoke", "g-00000000"], dir).code, 1);

    for (const args of [
      ["grant-create", "--recipients", "a@b.co", "--expires", "1d"],
      ["grant-create", "--tools", "send_email", "--expires", "1d"],
      ["grant-create", "--tools", "send_email", "--recipients", "a@b.co"],
      ["grant-create", "--tools", "delete_email", "--recipients", "a@b.co", "--expires", "1d"],
      ["grant-create", "--tools", "send_email", "--recipients", "a@b.co", "--expires", "31d"],
      ["grant-create", "--tools", "send_email", "--recipients", "a@b.co", "--expires", "yesterday"],
      ["grant-create", "--tools", "send_email", "--recipients", "a@b.co", "--expires", "1d", "--uses", "51"],
      ["grant-create", "--tools", "send_email", "--recipients", "a@b.co", "--expires", "1d", "--uses", "0"],
      ["grant-create", "--tools", "send_email", "--recipients", "*@b.co", "--expires", "1d"],
      ["grant-create", "--tools", "send_email", "--recipients", "a@b.co", "--expires", "1d", "--bogus", "1"],
      ["grant-revoke"],
    ]) {
      assert.equal(runCli(args, dir).code, 2, args.join(" "));
    }
    assert.deepEqual((await serviceFor(dir).list()).map((entry) => entry.id), [grant.id], "none of those made a grant");
  });
});

test("a hostile note cannot break the CLI output or fake another row", async () => {
  await withDir(async (dir) => {
    const hostile = "first\n g-deadbeef | owner@example.com | send_email | * | 50/50 uses left | expires 2099-01-01T00:00:00.000Z | \"fake\"\r\n\u001b[2J\u001b[31mred\u001b[0m \u202eevil\u202c\u200b\u2028\u2029\u0007 " + "x".repeat(500);
    const created = runCli(["grant-create", "--tools", "send_email", "--recipients", "bob@example.com", "--expires", "1d", `--note=${hostile}`], dir);
    assert.equal(created.code, 0, created.stderr);
    const second = runCli(["grant-create", "--tools", "send_email", "--recipients", "carol@example.com", "--expires", "2d", "--note", "plain"], dir);
    assert.equal(second.code, 0, second.stderr);

    for (const args of [["grant-list"], ["grant-list", "--all"], ["grant-list", "--json"], ["list-grants"], ["list-grants", "--json"]]) {
      const out = runCli(args, dir);
      assert.equal(out.code, 0, `${args.join(" ")}: ${out.stderr}`);
      // eslint-disable-next-line no-control-regex
      assert.doesNotMatch(out.stdout.replace(/\n/g, ""), /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/, `control or direction characters in ${args.join(" ")}`);
      if (args[0] === "grant-list" && !args.includes("--json")) {
        const lines = out.stdout.trim().split("\n");
        assert.equal(lines.length, 2, "one line per grant");
        assert.equal(lines.filter((line) => line.startsWith("g-deadbeef")).length, 0, "no fake row");
        assert.ok(lines.every((line) => /^g-[0-9a-f]{8} \| owner@example\.com \| /.test(line)));
        assert.ok(lines.every((line) => line.length < 600));
      }
    }
    const note = (await serviceFor(dir).list()).find((grant) => grant.recipients[0] === "bob@example.com").note;
    assert.ok(note.startsWith("first g-deadbeef | owner@example.com"));
    assert.ok([...note].length <= 200);
    assert.equal(note.includes("\n"), false);
  });
});

test("grant-create names its account when several are configured, and each account keeps its own grants", async () => {
  await withDir(async (dir) => {
    const accounts = JSON.stringify([{ address: "second@example.com", password: "x" }]);
    const env = { PROTONMAIL_ACCOUNTS_JSON: accounts };
    const base = ["grant-create", "--tools", "send_email", "--recipients", "bob@example.com", "--expires", "1d"];
    const ambiguous = runCli(base, dir, env);
    assert.equal(ambiguous.code, 2, ambiguous.stdout + ambiguous.stderr);
    assert.match(ambiguous.stderr, /Several accounts are configured; name one with --account/);
    const first = runCli([...base, "--account", ADDRESS, "--json"], dir, env);
    const second = runCli([...base, "--account", "second@example.com", "--json"], dir, env);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).account, "second@example.com");
    assert.equal(runCli(["grant-list"], dir, env).stdout.trim().split("\n").length, 2, "without --account every account is listed");
    assert.equal(runCli(["grant-list", "--account", "second@example.com"], dir, env).stdout.trim().split("\n").length, 1);
    const revoked = runCli(["grant-revoke", JSON.parse(second.stdout).id], dir, env);
    assert.match(revoked.stdout, /second@example\.com/);
    assert.equal(runCli(["grant-list"], dir, env).stdout.trim().split("\n").length, 1);
  });
});

test("expiry is read as a span from now or a timestamp, and nothing else", () => {
  const now = new Date("2026-10-29T12:00:00.000Z");
  assert.equal(parseGrantExpiry("30m", now).toISOString(), "2026-10-29T12:30:00.000Z");
  assert.equal(parseGrantExpiry("12h", now).toISOString(), "2026-10-30T00:00:00.000Z");
  assert.equal(parseGrantExpiry("7d", now).toISOString(), "2026-11-05T12:00:00.000Z");
  assert.equal(parseGrantExpiry("2026-11-05T18:00:00Z", now).toISOString(), "2026-11-05T18:00:00.000Z");
  assert.equal(parseGrantExpiry("2026-11-05", now).toISOString(), "2026-11-05T00:00:00.000Z");
  for (const bad of ["", "soon", "7", "7w", "-1d", "1.5d", "d7", "tomorrow", "12345d"]) assert.throws(() => parseGrantExpiry(bad, now), /--expires must be/, bad);
});
