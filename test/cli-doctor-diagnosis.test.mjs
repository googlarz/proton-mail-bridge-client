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

import { watchHealthNotice } from "../dist/cli.js";

test("notify announces a problem once per cause and its recovery once", () => {
  const auth = new Error("Invalid credentials: login failed");
  const first = watchHealthNotice(undefined, auth);
  assert.equal(first.cause, "authentication_failed");
  assert.match(first.notice.body, /Bridge password/);
  assert.equal(watchHealthNotice(first.cause, auth).notice, undefined, "the same cause is not repeated");
  const unreachable = watchHealthNotice(first.cause, Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
  assert.equal(unreachable.cause, "bridge_unreachable");
  assert.ok(unreachable.notice, "a different cause is announced");
  const recovered = watchHealthNotice(unreachable.cause, null);
  assert.equal(recovered.cause, undefined);
  assert.match(recovered.notice.body, /works again/);
  assert.equal(watchHealthNotice(undefined, null).notice, undefined, "nothing to announce when nothing was wrong");
  assert.match(watchHealthNotice(undefined, new Error("odd failure")).notice.body, /odd failure/);
});

import { reportRuntime } from "../dist/cli.js";

test("report prints how many folders are synced, not their names, and writes the home directory as ~", () => {
  const runtime = { readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX,Sent,Folders/Clients/ACME", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40, opDelayMs: 0, sendDelaySeconds: 0, allowFileDownloadDir: "/Users/someone/Downloads/mail" };
  const out = reportRuntime(runtime, "/Users/someone");
  assert.equal(out.autoSyncFolder, "3 folders");
  assert.equal(out.allowFileDownloadDir, "~/Downloads/mail");
  assert.doesNotMatch(JSON.stringify(out), /ACME|someone/);
  assert.equal(reportRuntime({ ...runtime, autoSyncFolder: "INBOX" }, "/Users/someone").autoSyncFolder, "1 folder");
});

test("a certificate Node does not trust is explained with the options that fix it", () => {
  for (const text of [
    "self-signed certificate; if the root CA is installed locally, try running Node.js with --use-system-ca",
    "unable to verify the first certificate",
    "Hostname/IP does not match certificate's altnames",
  ]) {
    const diagnosis = diagnoseConnectionFailure(new Error(text));
    assert.equal(diagnosis?.cause, "certificate_untrusted", text);
    assert.match(diagnosis.suggestion, /PROTONMAIL_TLS_CA_FILE/);
    assert.match(diagnosis.suggestion, /PROTONMAIL_TLS_INSECURE_HOSTS/);
  }
});
