import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfigFromEnv } from "../dist/index.js";

// These assert POSIX file modes, symlinks or hardcoded "/" paths, which Windows does not have.
const WIN_SKIP = { skip: process.platform === "win32" ? "POSIX-only" : false };

const KEYS = [
  "PROTONMAIL_USERNAME",
  "PROTONMAIL_USERNAME_COMMAND",
  "PROTONMAIL_USERNAME_FILE",
  "PROTONMAIL_PASSWORD",
  "PROTONMAIL_PASSWORD_COMMAND",
  "PROTONMAIL_PASSWORD_FILE",
  "PROTONMAIL_READ_ONLY",
  "PROTONMAIL_ALLOW_SEND",
  "PROTONMAIL_ALLOW_REMOTE_DRAFT_SYNC",
  "PROTONMAIL_ALLOWED_ACTIONS",
  "PROTONMAIL_AUTO_SYNC",
  "PROTONMAIL_STARTUP_SYNC",
  "PROTONMAIL_AUTO_SYNC_FOLDER",
  "PROTONMAIL_AUTO_SYNC_FULL",
  "PROTONMAIL_AUTO_SYNC_LIMIT_PER_FOLDER",
  "PROTONMAIL_SYNC_INTERVAL_MINUTES",
  "PROTONMAIL_IDLE_WATCH",
  "PROTONMAIL_IDLE_MAX_SECONDS",
  "PROTONMAIL_SEND_DELAY_SECONDS",
  "PROTONMAIL_SMTP_PORT",
  "PROTONMAIL_SMTP_SECURE",
];

test("buildConfigFromEnv reads *_FILE secrets and runtime policy flags", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-env-test-"));
  const usernameFile = join(dataDir, "username.txt");
  const passwordFile = join(dataDir, "password.txt");
  await writeFile(usernameFile, "owner@example.com\n", "utf8");
  await writeFile(passwordFile, "bridge-secret\n", "utf8");

  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

  try {
    delete process.env.PROTONMAIL_USERNAME;
    delete process.env.PROTONMAIL_PASSWORD;
    process.env.PROTONMAIL_USERNAME_FILE = usernameFile;
    process.env.PROTONMAIL_PASSWORD_FILE = passwordFile;
    process.env.PROTONMAIL_READ_ONLY = "true";
    process.env.PROTONMAIL_ALLOW_SEND = "false";
    process.env.PROTONMAIL_ALLOW_REMOTE_DRAFT_SYNC = "false";
    process.env.PROTONMAIL_ALLOWED_ACTIONS = "mark_read,mark_unread";
    process.env.PROTONMAIL_AUTO_SYNC = "true";
    process.env.PROTONMAIL_STARTUP_SYNC = "false";
    process.env.PROTONMAIL_AUTO_SYNC_FOLDER = "Archive";
    process.env.PROTONMAIL_AUTO_SYNC_FULL = "true";
    process.env.PROTONMAIL_AUTO_SYNC_LIMIT_PER_FOLDER = "42";
    process.env.PROTONMAIL_SYNC_INTERVAL_MINUTES = "9";
    process.env.PROTONMAIL_IDLE_WATCH = "true";
    process.env.PROTONMAIL_IDLE_MAX_SECONDS = "45";

    const config = buildConfigFromEnv();
    assert.equal(config.smtp.username, "owner@example.com");
    assert.equal(config.smtp.password, "bridge-secret");
    assert.equal(config.runtime.readOnly, true);
    assert.equal(config.runtime.allowSend, false);
    assert.equal(config.runtime.allowRemoteDraftSync, false);
    assert.deepEqual(config.runtime.allowedActions, ["mark_read", "mark_unread"]);
    assert.equal(config.runtime.autoSyncFolder, "Archive");
    assert.equal(config.runtime.autoSyncFull, true);
    assert.equal(config.runtime.autoSyncLimitPerFolder, 42);
    assert.equal(config.runtime.startupSync, false);
    assert.equal(config.runtime.idleWatchEnabled, true);
    assert.equal(config.runtime.idleMaxSeconds, 45);
    assert.equal(config.syncInterval, 9);
  } finally {
    for (const key of KEYS) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("buildConfigFromEnv defaults autoSyncFolder to INBOX,Sent so digest/follow-up don't misreport answered threads", () => {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

  try {
    process.env.PROTONMAIL_USERNAME = "owner@example.com";
    process.env.PROTONMAIL_PASSWORD = "bridge-secret";
    delete process.env.PROTONMAIL_AUTO_SYNC_FOLDER;

    const config = buildConfigFromEnv();
    assert.equal(config.runtime.autoSyncFolder, "INBOX,Sent");
  } finally {
    for (const key of KEYS) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
});

test("buildConfigFromEnv wires PROTONMAIL_SEND_DELAY_SECONDS through to runtime.sendDelaySeconds, defaulting to 0 (disabled)", () => {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

  try {
    process.env.PROTONMAIL_USERNAME = "owner@example.com";
    process.env.PROTONMAIL_PASSWORD = "bridge-secret";

    delete process.env.PROTONMAIL_SEND_DELAY_SECONDS;
    assert.equal(buildConfigFromEnv().runtime.sendDelaySeconds, 0);

    process.env.PROTONMAIL_SEND_DELAY_SECONDS = "20";
    assert.equal(buildConfigFromEnv().runtime.sendDelaySeconds, 20);
  } finally {
    for (const key of KEYS) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
});

test("buildConfigFromEnv reads *_COMMAND secrets", WIN_SKIP, () => {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

  try {
    delete process.env.PROTONMAIL_USERNAME;
    delete process.env.PROTONMAIL_USERNAME_FILE;
    delete process.env.PROTONMAIL_PASSWORD;
    delete process.env.PROTONMAIL_PASSWORD_FILE;
    process.env.PROTONMAIL_USERNAME_COMMAND = "printf 'owner@example.com\\n'";
    process.env.PROTONMAIL_PASSWORD_COMMAND = "printf 'bridge-secret\\n'";

    const config = buildConfigFromEnv();
    assert.equal(config.smtp.username, "owner@example.com");
    assert.equal(config.smtp.password, "bridge-secret");
  } finally {
    for (const key of KEYS) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
});

// Regression test: PROTONMAIL_SMTP_PORT used to default to 587 with `secure`
// inferred as `smtpPort === 465` — Bridge's actual default local SMTP port
// is 1025 and requires implicit TLS from the first byte (no STARTTLS
// greeting at all), confirmed against a live Bridge instance. The old
// defaults meant SMTP silently failed for anyone following the documented
// zero-config setup (just PROTONMAIL_USERNAME/PASSWORD).
test("buildConfigFromEnv defaults SMTP to Bridge's real port/TLS requirements with zero SMTP-specific config", () => {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

  try {
    process.env.PROTONMAIL_USERNAME = "owner@example.com";
    process.env.PROTONMAIL_PASSWORD = "bridge-secret";
    delete process.env.PROTONMAIL_SMTP_PORT;
    delete process.env.PROTONMAIL_SMTP_SECURE;

    const config = buildConfigFromEnv();
    assert.equal(config.smtp.port, 1025);
    assert.equal(config.smtp.secure, true);
  } finally {
    for (const key of KEYS) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
});

test("buildConfigFromEnv lets PROTONMAIL_SMTP_PORT/PROTONMAIL_SMTP_SECURE override the Bridge defaults", () => {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

  try {
    process.env.PROTONMAIL_USERNAME = "owner@example.com";
    process.env.PROTONMAIL_PASSWORD = "bridge-secret";
    process.env.PROTONMAIL_SMTP_PORT = "2525";
    process.env.PROTONMAIL_SMTP_SECURE = "false";

    const config = buildConfigFromEnv();
    assert.equal(config.smtp.port, 2525);
    assert.equal(config.smtp.secure, false);
  } finally {
    for (const key of KEYS) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
});
