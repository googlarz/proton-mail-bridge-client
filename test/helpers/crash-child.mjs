// Child process used by test/crash-and-multiprocess.test.mjs. Modes (argv[2]):
//   send-hang  <dataDir>            claim a due queued send, start "SMTP", then hang forever
//   hold-lock  <dataDir>            take the draft-store file lock and hang forever
//   sync-once  <dataDir> <draftId>  run one fake remote sync of the draft under the sync lock
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DraftStoreService } from "../../dist/services/draft-store-service.js";
import { DeliveryQueueService } from "../../dist/services/delivery-queue-service.js";
import { withFileLock } from "../../dist/utils/file-lock.js";

const [, , mode, dataDir, draftId] = process.argv;

function config() {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: "owner@example.com", password: "x" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: "owner@example.com", password: "x" },
    dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    runtime: {
      readOnly: false, allowSend: true, allowRemoteDraftSync: true, allowedActions: [], startupSync: false,
      autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25, idleWatchEnabled: false, idleMaxSeconds: 30,
      confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, allowFileDownloadDir: undefined,
      maxInlineBytes: 40960, opDelayMs: 0,
    },
  };
}

const hang = () => new Promise(() => setInterval(() => {}, 1 << 30));

if (mode === "send-hang") {
  const store = new DraftStoreService(config());
  const draft = await store.createDraft({ to: ["x@example.com"], subject: "S", body: "b" });
  const smtp = {
    async sendEmail() {
      await writeFile(join(dataDir, "smtp-in-flight"), String(process.pid));
      await hang(); // SMTP "in flight" — the parent SIGKILLs us here
    },
  };
  const queue = new DeliveryQueueService(config(), smtp);
  queue.setDraftStore(store);
  await queue.enqueue({ to: ["x@example.com"], subject: "S", body: "b" }, new Date(Date.now() - 1000).toISOString(), "scheduled_send", draft.id);
  await writeFile(join(dataDir, "draft-id"), draft.id);
  void queue.checkDue();
  await hang();
} else if (mode === "hold-lock") {
  const store = new DraftStoreService(config());
  await store.createDraft({ to: ["x@example.com"], subject: "S", body: "b" });
  await withFileLock(join(dataDir, "drafts.json"), async () => {
    await writeFile(join(dataDir, "lock-held"), String(process.pid));
    await hang();
  });
} else if (mode === "sync-once") {
  // A fake remote Drafts mailbox: a file. The real sync does "if we have no remote copy
  // yet, APPEND; otherwise update it" — reading and writing the copy under the sync lock.
  const store = new DraftStoreService(config());
  const remote = join(dataDir, "remote-copy");
  const log = join(dataDir, "sync-log");
  await store.withDraftSyncLock(draftId, async () => {
    let existing;
    try { existing = await readFile(remote, "utf8"); } catch { existing = undefined; }
    await appendFile(log, `${process.pid}:${existing ? "update" : "append"}:start\n`);
    await new Promise((resolve) => setTimeout(resolve, 150)); // upload takes a moment
    await writeFile(remote, existing ?? String(process.pid));
    await appendFile(log, `${process.pid}:${existing ? "update" : "append"}:end\n`);
  });
}
