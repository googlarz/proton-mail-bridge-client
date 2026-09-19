import test from "node:test";
import assert from "node:assert/strict";
import { buildConfigFromEnv } from "../dist/index.js";

// The README says Bridge's default is 127.0.0.1:1143 (IMAP) and 127.0.0.1:1025 (SMTP).
// The IMAP default used to be "localhost", which can resolve to ::1 while Bridge only
// listens on the IPv4 loopback.

function withEnv(overrides, fn) {
  const keys = ["PROTONMAIL_USERNAME", "PROTONMAIL_PASSWORD", "PROTONMAIL_IMAP_HOST", "PROTONMAIL_IMAP_PORT", "PROTONMAIL_SMTP_HOST", "PROTONMAIL_ACCOUNTS_JSON", "PROTONMAIL_DATA_DIR"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, { PROTONMAIL_USERNAME: "me@proton.me", PROTONMAIL_PASSWORD: "x", PROTONMAIL_DATA_DIR: "/tmp/config-default-hosts-test", ...overrides });
    return fn();
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test("with no host configured, IMAP and SMTP both default to 127.0.0.1", () => {
  withEnv({}, () => {
    const config = buildConfigFromEnv();
    assert.equal(config.imap.host, "127.0.0.1");
    assert.equal(config.imap.port, 1143);
    assert.equal(config.smtp.host, "127.0.0.1");
  });
});

test("an explicitly configured IMAP host is still honored", () => {
  withEnv({ PROTONMAIL_IMAP_HOST: "bridge.internal.example" }, () => {
    assert.equal(buildConfigFromEnv().imap.host, "bridge.internal.example");
  });
  withEnv({ PROTONMAIL_IMAP_HOST: "localhost" }, () => {
    assert.equal(buildConfigFromEnv().imap.host, "localhost", "anyone who set localhost on purpose keeps it");
  });
});
