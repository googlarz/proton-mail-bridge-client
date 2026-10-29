import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RulesService } from "../dist/services/rules-service.js";
import { exportSieve } from "../dist/services/sieve-export.js";
import { handleRuleTool } from "../dist/tools/rules.js";

const rule = (id, name, when, actions, enabled = true) => ({ id, name, enabled, when, actions, createdAt: "2026-01-01T00:00:00.000Z" });

const AUTOMATED =
  'anyof (exists "list-unsubscribe", exists "list-id", exists "x-auto-response-suppress", header :is "precedence" ["bulk", "list", "junk"], allof (exists "auto-submitted", not header :is "auto-submitted" "no"))';

// RFC 5228 lexical structure, enough to tell code from data: hash and bracket comments, quoted strings with
// backslash escapes, and everything else as code tokens.
function tokens(script) {
  const out = [];
  let i = 0;
  while (i < script.length) {
    const c = script[i];
    if (/\s/.test(c)) i++;
    else if (c === "#") while (i < script.length && script[i] !== "\n") i++;
    else if (script.startsWith("/*", i)) i = script.indexOf("*/", i) + 2;
    else if (c === '"') {
      let value = "";
      i++;
      while (script[i] !== '"') {
        if (i >= script.length) throw new Error("unterminated string");
        if (script[i] === "\\") i++;
        value += script[i++];
      }
      i++;
      out.push({ string: value });
    } else {
      const m = /^(:?[A-Za-z_][A-Za-z0-9_]*|[0-9]+[KMG]?|[;,(){}[\]])/.exec(script.slice(i));
      if (!m) throw new Error(`unexpected ${JSON.stringify(script.slice(i, i + 10))}`);
      out.push({ code: m[0] });
      i += m[0].length;
    }
  }
  return out;
}

const code = (script) => tokens(script).filter((t) => t.code).map((t) => t.code);
const strings = (script) => tokens(script).filter((t) => "string" in t).map((t) => t.string);

test("golden: a newsletter rule (sender, domain, automated, unread) marks read and archives", () => {
  const out = exportSieve([rule("r-1", "Archive news", { from: ["news@example.com", "*@lists.example"], automated: true, unread: true }, { markRead: true, archive: true })]);
  assert.equal(
    out.script,
    [
      "# Exported from the local mail rules (export_sieve).",
      'require ["fileinto", "imap4flags"];',
      "",
      '# Rule "Archive news" (r-1)',
      `if allof (anyof (address :all :is "from" "news@example.com", address :domain :is "from" "lists.example"), ${AUTOMATED}) {`,
      '    addflag "\\\\Seen";',
      '    fileinto "archive";',
      "}",
      "",
    ].join("\n"),
  );
  assert.deepEqual(out.exported, [{ id: "r-1", name: "Archive news" }]);
  assert.deepEqual(out.unsupported.map((gap) => [gap.ruleId, gap.part, gap.effect]), [["r-1", "when.unread", "left out"]]);
});

test("golden: labels and folders, with a later move only when no earlier rule moved the message", () => {
  const out = exportSieve([
    rule("r-1", "Boss", { from: ["@corp.example"] }, { moveTo: "Folders/Work" }),
    rule("r-2", "Invoices", { subjectContains: ["invoice", "Rechnung"], hasAttachment: true }, { label: "Finance/2026", moveTo: "Folders/Work/Bills" }),
    rule("r-3", "People", { automated: false }, { label: "Labels/Human" }),
  ]);
  assert.equal(
    out.script,
    [
      "# Exported from the local mail rules (export_sieve).",
      'require "fileinto";',
      "",
      '# Rule "Boss" (r-1)',
      'if address :domain :is "from" "corp.example" {',
      '    fileinto "Work";',
      "}",
      "",
      '# Rule "Invoices" (r-2)',
      'if allof (header :contains "subject" ["invoice", "Rechnung"], exists "X-Attached") {',
      '    fileinto "Finance\\\\/2026";',
      '    if not anyof (address :domain :is "from" "corp.example") {',
      '        fileinto "Work/Bills";',
      "    }",
      "}",
      "",
      '# Rule "People" (r-3)',
      `if not ${AUTOMATED} {`,
      '    fileinto "Human";',
      "}",
      "",
    ].join("\n"),
  );
  assert.deepEqual(out.unsupported, []);
  // The label's slash reaches Proton as "\/" (a slash inside the name), the folder path's slash as a separator.
  assert.ok(strings(out.script).includes("Finance\\/2026"));
  assert.ok(strings(out.script).includes("Work/Bills"));
});

test("golden: no attachment, mark read only", () => {
  const out = exportSieve([rule("r-9", "Plain", { from: ["a@x.example"], hasAttachment: false }, { markRead: true })]);
  assert.equal(
    out.script,
    [
      "# Exported from the local mail rules (export_sieve).",
      'require "imap4flags";',
      "",
      '# Rule "Plain" (r-9)',
      'if allof (address :all :is "from" "a@x.example", not exists "X-Attached") {',
      '    addflag "\\\\Seen";',
      "}",
      "",
    ].join("\n"),
  );
});

test("injection: quotes, backslashes and braces in a sender, a subject, a label and a name stay data", () => {
  const evil = '"; discard; } if true { fileinto "x';
  const out = exportSieve([
    rule("r-1", `Name ${evil} #`, { from: [`a\\${evil}@x.example`], subjectContains: [`\\"${evil}\\`] }, { label: evil, markRead: true }),
  ]);
  const benign = exportSieve([rule("r-1", "Name", { from: ["a@x.example"], subjectContains: ["s"] }, { label: "l", markRead: true })]);
  assert.deepEqual(code(out.script), code(benign.script), "the same code, only the strings differ");
  assert.deepEqual(strings(out.script), ["fileinto", "imap4flags", "from", `a\\${evil}@x.example`, "subject", `\\"${evil}\\`, "\\Seen", evil]);
  assert.ok(!code(out.script).includes("discard"));
});

test("injection: control characters and ${ are refused, never escaped into the script", () => {
  const out = exportSieve([
    rule("r-1", "Newline in subject", { subjectContains: ["a\nfileinto \"x\";"] }, { markRead: true }),
    rule("r-2", "Variable", { from: ["${1}@x.example"] }, { markRead: true }),
    rule("r-3", "Name\r\nfileinto \"x\";", { from: ["a@x.example"] }, { markRead: true }),
    rule("r-4", "Label with a tab", { from: ["a@x.example"] }, { label: "a\tb", markRead: true }),
    rule("r-5", "Separator", { subjectContains: ["a\u2028b"] }, { markRead: true }),
  ]);
  assert.deepEqual(out.exported.map((entry) => entry.id), ["r-4"]);
  assert.deepEqual(
    out.unsupported.map((gap) => [gap.ruleId, gap.part, gap.effect]),
    [
      ["r-1", "when.subjectContains", "rule not exported"],
      ["r-2", "when.from", "rule not exported"],
      ["r-3", "name", "rule not exported"],
      ["r-4", "actions.label", "left out"],
      ["r-5", "when.subjectContains", "rule not exported"],
    ],
  );
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u2028]/.test(out.script) && !out.script.includes("${"));
});

test("what Proton's Sieve cannot do is reported, not dropped silently", () => {
  const out = exportSieve([
    rule("r-1", "Old", { from: ["a@x.example"], olderThanDays: 30 }, { archive: true }),
    rule("r-2", "In Spam", { folder: "Spam", from: ["a@x.example"] }, { markRead: true }),
    rule("r-3", "Trash it", { from: ["a@x.example"] }, { trash: true }),
    rule("r-4", "Delete it", { from: ["a@x.example"] }, { delete: true }),
    rule("r-5", "Forward and mark", { from: ["boss@x.example"] }, { forwardTo: ["me@y.example"], forwardNote: "FYI", markRead: true }),
    rule("r-6", "To Trash folder", { from: ["a@x.example"] }, { moveTo: "Trash", label: "Gone" }),
    rule("r-7", "To INBOX", { from: ["a@x.example"] }, { moveTo: "INBOX" }),
    rule("r-8", "Off", { from: ["a@x.example"] }, { markRead: true }, false),
    rule("r-9", "Only unread", { unread: true }, { markRead: true }),
    rule("r-10", "Inbox named", { folder: "inbox", from: ["a@x.example"] }, { markRead: true }),
  ]);
  assert.deepEqual(out.exported.map((entry) => entry.id), ["r-5", "r-6", "r-10"]);
  assert.deepEqual(
    out.unsupported.map((gap) => [gap.ruleId, gap.part, gap.effect]),
    [
      ["r-1", "when.olderThanDays", "rule not exported"],
      ["r-2", "when.folder", "rule not exported"],
      ["r-3", "actions.trash", "rule not exported"],
      ["r-4", "actions.delete", "rule not exported"],
      ["r-5", "actions.forwardTo", "left out"],
      ["r-6", "actions.moveTo", "left out"],
      ["r-7", "actions.moveTo", "rule not exported"],
      ["r-8", "enabled", "rule not exported"],
      ["r-9", "when", "rule not exported"],
    ],
  );
  for (const gap of out.unsupported) assert.ok(gap.reason.length > 20, `${gap.ruleId} says why`);
  assert.ok(!/trash|discard|redirect/i.test(code(out.script).join(" ")), "nothing that removes or sends mail");
  assert.ok(!strings(out.script).some((value) => /trash|me@y\.example|FYI/i.test(value)));
});

test("an empty rule set gives an empty script", () => {
  assert.deepEqual(exportSieve([]), { script: "", exported: [], unsupported: [] });
});

test("export_sieve tool: all rules, one rule (even switched off), unknown id, none", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sieve-"));
  try {
    const rulesService = new RulesService({ dataDir: dir });
    const ctx = { config: { runtime: {} }, resolveAccountArg: () => undefined, primaryBundle: { account: { address: "owner@example.com" }, rulesService } };
    const call = async (args) => JSON.parse((await handleRuleTool("export_sieve", args, ctx)).content[0].text);

    const empty = await call({});
    assert.equal(empty.script, "");
    assert.equal(empty.note, "There are no rules to export.");

    const on = await rulesService.set({ name: "News", when: { from: ["news@x.example"] }, actions: { markRead: true } });
    const off = await rulesService.set({ name: "Later", enabled: false, when: { subjectContains: ["later"] }, actions: { label: "Later" } });
    const all = await call({});
    assert.equal(all.account, "owner@example.com");
    assert.deepEqual(all.exported, [{ id: on.id, name: "News" }]);
    assert.deepEqual(all.unsupported.map((gap) => [gap.ruleId, gap.part]), [[off.id, "enabled"]]);
    assert.match(all.note, /Not tried on a Proton account/);

    const one = await call({ ruleId: off.id });
    assert.deepEqual(one.exported, [{ id: off.id, name: "Later" }]);
    assert.match(one.script, /fileinto "Later";/);

    await assert.rejects(call({ ruleId: "r-missing" }), /No rule with id r-missing/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
