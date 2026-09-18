import test from "node:test";
import assert from "node:assert/strict";
import { CORE_TOOL_NAMES } from "../dist/index.js";

// PROTONMAIL_TOOL_TIER=core exists specifically to reduce tool-selection
// overlap for weaker/smaller models — it must not itself contain two tools
// that do the same job. search_emails (live IMAP) and search_indexed_emails
// (local index) are the exact overlap Glama flagged; only the faster,
// offline-capable one belongs in core (search_emails stays available under
// the full tier for stale-index/live-only cases).
test("core tool tier keeps only one of search_emails/search_indexed_emails", () => {
  assert.ok(CORE_TOOL_NAMES.has("search_indexed_emails"), "search_indexed_emails should be in core");
  assert.ok(!CORE_TOOL_NAMES.has("search_emails"), "search_emails should not duplicate search_indexed_emails in core");
});

// Regression test (v2.1.10): found live that core was missing the "review a
// draft before sending" step (list_drafts/get_draft/update_draft) despite
// having both endpoints around it (create_draft, send_draft), was missing
// reply_all_email/forward_email despite reply_to_email being core (no real
// reason for the asymmetry), and had no way to see configured accounts
// (list_accounts) at all under multi-account setups. All confirmed as
// routine, not niche, by this session's own daily-scenarios testing.
test("core tool tier includes the draft review/edit step and multi-account visibility", () => {
  for (const name of ["list_drafts", "get_draft", "update_draft", "reply_all_email", "forward_email", "list_accounts"]) {
    assert.ok(CORE_TOOL_NAMES.has(name), `${name} should be in core`);
  }
});

test("core tool tier stays a small, deliberate subset — not creeping back toward the full 96", () => {
  assert.ok(CORE_TOOL_NAMES.size <= 30, `core tier has ${CORE_TOOL_NAMES.size} tools — if this grew past 30, check whether it's still serving its "reduce context burn" purpose`);
});
