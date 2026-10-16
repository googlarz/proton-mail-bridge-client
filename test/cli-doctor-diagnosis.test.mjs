import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseConnectionFailure } from "../dist/cli.js";

test("CLI doctor explains a TLS mismatch, a bad password and an unreachable Bridge", () => {
  const tls = Object.assign(new Error("wrong version number"), { code: "EPROTO" });
  assert.equal(diagnoseConnectionFailure(tls)?.cause, "tls_mismatch");
  assert.equal(diagnoseConnectionFailure(new Error("Invalid credentials: login failed"))?.cause, "authentication_failed");
  assert.equal(diagnoseConnectionFailure(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1143"), { code: "ECONNREFUSED" }))?.cause, "bridge_unreachable");
  assert.equal(diagnoseConnectionFailure(new Error("something else")), undefined);
});
