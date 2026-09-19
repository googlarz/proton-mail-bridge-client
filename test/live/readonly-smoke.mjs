// Opt-in, READ-ONLY smoke test against a real Proton Bridge. Not part of `npm test`.
//
//   PROTONMAIL_USERNAME=... PROTONMAIL_PASSWORD=... [PROTONMAIL_ACCOUNTS_JSON=...] \
//     node test/live/readonly-smoke.mjs
//
// Safety: the server is started with PROTONMAIL_READ_ONLY=true, background sync off, and a
// throwaway PROTONMAIL_DATA_DIR (so no local state of your real install is touched); only
// read tools are called, nothing is sent, moved, flagged or drafted. Output contains
// counts, statuses and timings only — never subjects, addresses or bodies.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (!process.env.PROTONMAIL_USERNAME || !process.env.PROTONMAIL_PASSWORD) {
  console.error("Set PROTONMAIL_USERNAME and PROTONMAIL_PASSWORD (and optionally PROTONMAIL_ACCOUNTS_JSON).");
  process.exit(2);
}

const dataDir = await mkdtemp(join(tmpdir(), "proton-live-smoke-"));
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("PROTONMAIL_") || k === "PATH" || k === "HOME")),
  PROTONMAIL_READ_ONLY: "true",
  PROTONMAIL_AUTO_SYNC: "false",
  PROTONMAIL_IDLE_WATCH: "false",
  PROTONMAIL_STARTUP_SYNC: "false",
  PROTONMAIL_DATA_DIR: dataDir,
};
delete env.PROTONMAIL_ALLOW_FILE_DOWNLOAD_DIR;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../../dist/index.js", import.meta.url))],
  env,
  stderr: "ignore",
});
const client = new Client({ name: "live-smoke", version: "0" });
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
async function call(name, args = {}) {
  const t0 = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";
  let data;
  try { data = JSON.parse(text); } catch { data = undefined; }
  return { result, data, ms: Date.now() - t0, isError: Boolean(result.isError) };
}

try {
  await client.connect(transport);

  const status = await call("get_connection_status");
  check("connection status", !status.isError, `${status.ms}ms`);

  const accounts = await call("list_accounts");
  const accountList = accounts.data?.accounts ?? accounts.data ?? [];
  check("list_accounts", !accounts.isError && Array.isArray(accountList), `${accountList.length} account(s)`);

  const folders = await call("get_folders");
  const folderList = folders.data?.folders ?? folders.data ?? [];
  check("get_folders", !folders.isError && Array.isArray(folderList) && folderList.length > 0, `${folderList.length} folders`);

  const emails = await call("get_emails", { limit: 3 });
  const emailList = emails.data?.emails ?? [];
  check("get_emails limit 3", !emails.isError && emailList.length <= 3, `${emailList.length} returned, ${emails.ms}ms`);
  check("email ids are routable (account prefix or plain)", emailList.every((e) => typeof e.id === "string" && e.id.length > 0));

  if (emailList.length > 0) {
    const one = await call("get_email_by_id", { emailId: emailList[0].id });
    check("get_email_by_id round-trips an id from get_emails", !one.isError, `${one.ms}ms`);
  }

  const search = await call("search_emails", { query: "a", limit: 5 });
  check("search_emails default path", !search.isError, `${search.ms}ms`);

  const drafts = await call("list_drafts");
  check("list_drafts (isolated data dir: empty, bounded shape)", !drafts.isError && typeof drafts.data?.hasMore === "boolean", `total ${drafts.data?.total}`);

  const queue = await call("list_scheduled_sends");
  check("list_scheduled_sends shape", !queue.isError && Array.isArray(queue.data?.items) && typeof queue.data?.hasMore === "boolean");

  const resources = await client.listResources();
  check("resources/list", Array.isArray(resources.resources), `${resources.resources.length} listed`);

  // Local index against the real mailbox (into the throwaway data dir). sync_emails only
  // reads IMAP and writes the local SQLite index. (run_background_sync would be a no-op
  // status report here — background sync is off — so it is deliberately not used.)
  const stat = (r) => (r.data?.synced?.folderStats ?? [])[0] ?? {};
  const sync1 = await call("sync_emails", { folder: "INBOX", limitPerFolder: 50, includeAttachmentText: false });
  const s1 = stat(sync1);
  check("first index sync of INBOX fetched messages", !sync1.isError && (s1.fetched ?? 0) > 0, `strategy ${s1.strategy}, fetched ${s1.fetched}, total ${s1.total}, ${sync1.ms}ms`);
  const sync2 = await call("sync_emails", { folder: "INBOX", limitPerFolder: 50, includeAttachmentText: false });
  const s2 = stat(sync2);
  check("second incremental sync does not refetch the whole window", !sync2.isError && (s2.fetched ?? 0) <= (s1.fetched ?? 0), `fetched ${s2.fetched}, ${sync2.ms}ms`);

  const full1 = await call("sync_emails", { folder: "INBOX", full: true, limitPerFolder: 50, includeAttachmentText: false });
  const f1 = stat(full1);
  const full2 = await call("sync_emails", { folder: "INBOX", full: true, limitPerFolder: 50, includeAttachmentText: false });
  const f2 = stat(full2);
  check("full sync walks history backwards without error", !full1.isError && !full2.isError && (f2.backfilledToUid ?? 0) <= (f1.backfilledToUid ?? Infinity), `backfilledToUid ${f1.backfilledToUid} -> ${f2.backfilledToUid}, fetched ${f1.fetched}/${f2.fetched}`);

  const indexed = await call("search_indexed_emails", { limit: 5 });
  const indexedCount = indexed.data?.emails?.length ?? 0;
  check("search_indexed_emails returns synced mail", !indexed.isError && indexedCount > 0 && indexedCount <= 5, `${indexedCount} returned`);

  const thread = indexed.data?.emails?.[0]?.threadId;
  if (thread) {
    const t = await call("get_thread_by_id", { threadId: thread });
    check("get_thread_by_id round-trips a threadId from the index", !t.isError, `${t.ms}ms`);
  }

  const resourcesAfter = await client.listResources();
  check("resources/list now enumerates indexed mail", resourcesAfter.resources.length > 0, `${resourcesAfter.resources.length} listed`);

  const doctor = await call("run_doctor");
  check("run_doctor", !doctor.isError, `${doctor.ms}ms`);
} catch (error) {
  check("smoke run", false, error instanceof Error ? error.message : String(error));
} finally {
  await client.close().catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
