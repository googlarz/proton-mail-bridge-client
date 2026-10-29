import test from "node:test";
import assert from "node:assert/strict";
import { exportSieve } from "../dist/services/sieve-export.js";

const rule = (id, name, when, actions, enabled = true) => ({ id, name, enabled, when, actions, createdAt: "2026-01-01T00:00:00.000Z" });

// Words outside quoted strings and comments: what Sieve would run.
function codeWords(script) {
  return script
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .split(/[\n\r\u2028\u2029\u0085]/)
    .map((line) => line.replace(/#.*/, ""))
    .join(" ")
    .match(/[A-Za-z_]+/g) ?? [];
}

test("a rule name cannot end the comment and start a live command (redirect payload, every line separator)", () => {
  for (const separator of ["\n", "\r", "\r\n", "\u2028", "\u2029", "\u0085"]) {
    const out = exportSieve([
      rule("r-1", `x${separator}redirect "evil@x";`, { from: ["a@x.example"] }, { markRead: true }),
      rule("r-2", "Fine", { from: ["b@x.example"] }, { markRead: true }),
    ]);
    assert.ok(!codeWords(out.script).includes("redirect"), JSON.stringify(separator));
    assert.ok(!out.script.includes("evil@x"), JSON.stringify(separator));
    assert.deepEqual(out.exported.map((entry) => entry.id), ["r-2"]);
  }
});

test("first match: a later move stays guarded by an earlier rule whose own move cannot be exported", () => {
  const out = exportSieve([
    // Locally this rule decides where the message goes; "Projects" is not a custom folder (Folders/...), so no fileinto.
    rule("r-1", "Boss", { from: ["@corp.example"] }, { moveTo: "Projects", markRead: true }),
    // Nothing else to export: the rule is dropped, but its condition must still guard what follows.
    rule("r-2", "Other", { from: ["@other.example"] }, { moveTo: "Elsewhere" }),
    rule("r-3", "Later", { subjectContains: ["report"] }, { moveTo: "Folders/Work" }),
  ]);
  assert.deepEqual(out.exported.map((entry) => entry.id), ["r-1", "r-3"]);
  assert.ok(
    out.script.includes('if not anyof (address :domain :is "from" "corp.example", address :domain :is "from" "other.example") {\n        fileinto "Work";'),
    out.script,
  );
  // The earlier rule's own marking is not guarded: it applies whatever else matched.
  assert.ok(out.script.includes('if address :domain :is "from" "corp.example" {\n    addflag'));
});

test("first match: earlier rules that trash or delete do not run by themselves and so do not guard", () => {
  const out = exportSieve([
    rule("r-1", "Bin", { from: ["@corp.example"] }, { trash: true }),
    rule("r-2", "Later", { subjectContains: ["report"] }, { moveTo: "Folders/Work" }),
  ]);
  assert.ok(out.script.includes('fileinto "Work";'));
  assert.ok(!out.script.includes("not anyof"));
});

test("a sender pattern with an empty domain is not exported (it would match mail with no domain)", () => {
  for (const pattern of ["*@", "@", " *@ "]) {
    const out = exportSieve([
      rule("r-1", "Empty domain", { from: [pattern] }, { markRead: true }),
      rule("r-2", "Mixed", { from: ["a@x.example", pattern] }, { markRead: true }),
      rule("r-3", "Fine", { from: ["*@x.example"] }, { markRead: true }),
    ]);
    assert.deepEqual(out.exported.map((entry) => entry.id), ["r-3"], pattern);
    assert.deepEqual(out.unsupported.map((gap) => [gap.ruleId, gap.part, gap.effect]), [
      ["r-1", "when.from", "rule not exported"],
      ["r-2", "when.from", "rule not exported"],
    ]);
    assert.ok(!out.script.includes('""'));
  }
});
