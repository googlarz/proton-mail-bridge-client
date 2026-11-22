import test from "node:test";
import assert from "node:assert/strict";
import { extractMessageIdList, parseMessageIds } from "../dist/utils/helpers.js";
import { replyReferences } from "../dist/tools/compose.js";

// Bridge resolves a reply's parent from an "@protonmail.internalid" reference; a lowercased one is rejected and the
// reply goes out unthreaded.
const header = "<Earlier@Example.com>\r\n <AbCdEfGh_IjKlMn-OpQrSt==@protonmail.internalid> <Earlier@Example.com>";

test("parseMessageIds keeps each id as written, without duplicates", () => {
  assert.deepEqual(parseMessageIds(header), ["<Earlier@Example.com>", "<AbCdEfGh_IjKlMn-OpQrSt==@protonmail.internalid>"]);
});

test("extractMessageIdList still gives lowercased keys for comparing", () => {
  assert.deepEqual(extractMessageIdList(header), ["<earlier@example.com>", "<abcdefgh_ijklmn-opqrst==@protonmail.internalid>"]);
});

test("a reply's References carries the parsed ids unchanged", () => {
  const detail = { messageId: "<Original@Example.com>", references: parseMessageIds(header) };
  assert.deepEqual(replyReferences(detail), [...parseMessageIds(header), "<Original@Example.com>"]);
});
