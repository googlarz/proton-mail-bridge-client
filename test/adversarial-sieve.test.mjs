import test from "node:test";
import assert from "node:assert/strict";
import { exportSieve } from "../dist/services/sieve-export.js";

const R = (id, when, actions, name = "n") => ({ id, name, enabled: true, when, actions });

test("hostile strings never break out of a Sieve string or line", () => {
  const nasty = ['a"b', "a\\b", 'x"; } fileinto "evil', "a\nb", "a b", "a b", "a\u0000b", "a\u0085b", "a${b", "a\rb"];
  for (const v of nasty) {
    for (const rule of [
      R("1", { from: [v] }, { archive: true }),
      R("2", { subjectContains: [v] }, { archive: true }),
      R("3", { subjectContains: ["s"] }, { moveTo: `Folders/${v}` }),
      R("4", { subjectContains: ["s"] }, { label: v }),
      R("5", { subjectContains: ["s"] }, { archive: true }, v),
    ]) {
      const { script } = exportSieve([rule]);
      // every physical line must be a comment, blank, or one of the known statement shapes
      for (const line of script.split("\n")) {
        assert.ok(!new RegExp("[\\u2028\\u2029\\u0000\\u0085\\r]").test(line));
        // strip string literals; whatever remains must not contain stray statements
        const rest = line.replace(/"(?:[^"\\]|\\.)*"/g, '""');
        assert.ok(!/evil/.test(rest), `escaped literal in ${JSON.stringify(line)}`);
      }
    }
  }
});

test("DEFECT: a later move fires where locally an earlier rule's (unexportable) move wins", () => {
  // Locally planChanges: rule a matches first, disposition = move to INBOX/Foo; rule b's archive never applies.
  const { script, unsupported } = exportSieve([
    R("a", { from: ["x@y.com"] }, { label: "L", moveTo: "INBOX/Foo" }),
    R("b", { from: ["x@y.com"] }, { archive: true }),
  ]);
  assert.ok(unsupported.some((u) => u.ruleId === "a"));
  // b must be guarded by a's condition (or not exported); observed: unguarded archive
  const b = script.slice(script.indexOf("# Rule \"n\" (b)"));
  assert.match(b, /if not anyof/, "rule b is unguarded although rule a's move wins locally");
});

test("later label rule still applies after an earlier move (matches local semantics)", () => {
  const { script } = exportSieve([R("a", { from: ["x@y.com"] }, { archive: true }), R("b", { from: ["x@y.com"] }, { label: "L" })]);
  assert.match(script, /fileinto "L"/);
});

test("empty / whitespace values and wildcard-only senders", () => {
  const r = exportSieve([R("d", { from: ["*@"] }, { archive: true })]);
  // "*@" locally matches only an address ending in "@" (nothing real); Sieve ':domain :is ""' matches mail with no domain.
  assert.ok(r.exported.length === 0 || !/:domain :is "from" ""/.test(r.script), `exported a rule with an empty domain test: ${r.script}`);
});

test("disabled and unsupported rules are reported, not dropped silently", () => {
  const r = exportSieve([
    { ...R("off", { from: ["a@b.com"] }, { archive: true }), enabled: false },
    R("age", { olderThanDays: 3 }, { archive: true }),
    R("fwd", { from: ["a@b.com"] }, { forwardTo: ["z@z.com"] }),
    R("del", { from: ["a@b.com"] }, { delete: true }),
    R("fold", { folder: "Archive", from: ["a@b.com"] }, { archive: true }),
  ]);
  assert.equal(r.script, "");
  assert.deepEqual(r.unsupported.map((u) => u.ruleId).sort(), ["age", "del", "fold", "fwd", "off"]);
});
