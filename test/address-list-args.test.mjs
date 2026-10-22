import test from "node:test";
import assert from "node:assert/strict";
import { optionalAddressList, requireAddressList } from "../dist/tools/args.js";
import { parseEmails } from "../dist/utils/helpers.js";

test("an address argument may be a string or an array of addresses", () => {
  assert.deepEqual(parseEmails(optionalAddressList({ to: "a@x.example, b@y.example" }, "to")), ["a@x.example", "b@y.example"]);
  assert.deepEqual(parseEmails(optionalAddressList({ to: ["a@x.example", " b@y.example ", 5, ""] }, "to")), ["a@x.example", "b@y.example"]);
  assert.equal(optionalAddressList({ cc: [] }, "cc"), undefined);
  assert.equal(optionalAddressList({}, "cc"), undefined);
  assert.equal(requireAddressList({ to: ["a@x.example"] }, "to"), "a@x.example");
  assert.throws(() => requireAddressList({ to: [] }, "to"), /address, or a list of addresses/);
});
