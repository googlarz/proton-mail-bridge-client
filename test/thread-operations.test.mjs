import test from "node:test";
import assert from "node:assert/strict";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";
import { InvalidArgumentError } from "../dist/utils/helpers.js";

// move_thread / delete_thread / flag_thread resolve a Message-ID to every message of the conversation and act
// on each. delete_thread and flag_thread reported only a success count (a failure was swallowed), none of the
// three honoured maxBatchSize, and the Message-ID was not validated: "@" became HEADER Message-ID "@", which a
// server that matches substrings (RFC 3501) answers with nearly every message.

function service(matches, { failUids = [] } = {}) {
  const svc = new SimpleIMAPService({
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" },
    dataDir: "/tmp/thread-ops-test", debug: false, runtime: {},
  });
  const calls = { searches: 0, moved: [], deleted: [], flagged: [] };
  svc.resolveThreadUids = async () => matches;
  svc.resolveSpecialFolder = async () => "Trash";
  svc.verifyFlags = async () => [];
  svc.withMailbox = async (_folder, _ro, action) => action({
    mailbox: { uidValidity: 100n },
    search: async () => { calls.searches += 1; return []; },
    messageMove: async (set) => { if (failUids.includes(Number(set))) throw new Error(`cannot move ${set}`); calls.moved.push(Number(set)); return { path: "x" }; },
    messageDelete: async (set) => { if (failUids.includes(Number(set))) throw new Error(`cannot delete ${set}`); calls.deleted.push(Number(set)); },
    messageFlagsAdd: async (set) => { if (failUids.includes(Number(set))) throw new Error(`cannot flag ${set}`); calls.flagged.push(Number(set)); },
    messageFlagsRemove: async () => {},
  });
  return { svc, calls };
}

const matches = (uids) => uids.map((uid) => ({ folder: "INBOX", uid, emailId: `INBOX::${uid}`, uidValidity: "100" }));

test("delete_thread reports the messages it could not delete, not only the count it deleted", async () => {
  const { svc } = service(matches([1, 2, 3, 4]), { failUids: [2, 4] });
  const result = await svc.deleteThread({ messageId: "<root@x.example>", permanent: true });
  assert.equal(result.deleted, 2);
  assert.equal(result.notDeleted, 2);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /cannot delete/);
});

test("flag_thread reports the messages it could not flag", async () => {
  const { svc } = service(matches([1, 2, 3]), { failUids: [3] });
  const result = await svc.flagThread({ messageId: "<root@x.example>", flagsToAdd: ["\\Seen"] });
  assert.equal(result.affected, 2);
  assert.equal(result.notAffected, 1);
  assert.match(result.errors[0], /cannot flag/);
});

test("move_thread reports why a message was not moved", async () => {
  const { svc } = service(matches([1, 2]), { failUids: [1] });
  const result = await svc.moveThread({ messageId: "<root@x.example>", destination: "Archive" });
  assert.equal(result.moved, 1);
  assert.equal(result.notMoved, 1);
  assert.match(result.errors[0], /cannot move/);
});

test("a thread bigger than maxBatchSize is refused before anything is touched, by all three operations", async () => {
  for (const [method, args] of [["moveThread", { destination: "Archive" }], ["deleteThread", {}], ["flagThread", { flagsToAdd: ["\\Seen"] }]]) {
    const { svc, calls } = service(matches([1, 2, 3, 4, 5]));
    await assert.rejects(svc[method]({ messageId: "<root@x.example>", maxBatchSize: 3, ...args }), /5.*exceeds.*3|exceeds.*limit/i, method);
    assert.deepEqual([calls.moved, calls.deleted, calls.flagged], [[], [], []], `${method} acted although the batch was too big`);
  }
});

test("a dry run does not enforce the limit but still reports how many messages the thread has", async () => {
  const { svc } = service(matches([1, 2, 3, 4, 5]));
  const result = await svc.deleteThread({ messageId: "<root@x.example>", maxBatchSize: 3, dryRun: true });
  assert.equal(result.deleted, 5);
  assert.equal(result.dryRun, true);
});

test("a Message-ID that is not one is refused without searching the mailbox", async () => {
  for (const bad of ["@", "", "  ", "ab", "<>", "<@>", "no-at-sign", "a b@c", "<a@b", "x".repeat(1000) + "@y.example"]) {
    const svc = new SimpleIMAPService({
      smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" },
      imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" },
      dataDir: "/tmp/thread-ops-test", debug: false, runtime: {},
    });
    let searched = 0;
    svc.withMailbox = async () => { searched += 1; return []; };
    svc.getFolders = async () => [{ path: "INBOX", specialUse: "\\Inbox" }];
    await assert.rejects(svc.resolveThreadUids(bad, false), InvalidArgumentError, JSON.stringify(bad.slice(0, 20)));
    assert.equal(searched, 0);
  }
});

test("a real Message-ID is accepted, with or without the angle brackets", async () => {
  for (const good of ["<CAF=abc123@mail.gmail.com>", "abc.def@mail.example", "<20260101.123@host.example>"]) {
    const svc = new SimpleIMAPService({
      smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "o@example.com", password: "x" },
      imap: { host: "127.0.0.1", port: 1143, secure: false, username: "o@example.com", password: "x" },
      dataDir: "/tmp/thread-ops-test", debug: false, runtime: {},
    });
    svc.withMailbox = async (_f, _r, action) => action({ mailbox: { uidValidity: 1n }, search: async () => [] });
    svc.getFolders = async () => [{ path: "INBOX", specialUse: "\\Inbox" }];
    assert.deepEqual(await svc.resolveThreadUids(good, false), [], good);
  }
});
