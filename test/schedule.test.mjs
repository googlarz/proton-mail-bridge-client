import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSchedule, defaultSchedulerSystem, findStableAlias, parseTimeOfDay, SCHEDULER_SYSTEMS } from "../dist/utils/schedule-templates.js";

// `schedule` prints the definition that runs `digest` every day. It builds text only; the password is never in it.

const base = { hour: 7, minute: 5, node: "/usr/local/bin/node", script: "/opt/pmbc/dist/cli.js", output: "/home/me/brief.txt", username: "me@proton.me", passwordFile: "/home/me/.bridge-pw" };

test("a time of day is validated", () => {
  assert.deepEqual(parseTimeOfDay("08:00"), { hour: 8, minute: 0 });
  assert.deepEqual(parseTimeOfDay(" 7:05 "), { hour: 7, minute: 5 });
  for (const bad of ["24:00", "12:60", "8", "08:0", "noon", "", "08:00:00"]) assert.throws(() => parseTimeOfDay(bad), /--at must be a time of day/, JSON.stringify(bad));
});

test("each system gets the time, the command, the output file and a way to switch it off", () => {
  for (const system of SCHEDULER_SYSTEMS) {
    const result = buildSchedule({ ...base, system });
    const everything = JSON.stringify(result);
    assert.match(everything, /digest/, system);
    assert.ok(everything.includes("/home/me/brief.txt"), `${system}: output file`);
    assert.ok(everything.includes("/opt/pmbc/dist/cli.js"), `${system}: absolute script path`);
    assert.ok(result.enable.length > 0 && result.disable.length > 0, `${system}: on and off`);
  }
  const launchd = buildSchedule({ ...base, system: "launchd" });
  assert.match(launchd.file.content, /<key>Hour<\/key><integer>7<\/integer>/);
  assert.match(launchd.file.content, /<key>Minute<\/key><integer>5<\/integer>/);
  assert.match(buildSchedule({ ...base, system: "systemd" }).file.content, /OnCalendar=\*-\*-\* 07:05:00/);
  assert.match(buildSchedule({ ...base, system: "cron" }).body, /^5 7 \* \* \*/m);
  assert.match(buildSchedule({ ...base, system: "schtasks" }).enable[0], /\/ST 07:05/);
});

test("the password is only ever a file path, and the username and paths are escaped where they land", () => {
  const hostile = { ...base, output: "/tmp/a&b <c>.txt", username: "o'neil@proton.me", passwordFile: "/home/me/it's here" };
  for (const system of SCHEDULER_SYSTEMS) assert.doesNotMatch(JSON.stringify(buildSchedule({ ...hostile, system })), /PROTONMAIL_PASSWORD=/, system);
  const plist = buildSchedule({ ...hostile, system: "launchd" }).file.content;
  assert.ok(plist.includes("/tmp/a&amp;b &lt;c&gt;.txt"), "xml escaped");
  const cron = buildSchedule({ ...hostile, system: "cron" }).body;
  assert.ok(cron.includes(`'o'\\''neil@proton.me'`), "single quote in a cron word is closed and reopened");
});

test("the default system follows the platform", () => {
  assert.equal(defaultSchedulerSystem("darwin"), "launchd");
  assert.equal(defaultSchedulerSystem("win32"), "schtasks");
  assert.equal(defaultSchedulerSystem("linux"), "systemd");
});

test("the CLI command prints, exits 0, writes nothing of its own and refuses a bad time or system", async () => {
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/cli.js", "schedule", ...args], { env: { ...process.env, PROTONMAIL_USERNAME: "", PROTONMAIL_PASSWORD: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("close", (code) => resolve({ code, out, err }));
  });
  const ok = await run(["--system", "cron", "--at", "06:45"]);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /^45 6 \* \* \*/m);
  assert.match(ok.out, /Switch on:/);
  const badTime = await run(["--at", "25:00"]);
  assert.notEqual(badTime.code, 0);
  assert.match(badTime.err, /--at must be a time of day/);
  const badSystem = await run(["--system", "yolo"]);
  assert.equal(badSystem.code, 2);
  assert.match(badSystem.err, /--system must be one of/);
});

// A scheduler job should hold the link that survives an upgrade (Homebrew: /opt/homebrew/bin/node), not the real path
// that carries the version (.../Cellar/node/26.11.1/bin/node).

const CELLAR = "/opt/homebrew/Cellar/node/26.11.1/bin/node";
const fakeFs = (links) => ({
  realpath: (path) => { if (!(path in links)) throw new Error("ENOENT"); return links[path]; },
  isExecutable: (path) => path in links,
});

test("the link on PATH that leads to the same file is used, the first one wins", () => {
  const fs = fakeFs({
    [CELLAR]: CELLAR,
    "/opt/homebrew/bin/node": CELLAR,
    "/usr/local/bin/node": CELLAR,
    "/usr/bin/node": "/usr/bin/node-other",
  });
  assert.equal(findStableAlias({ target: CELLAR, names: ["node"], dirs: ["/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"], ...fs }), "/opt/homebrew/bin/node");
  assert.equal(findStableAlias({ target: CELLAR, names: ["node"], dirs: ["/opt/homebrew/bin/"], ...fs }), "/opt/homebrew/bin/node", "a trailing slash is tolerated");
});

test("a link to another file, a relative or empty PATH entry, and a missing link are all ignored", () => {
  const fs = fakeFs({ [CELLAR]: CELLAR, "/usr/bin/node": "/usr/bin/node-other", "bin/node": CELLAR, "/node": CELLAR });
  assert.equal(findStableAlias({ target: CELLAR, names: ["node"], dirs: ["/usr/bin", "", "bin", ".", "/nowhere"], ...fs }), undefined);
  assert.equal(findStableAlias({ target: "/does/not/exist", names: ["node"], dirs: ["/usr/bin"], ...fs }), undefined);
});

// Symlinks named like POSIX binaries; on Windows the alias is node.exe and the bin entry is a .cmd shim (the script
// alias is skipped there on purpose), so this check is POSIX-only. findStableAlias itself is covered above.
const POSIX_ONLY = { skip: process.platform === "win32" ? "POSIX-only" : false };

test("schedule puts the PATH links into the definition, and falls back to the real paths without them", POSIX_ONLY, async () => {
  const dir = await mkdtemp(join(tmpdir(), "schedule-alias-"));
  try {
    await symlink(process.execPath, join(dir, "node"));
    await symlink(resolve("dist/cli.js"), join(dir, "proton-mail-bridge-client"));
    const run = (path) => new Promise((resolveRun) => {
      const child = spawn(process.execPath, ["dist/cli.js", "schedule", "--system", "cron"], { env: { ...process.env, PATH: path, PROTONMAIL_USERNAME: "" }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("close", (code) => resolveRun({ code, out }));
    });
    const linked = await run(dir);
    assert.equal(linked.code, 0);
    assert.ok(linked.out.includes(`'${join(dir, "node")}' '${join(dir, "proton-mail-bridge-client")}' digest`), linked.out.split("\n").find((line) => line.includes("digest")));
    const bare = await run("");
    assert.equal(bare.code, 0);
    assert.ok(bare.out.includes(`'${process.execPath}' '${resolve("dist/cli.js")}' digest`), "without links the real paths are used");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the brief can be scheduled too: its own command, name and no digest", () => {
  for (const system of SCHEDULER_SYSTEMS) {
    const everything = JSON.stringify(buildSchedule({ ...base, system, job: "brief" }));
    assert.match(everything, /brief/, system);
    assert.match(everything, /--mark-seen/, `${system}: moves the since mark`);
    assert.match(everything, /--notify/, `${system}: shows a notification`);
    assert.ok(!/\bdigest\b/.test(everything), `${system}: nothing of the digest job`);
  }
  assert.match(buildSchedule({ ...base, system: "launchd", job: "brief" }).file.path, /com\.proton-mail-bridge-client\.brief\.plist$/);
});
