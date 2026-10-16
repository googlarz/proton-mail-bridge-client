import test from "node:test";
import assert from "node:assert/strict";
import { SMTPService } from "../dist/services/smtp-service.js";

// Bridge's SMTP port speaks implicit TLS or STARTTLS, depending on a setting in the Bridge app. With
// PROTONMAIL_SMTP_SECURE unset, a port that answers in plaintext is switched to STARTTLS once; a value set on purpose
// is never second-guessed, and only a TLS-mode mismatch triggers the switch.

const config = (smtp) => ({ smtp: { host: "127.0.0.1", port: 1025, secure: true, username: "o@example.com", password: "x", ...smtp } });
const TLS_MISMATCH = () => Object.assign(new Error("write EPROTO 00000000:error:0A00010B:SSL routines:tls_validate_record_header:wrong version number"), { code: "ESOCKET" });

// A transport that behaves like a STARTTLS port: implicit TLS fails the handshake, STARTTLS works.
function starttlsPort(service, calls = []) {
  service.getTransporter = function () {
    const secure = this.secure;
    return {
      verify: async () => { calls.push({ op: "verify", secure }); if (secure) throw TLS_MISMATCH(); return true; },
      sendMail: async () => { calls.push({ op: "send", secure }); if (secure) throw TLS_MISMATCH(); return { messageId: "<m@x>", accepted: ["a@b.test"], rejected: [], response: "250 OK" }; },
      close() {},
    };
  };
  return calls;
}

test("default: implicit TLS first, then STARTTLS, and the switch is remembered", async () => {
  const service = new SMTPService(config({}));
  const calls = starttlsPort(service);
  await service.verifyConnection();
  assert.deepEqual(calls, [{ op: "verify", secure: true }, { op: "verify", secure: false }]);
  calls.length = 0;
  const result = await service.sendEmail({ to: ["a@b.test"], subject: "s", body: "b", isHtml: false });
  assert.deepEqual(calls, [{ op: "send", secure: false }], "the second call goes straight to STARTTLS");
  assert.equal(result.messageId, "<m@x>");
});

test("a value set on purpose is never second-guessed", async () => {
  const service = new SMTPService(config({ secure: true, secureExplicit: true }));
  const calls = starttlsPort(service);
  await assert.rejects(service.verifyConnection(), /wrong version number/);
  assert.deepEqual(calls, [{ op: "verify", secure: true }], "one attempt, no retry");
});

test("a port configured for STARTTLS is not retried either way", async () => {
  const service = new SMTPService(config({ secure: false }));
  const calls = starttlsPort(service);
  await service.verifyConnection();
  assert.deepEqual(calls, [{ op: "verify", secure: false }]);
});

test("only a TLS-mode mismatch triggers the switch: a wrong password or an unreachable port does not", async () => {
  for (const failure of [Object.assign(new Error("Invalid login: 535 5.7.8 Authentication failed"), { code: "EAUTH" }), Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1025"), { code: "ECONNREFUSED" })]) {
    const service = new SMTPService(config({}));
    const calls = [];
    service.getTransporter = function () { return { verify: async () => { calls.push(this.secure); throw failure; }, close() {} }; };
    await assert.rejects(service.verifyConnection(), (error) => error === failure);
    assert.deepEqual(calls, [true], failure.code);
  }
});
