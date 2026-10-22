import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { AccountBundle } from "../services/account-manager.js";
import type { AppliedItem, PlanAction, PlanItem } from "../services/triage-plan-service.js";
import { normalizeLimit, optionalNumber, parseEmailId } from "../utils/helpers.js";
import { ensureEmailActionAllowed, ensureMailboxWriteAllowed } from "../utils/runtime-policy.js";
import { withAudit } from "./audit.js";
import { requireString } from "./args.js";
import { maybeRefreshLocalIndex } from "./index-refresh.js";
import { createTextResult } from "./results.js";
import type { ToolContext } from "./context.js";
import type { ToolResult } from "./results.js";

// plan_inbox / approve_plan / undo_plan: tidy the mailbox in one reviewed batch. A plan holds changes that can be taken
// back (archive, move, mark read, label), from the model's own proposals and from a scan for automatic mail nobody
// reads. Approving applies the chosen ones and records how to undo each; what was left out is not proposed again.

const ACTIONS: PlanAction[] = ["archive", "move", "mark_read", "label"];
const MAX_ITEMS = 200;
const OLD_READ_AUTOMATED_DAYS = 14;

function allowedNow(bundle: AccountBundle, action: PlanAction): boolean {
  try {
    if (action === "label") ensureMailboxWriteAllowed(bundle.config.runtime);
    else ensureEmailActionAllowed(bundle.config.runtime, action);
    return true;
  } catch {
    return false;
  }
}

function describeItem(item: PlanItem): string {
  return item.action === "move" ? `move to ${item.target}` : item.action === "label" ? `label ${item.target}` : item.action === "mark_read" ? "mark read" : "archive";
}

export async function handleTriageTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { resolveAccountArg, primaryBundle, prefixedIdFor, resolveAccountForEmailId } = ctx;
  const bundle = resolveAccountArg(args) ?? primaryBundle;
  const plans = bundle.triagePlanService;
  const present = (item: PlanItem) => ({ n: item.n, emailId: prefixedIdFor(bundle, item.emailId), from: item.from, subject: item.subject, do: describeItem(item), reason: item.reason, source: item.source });

  switch (name) {
    case "plan_inbox": {
      const limit = normalizeLimit(args.limit, 30, 1, MAX_ITEMS);
      const minAgeDays = optionalNumber(args.minAgeDays, 0, 365) ?? 3;
      const supplied = Array.isArray(args.items) ? (args.items as unknown[]) : [];
      if (supplied.length > MAX_ITEMS) throw new McpError(ErrorCode.InvalidParams, `At most ${MAX_ITEMS} items in one plan.`);
      const items: Array<Omit<PlanItem, "n">> = [];
      const used = new Set<string>();
      for (const raw of supplied) {
        const entry = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const action = entry.action as PlanAction;
        if (!ACTIONS.includes(action)) throw new McpError(ErrorCode.InvalidParams, `Each item needs an action: ${ACTIONS.join(", ")}. Deleting is not part of a plan.`);
        const target = typeof entry.target === "string" ? entry.target.trim() : undefined;
        if ((action === "move" || action === "label") && !target) throw new McpError(ErrorCode.InvalidParams, `An item with action ${action} needs a target.`);
        if (typeof entry.emailId !== "string") throw new McpError(ErrorCode.InvalidParams, "Each item needs an emailId.");
        const resolved = resolveAccountForEmailId(entry.emailId);
        if (resolved.bundle !== bundle) throw new McpError(ErrorCode.InvalidParams, `${entry.emailId} belongs to another account than ${bundle.account.address}; make one plan per account.`);
        if (used.has(resolved.rest)) continue;
        used.add(resolved.rest);
        const detail = await bundle.imapService.getEmailById(resolved.rest);
        items.push({ emailId: detail.id, from: detail.from[0]?.address ?? "", subject: detail.subject, action, ...(target ? { target } : {}), reason: typeof entry.reason === "string" && entry.reason.trim() ? entry.reason.trim().slice(0, 300) : "proposed by the assistant", source: "client" });
      }

      if (args.scan !== false) {
        await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, { force: false, folder: "INBOX", limitPerFolder: 100 });
        const declined = await plans.declinedSenders();
        const found = await bundle.localIndexService.search({ folder: "INBOX", limit: 500 });
        const now = Date.now();
        for (const email of found.emails) {
          if (items.length >= limit + supplied.length) break;
          const sender = (email.from[0]?.address ?? "").toLowerCase();
          if (email.isAutomated !== true || used.has(email.id) || declined.has(sender)) continue;
          const ageDays = Math.floor((now - Date.parse(email.internalDate || email.date || "")) / 86_400_000);
          if (!Number.isFinite(ageDays)) continue;
          if (!email.isRead && ageDays >= minAgeDays) items.push({ emailId: email.id, from: sender, subject: email.subject, action: "archive", reason: `automatic mail, unread for ${ageDays} days`, source: "scan" });
          else if (email.isRead && ageDays >= OLD_READ_AUTOMATED_DAYS) items.push({ emailId: email.id, from: sender, subject: email.subject, action: "archive", reason: `automatic mail you already read, ${ageDays} days old`, source: "scan" });
        }
      }
      if (items.length === 0) return createTextResult({ account: bundle.account.address, plan: null, note: "Nothing to propose: no automatic mail waiting in the INBOX and no items given." });
      const plan = await plans.create(items);
      const blocked = [...new Set(plan.items.filter((item) => !allowedNow(bundle, item.action)).map((item) => item.action))];
      return createTextResult({
        account: bundle.account.address,
        planId: plan.id,
        items: plan.items.map(present),
        ...(blocked.length ? { notAllowedNow: blocked, note: `The current runtime policy does not allow: ${blocked.join(", ")}. Those items will be skipped on approval.` } : {}),
        next: "Show the list to the user. approve_plan applies all of it, or only the numbers in `items`, or everything except `exclude`. Nothing has changed yet.",
      });
    }

    case "approve_plan": {
      const planId = requireString(args, "planId");
      const plan = await plans.get(planId);
      if (!plan) throw new McpError(ErrorCode.InvalidParams, `No plan ${planId}. plan_inbox makes one.`);
      if (plan.status !== "open") throw new McpError(ErrorCode.InvalidParams, `Plan ${planId} was already ${plan.status}.`);
      const numbers = (value: unknown) => (Array.isArray(value) ? value.map(Number).filter(Number.isInteger) : undefined);
      const only = numbers(args.items);
      const exclude = new Set(numbers(args.exclude) ?? []);
      const chosen = plan.items.filter((item) => (only ? only.includes(item.n) : true) && !exclude.has(item.n));
      if (chosen.length === 0) throw new McpError(ErrorCode.InvalidParams, "No item selected.");
      const left = plan.items.filter((item) => !chosen.includes(item));

      const applied: AppliedItem[] = await withAudit(bundle.auditService, name, args, async () => {
        const out: AppliedItem[] = [];
        for (const item of chosen) {
          try {
            if (!allowedNow(bundle, item.action)) {
              out.push({ n: item.n, ok: false, error: "not allowed by the current runtime policy" });
              continue;
            }
            const uidValidity = parseEmailId(item.emailId).uidValidity;
            const original = parseEmailId(item.emailId).folder;
            if (item.action === "archive") {
              const result = await bundle.imapService.archiveEmail(item.emailId, uidValidity);
              out.push({ n: item.n, ok: true, undo: result.targetEmailId ? { kind: "move", emailId: result.targetEmailId, backTo: original } : undefined });
            } else if (item.action === "move") {
              const result = await bundle.imapService.moveEmail(item.emailId, item.target as string, uidValidity);
              out.push({ n: item.n, ok: true, undo: result.targetEmailId ? { kind: "move", emailId: result.targetEmailId, backTo: original } : undefined });
            } else if (item.action === "mark_read") {
              await bundle.imapService.markEmailRead(item.emailId, true, uidValidity);
              out.push({ n: item.n, ok: true, undo: { kind: "unread", emailId: item.emailId } });
            } else {
              await bundle.imapService.updateMessageLabels(item.emailId, [item.target as string], [], uidValidity);
              out.push({ n: item.n, ok: true, undo: { kind: "unlabel", emailId: item.emailId, label: item.target as string } });
            }
          } catch (error) {
            out.push({ n: item.n, ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        }
        return out;
      });
      await plans.markApplied(planId, applied, left.filter((item) => item.source === "scan").map((item) => item.from.toLowerCase()));
      return createTextResult({
        account: bundle.account.address,
        planId,
        applied: applied.filter((item) => item.ok).length,
        failed: applied.filter((item) => !item.ok).map((item) => ({ n: item.n, error: item.error })),
        leftOut: left.map((item) => item.n),
        note: left.some((item) => item.source === "scan") ? "Senders of the scanned items you left out will not be proposed again." : undefined,
        undo: `undo_plan with planId ${planId} puts the applied changes back.`,
      });
    }

    case "undo_plan": {
      const planId = requireString(args, "planId");
      const plan = await plans.get(planId);
      if (!plan?.applied) throw new McpError(ErrorCode.InvalidParams, `Plan ${planId} was not applied, so there is nothing to undo.`);
      const outcome = await withAudit(bundle.auditService, name, args, async () => {
        const next: AppliedItem[] = [];
        for (const item of plan.applied as AppliedItem[]) {
          if (!item.ok || !item.undo || item.undone) {
            next.push(item);
            continue;
          }
          try {
            if (item.undo.kind === "move") {
              ensureEmailActionAllowed(bundle.config.runtime, "move");
              await bundle.imapService.moveEmail(item.undo.emailId, item.undo.backTo);
            } else if (item.undo.kind === "unread") {
              ensureEmailActionAllowed(bundle.config.runtime, "mark_read");
              await bundle.imapService.markEmailRead(item.undo.emailId, false);
            } else {
              ensureMailboxWriteAllowed(bundle.config.runtime);
              await bundle.imapService.updateMessageLabels(item.undo.emailId, [], [item.undo.label]);
            }
            next.push({ ...item, undone: true });
          } catch (error) {
            next.push({ ...item, error: `undo failed: ${error instanceof Error ? error.message : String(error)}` });
          }
        }
        return next;
      });
      const saved = await plans.markUndone(planId, outcome);
      return createTextResult({
        account: bundle.account.address,
        planId,
        status: saved.status,
        undone: outcome.filter((item) => item.undone).length,
        failed: outcome.filter((item) => item.error?.startsWith("undo failed")).map((item) => ({ n: item.n, error: item.error })),
      });
    }
  }
  throw new McpError(ErrorCode.MethodNotFound, `Unknown triage tool: ${name}`);
}
