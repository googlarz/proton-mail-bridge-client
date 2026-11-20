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

// Core is drafts-first so it matches the default "drafts" mode: the draft review/edit step and multi-account
// visibility stay (v2.1.10), reply and forward are offered as drafts, and the style/brief helpers a drafter needs are in.
test("core tool tier includes the draft workflow and multi-account visibility", () => {
  for (const name of [
    "create_draft", "create_reply_draft", "create_forward_draft", "list_drafts", "get_draft", "update_draft",
    "get_style_profile", "get_brief", "get_attachment_text", "list_accounts",
  ]) {
    assert.ok(CORE_TOOL_NAMES.has(name), `${name} should be in core`);
  }
});

// The default mode (drafts, what the setup wizard picks) refuses sending and move/archive/trash, so core must not
// list them: a listed tool invites the model to call it and get a refusal.
test("core tool tier lists no tool the drafts mode refuses", () => {
  for (const name of ["send_email", "send_draft", "schedule_draft", "reply_to_email", "reply_all_email", "forward_email", "trash_email", "archive_email", "move_email"]) {
    assert.ok(!CORE_TOOL_NAMES.has(name), `${name} is refused in drafts mode and must not be in core`);
  }
});

test("core tool tier stays a small, deliberate subset — not creeping back toward the full 100", () => {
  assert.ok(CORE_TOOL_NAMES.size <= 30, `core tier has ${CORE_TOOL_NAMES.size} tools — if this grew past 30, check whether it's still serving its "reduce context burn" purpose`);
});
