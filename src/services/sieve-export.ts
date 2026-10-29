import type { MailRule, RuleWhen } from "./rules-service.js";

// The local rules as a Sieve script for Proton's own filters, which run on Proton's servers whether or not this
// server is running. Only what Proton documents is used:
//   https://proton.me/support/sieve-advanced-custom-filters (read 2026-10-29): extensions date, envelope, fileinto,
//   imap4flags, reject, vacation, variables, relational, regex, comparator-i;ascii-numeric, extlists, vnd.proton.eval,
//   include (return only), vnd.proton.expire; tests address (:all/:domain, :is/:contains/:matches), header, exists,
//   not/anyof/allof; actions fileinto (a label or a folder, "/" separates folders, "\/" is a slash inside a name),
//   addflag "\\Seen", stop, discard; no redirect. fileinto "trash" is documented, "archive" is not.
//   Proton's own web client (github.com/ProtonMail/WebClients, packages/sieve, read 2026-10-29) files into "archive"
//   (fixtures/archive.ts) and tests attachments with exists "X-Attached" (src/constants.ts); both are taken from there.
// The script runs once per message, as it arrives. Conditions that cannot be expressed keep the whole rule out
// (dropping one would widen what it matches); actions that cannot be expressed are left out of an exported rule.
// Every gap is reported, nothing is dropped silently.

export interface SieveGap {
  ruleId: string;
  ruleName: string;
  part: string;
  reason: string;
  effect: "rule not exported" | "left out";
}

export interface SieveExport {
  script: string;
  exported: Array<{ id: string; name: string }>;
  unsupported: SieveGap[];
}

// Line breaks and every other control character, and the Unicode line separators: never written into a script.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function unsafeText(value: string): string | undefined {
  if (CONTROL.test(value)) return "It contains a control character (a line break, a tab or similar), which is not written into a Sieve script.";
  // Proton's Sieve expands ${...} in scripts that load "variables"; such text is kept out rather than trusted not to be.
  if (value.includes("${")) return "It contains \"${\", which Proton's Sieve can read as a variable.";
  return undefined;
}

// A Sieve quoted string: backslash and double quote are the only characters to escape (RFC 5228, 2.4.2).
function quote(value: string): string {
  return `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
}

function stringList(values: string[]): string {
  return values.length === 1 ? quote(values[0]) : `[${values.map(quote).join(", ")}]`;
}

const ATTACHED = 'exists "X-Attached"';
// The same headers as detectAutomatedFromHeaders, which decides `automated` for the local rules.
const AUTOMATED =
  'anyof (exists "list-unsubscribe", exists "list-id", exists "x-auto-response-suppress", header :is "precedence" ["bulk", "list", "junk"], allof (exists "auto-submitted", not header :is "auto-submitted" "no"))';

const TRASH_REASON = "A rule that moves to Trash only runs when asked, after a preview (apply_rules); on Proton it would run by itself on every new message.";

type Target = { value: string } | { reason: string };

function folderTarget(moveTo: string): Target {
  const unsafe = unsafeText(moveTo);
  if (unsafe) return { reason: unsafe };
  if (/^archive$/i.test(moveTo)) return { value: "archive" };
  if (/^trash$/i.test(moveTo)) return { reason: TRASH_REASON };
  // Bridge shows custom folders as "Folders/<path>"; Proton's Sieve names them by <path>.
  const path = moveTo.startsWith("Folders/") ? moveTo.slice("Folders/".length) : undefined;
  if (!path) return { reason: `${moveTo} is neither Archive nor a custom folder (Folders/...), so it is not a place Proton's Sieve is known to file into.` };
  if (path.split("/").some((segment) => !segment.trim())) return { reason: `${moveTo} has an empty folder name in it.` };
  if (path.includes("\\")) return { reason: "Proton's Sieve documents no spelling for a backslash in a folder name." };
  return { value: path };
}

function labelTarget(label: string): Target {
  const unsafe = unsafeText(label);
  if (unsafe) return { reason: unsafe };
  const name = label.startsWith("Labels/") ? label.slice("Labels/".length) : label;
  if (!name.trim()) return { reason: "The label name is empty." };
  if (name.includes("\\")) return { reason: "Proton's Sieve documents no spelling for a backslash in a label name." };
  // A slash inside a label name is written "\/", or Proton would read it as a folder path.
  return { value: name.replace(/\//g, "\\/") };
}

type Conditions = { test: string; leftOut: Array<{ part: string; reason: string }> } | { part: string; reason: string };

function conditions(when: RuleWhen): Conditions {
  if (when.folder !== undefined && when.folder.toLowerCase() !== "inbox") {
    return { part: "when.folder", reason: `Proton runs filters once, as mail arrives, so it cannot act on mail already in ${when.folder}.` };
  }
  if (when.olderThanDays !== undefined) {
    return { part: "when.olderThanDays", reason: "Proton runs filters once, as mail arrives, when nothing is days old yet; a rule on age needs the local rules (apply_rules)." };
  }
  for (const [part, values] of [["when.from", when.from ?? []], ["when.subjectContains", when.subjectContains ?? []]] as const) {
    for (const value of values) {
      const unsafe = unsafeText(value);
      if (unsafe) return { part, reason: unsafe };
    }
  }
  const tests: string[] = [];
  if (when.from?.length) {
    const exact: string[] = [];
    const domains: string[] = [];
    for (const pattern of when.from.map((entry) => entry.trim())) {
      if (pattern.startsWith("*@") || pattern.startsWith("@")) domains.push(pattern.slice(pattern.indexOf("@") + 1));
      else exact.push(pattern);
    }
    const from = [
      ...(exact.length ? [`address :all :is "from" ${stringList(exact)}`] : []),
      ...(domains.length ? [`address :domain :is "from" ${stringList(domains)}`] : []),
    ];
    tests.push(from.length === 1 ? from[0] : `anyof (${from.join(", ")})`);
  }
  if (when.subjectContains?.length) tests.push(`header :contains "subject" ${stringList(when.subjectContains)}`);
  if (when.hasAttachment !== undefined) tests.push(when.hasAttachment ? ATTACHED : `not ${ATTACHED}`);
  if (when.automated !== undefined) tests.push(when.automated ? AUTOMATED : `not ${AUTOMATED}`);
  if (tests.length === 0) {
    return { part: "when", reason: "Its only condition is unread, which every new message meets, so on Proton it would act on all incoming mail." };
  }
  return {
    test: tests.length === 1 ? tests[0] : `allof (${tests.join(", ")})`,
    leftOut: when.unread ? [{ part: "when.unread", reason: "Mail is always unread when it arrives, which is when Proton runs filters, so this condition always holds there." }] : [],
  };
}

/** Compiles the enabled rules, in order, to one Sieve script. Pure: reads nothing, stores nothing. */
export function exportSieve(rules: MailRule[]): SieveExport {
  const unsupported: SieveGap[] = [];
  const exported: SieveExport["exported"] = [];
  const blocks: string[] = [];
  const requires = new Set<string>();
  // Locally the first matching rule that moves a message decides where it goes; later moves are guarded by these.
  const earlierMoves: string[] = [];

  for (const rule of rules) {
    const gap = (part: string, reason: string, effect: SieveGap["effect"]) => unsupported.push({ ruleId: rule.id, ruleName: rule.name, part, reason, effect });
    if (!rule.enabled) {
      gap("enabled", "The rule is switched off.", "rule not exported");
      continue;
    }
    const badName = unsafeText(rule.name) ?? unsafeText(rule.id);
    if (badName) {
      gap("name", badName, "rule not exported");
      continue;
    }
    const when = conditions(rule.when);
    if ("part" in when) {
      gap(when.part, when.reason, "rule not exported");
      continue;
    }

    const actionGaps: Array<{ part: string; reason: string }> = [];
    const body: string[] = [];
    const { actions } = rule;
    if (actions.markRead) body.push(`addflag ${quote("\\Seen")};`);
    if (actions.label) {
      const label = labelTarget(actions.label);
      if ("value" in label) body.push(`fileinto ${quote(label.value)};`);
      else actionGaps.push({ part: "actions.label", reason: label.reason });
    }
    let move: string | undefined;
    if (actions.archive) move = "archive";
    else if (actions.moveTo) {
      const folder = folderTarget(actions.moveTo);
      if ("value" in folder) move = folder.value;
      else actionGaps.push({ part: "actions.moveTo", reason: folder.reason });
    }
    if (actions.trash) actionGaps.push({ part: "actions.trash", reason: TRASH_REASON });
    if (actions.delete) {
      actionGaps.push({ part: "actions.delete", reason: "Deleting for good only runs when asked, with a preview and confirmation (apply_rules); Sieve's discard would delete every new match at once." });
    }
    if (actions.forwardTo?.length) {
      actionGaps.push({
        part: "actions.forwardTo",
        reason: "Proton's Sieve documentation lists no redirect action, and a forward on Proton's side would skip the local checks on sending (allowed recipients, the daily cap, confirmation).",
      });
    }

    if (body.length === 0 && move === undefined) {
      for (const entry of actionGaps) gap(entry.part, entry.reason, "rule not exported");
      continue;
    }
    for (const entry of [...when.leftOut, ...actionGaps]) gap(entry.part, entry.reason, "left out");

    if (move !== undefined) {
      const fileinto = `fileinto ${quote(move)};`;
      if (earlierMoves.length) body.push(`if not anyof (${earlierMoves.join(", ")}) {`, `    ${fileinto}`, "}");
      else body.push(fileinto);
      earlierMoves.push(when.test);
    }
    if (body.some((line) => line.startsWith("addflag"))) requires.add("imap4flags");
    if (body.some((line) => line.includes("fileinto"))) requires.add("fileinto");
    blocks.push([`# Rule ${quote(rule.name)} (${rule.id})`, `if ${when.test} {`, ...body.map((line) => `    ${line}`), "}"].join("\n"));
    exported.push({ id: rule.id, name: rule.name });
  }

  if (blocks.length === 0) return { script: "", exported, unsupported };
  const order = ["fileinto", "imap4flags"].filter((name) => requires.has(name));
  const script = ["# Exported from the local mail rules (export_sieve).", `require ${stringList(order)};`, "", blocks.join("\n\n"), ""].join("\n");
  return { script, exported, unsupported };
}
