import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { AccountBundle } from "../services/account-manager.js";
import type { EmailSummary } from "../types/index.js";
import type { Commitment } from "../services/commitment-service.js";
import { extractCommitments } from "../utils/commitment-phrases.js";
import { normalizeLimit } from "../utils/helpers.js";
import { withAudit } from "./audit.js";
import { optionalString, requireString } from "./args.js";
import { maybeRefreshLocalIndex } from "./index-refresh.js";
import { createTextResult } from "./results.js";
import type { ToolContext } from "./context.js";
import type { ToolResult } from "./results.js";

// find_commitments / set_commitment / list_commitments: a ledger of what you promised and what was promised to you.
// The server finds the sentences that look like promises (with the date they name) and keeps the ledger; the
// assistant confirms which are real. Listing says which open ones are overdue, and which probably settled because the
// thread moved on.

const FETCH_BATCH = 6;
const todayUtc = (now: Date) => now.toISOString().slice(0, 10);

export async function evaluateCommitments(bundle: AccountBundle, own: string[], status: "open" | "done" | "dismissed" | "all", idFor: (id: string) => string) {
  const now = new Date();
  const today = todayUtc(now);
  const items = (await bundle.commitmentService.list()).filter((item) => status === "all" || item.status === status);
  return Promise.all(
    items.map(async (item: Commitment) => {
      let moved: string | undefined;
      if (item.status === "open" && item.messageId) {
        // Mine: I wrote again in the thread. Theirs: they did. Either way the promise has probably been kept.
        const later =
          item.direction === "mine"
            ? await bundle.localIndexService.getRepliesSince(item.messageId, item.createdAt, [], own)
            : await bundle.localIndexService.getRepliesSince(item.messageId, item.createdAt, own, item.with ? [item.with] : undefined);
        moved = later[0] ? later[0].internalDate || later[0].date : undefined;
      }
      const overdue = item.status === "open" && !moved && item.due !== undefined && item.due < today;
      const state = item.status !== "open" ? item.status : moved ? "probably-done" : overdue ? "overdue" : item.due === today ? "due-today" : "open";
      return {
        id: item.id,
        direction: item.direction,
        text: item.text,
        state,
        ...(item.due ? { due: item.due } : {}),
        ...(overdue ? { daysOverdue: Math.floor((Date.parse(today) - Date.parse(item.due as string)) / 86_400_000) } : {}),
        ...(item.with ? { with: item.with } : {}),
        ...(item.emailId ? { emailId: idFor(item.emailId) } : {}),
        ...(moved ? { threadMovedAt: moved } : {}),
      };
    }),
  );
}

export async function handleCommitmentTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { resolveAccountArg, primaryBundle, prefixedIdFor, resolveAccountForEmailId, accountManager } = ctx;
  const bundle = resolveAccountArg(args) ?? primaryBundle;
  const ledger = bundle.commitmentService;
  const own = accountManager.all().map((entry) => entry.account.address);

  switch (name) {
    case "find_commitments": {
      const days = normalizeLimit(args.days, 7, 1, 60);
      const limit = normalizeLimit(args.limit, 10, 1, 100);
      const direction = args.direction === "mine" || args.direction === "theirs" ? args.direction : "both";
      await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, { force: false, folder: "INBOX", limitPerFolder: 100 });
      const now = new Date();
      const dateFrom = new Date(now.getTime() - days * 86_400_000).toISOString();
      const known = await ledger.knownMessageIds();
      const sources: Array<{ folder: string; direction: "mine" | "theirs" }> = [];
      if (direction !== "theirs") sources.push({ folder: "Sent", direction: "mine" });
      if (direction !== "mine") sources.push({ folder: "INBOX", direction: "theirs" });
      // Which messages to read: the newest of each source, up to `limit` in all, none already in the ledger.
      const toRead: Array<{ email: EmailSummary; direction: "mine" | "theirs" }> = [];
      for (const source of sources) {
        const found = await bundle.localIndexService.search({ folder: source.folder, dateFrom, limit: limit * 2 });
        for (const email of found.emails) {
          if (toRead.length >= limit) break;
          if (source.direction === "theirs" && email.isAutomated === true) continue;
          if (email.messageId && known.has(email.messageId)) continue;
          toRead.push({ email, direction: source.direction });
        }
      }
      const looked = toRead.length;
      const candidates: Array<Record<string, unknown>> = [];
      // A few at a time: each message is a round trip to Bridge, and one after the other they outlast a client's timeout.
      for (let start = 0; start < toRead.length; start += FETCH_BATCH) {
        const batch = toRead.slice(start, start + FETCH_BATCH);
        const details = await Promise.all(batch.map(({ email }) => bundle.imapService.getEmailById(email.id).catch(() => undefined)));
        details.forEach((detail, index) => {
          const { email, direction: side } = batch[index];
          if (!detail?.text) return;
          for (const hit of extractCommitments(detail.text, now)) {
            candidates.push({
              emailId: prefixedIdFor(bundle, email.id),
              messageId: email.messageId,
              direction: side,
              with: (side === "mine" ? email.to[0]?.address : email.from[0]?.address) ?? "",
              subject: email.subject,
              sentence: hit.sentence,
              ...(hit.due ? { due: hit.due } : {}),
            });
          }
        });
      }
      return createTextResult({
        account: bundle.account.address,
        looked,
        candidates,
        next: "These sentences LOOK like promises; confirm with the user which are real, then set_commitment for each (text, direction, due, with, emailId). Nothing is recorded yet.",
      });
    }

    case "set_commitment": {
      const id = optionalString(args, "id");
      if (id) {
        const status = args.status;
        if (status !== "done" && status !== "dismissed") throw new McpError(ErrorCode.InvalidParams, 'To close a commitment pass status "done" or "dismissed".');
        const closed = await withAudit(bundle.auditService, name, args, async () => ledger.close(id, status));
        if (!closed) throw new McpError(ErrorCode.InvalidParams, `No commitment ${id}.`);
        return createTextResult({ account: bundle.account.address, commitment: closed });
      }
      let messageId = optionalString(args, "messageId");
      let emailId = optionalString(args, "emailId");
      let counterpart = optionalString(args, "with");
      if (emailId) {
        const resolved = resolveAccountForEmailId(emailId);
        if (resolved.bundle !== bundle) throw new McpError(ErrorCode.InvalidParams, "The message belongs to another account; pass that account.");
        const detail = await bundle.imapService.getEmailById(resolved.rest);
        messageId = messageId ?? detail.messageId;
        emailId = detail.id;
        counterpart = counterpart ?? (args.direction === "mine" ? detail.to[0]?.address : detail.from[0]?.address);
      }
      const item = await withAudit(bundle.auditService, name, args, async () =>
        ledger.add({ direction: args.direction as "mine" | "theirs", text: requireString(args, "text"), due: optionalString(args, "due"), with: counterpart, emailId, messageId }),
      );
      return createTextResult({ account: bundle.account.address, commitment: item });
    }

    case "list_commitments": {
      const status = args.status === "done" || args.status === "dismissed" || args.status === "all" ? args.status : "open";
      const shown = await evaluateCommitments(bundle, own, status, (id) => prefixedIdFor(bundle, id));
      const order = { overdue: 0, "due-today": 1, open: 2, "probably-done": 3, done: 4, dismissed: 5 } as Record<string, number>;
      shown.sort((a, b) => order[a.state] - order[b.state] || (a.due ?? "9").localeCompare(b.due ?? "9"));
      return createTextResult({
        account: bundle.account.address,
        counts: { overdue: shown.filter((s) => s.state === "overdue").length, dueToday: shown.filter((s) => s.state === "due-today").length, total: shown.length },
        commitments: shown,
      });
    }
  }
  throw new McpError(ErrorCode.MethodNotFound, `Unknown commitment tool: ${name}`);
}
