import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { planChanges, type MailRule } from "../services/rules-service.js";
import { exportSieve } from "../services/sieve-export.js";
import type { EmailSummary } from "../types/index.js";
import { ensureDestructiveConfirmed, ensureMailboxWriteAllowed, ensureOutboundRecipientsAllowed, ensureSendAllowed } from "../utils/runtime-policy.js";
import { normalizeBoolean, optionalBoolean, optionalInteger } from "../utils/helpers.js";
import { optionalString, requireString } from "./args.js";
import { withAudit } from "./audit.js";
import type { ToolContext } from "./context.js";
import { createTextResult, type ToolResult } from "./results.js";
import { assertPlanAllowed, describe, executePlan, requiredActions } from "./rules-runner.js";

// Mailbox rules: scan for proposals, keep rules, and apply them to mail that is already there (after a preview).

export async function handleRuleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { config, resolveAccountArg, primaryBundle } = ctx;
  const target = resolveAccountArg(args) ?? primaryBundle;
  const runtime = config.runtime;
  switch (name) {
    case "suggest_rules": {
      const days = optionalInteger(args.days, 7, 365) ?? 90;
      const minMessages = optionalInteger(args.minMessages, 3, 50) ?? 5;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const found = await target.localIndexService.search({ dateFrom: since, limit: 5000 });
      let canSave = true;
      try {
        ensureMailboxWriteAllowed(runtime);
      } catch {
        canSave = false;
      }
      const proposals = await target.rulesService.suggest(found.emails, { days, minMessages, ownAddresses: target.ownAddresses, save: canSave });
      return createTextResult({
        account: target.account.address,
        scanned: { messages: found.emails.length, days, minMessages },
        note:
          found.emails.length >= 5000
            ? "Only the newest 5000 messages were scanned."
            : "Only mail in the local index is scanned (by default INBOX and Sent); run sync_emails for other folders first.",
        proposals: proposals.map((proposal) => ({
          id: proposal.id,
          title: proposal.title,
          risk: proposal.risk,
          rule: proposal.rule,
          evidence: proposal.evidence,
        })),
        next: proposals.length
          ? "To accept one: set_rule with proposalId. To refuse it for good: delete_rule with the proposal's id. Nothing has been changed."
          : "Nothing to propose from this mail.",
      });
    }

    case "get_rules": {
      const state = await target.rulesService.get();
      return createTextResult({ account: target.account.address, ...state });
    }

    case "set_rule": {
      const proposalId = optionalString(args, "proposalId");
      const proposal = proposalId ? await target.rulesService.findProposal(proposalId) : undefined;
      if (proposalId && !proposal) throw new McpError(ErrorCode.InvalidParams, `No pending proposal ${proposalId}. Run suggest_rules to see the current ones.`);
      const patch = {
        id: optionalString(args, "id"),
        name: optionalString(args, "name") ?? proposal?.rule.name,
        enabled: optionalBoolean(args.enabled),
        when: args.when ?? proposal?.rule.when,
        actions: args.actions ?? proposal?.rule.actions,
        source: proposalId,
      };
      // Validate first (a bad rule fails with its own message), actions apply the policy to what it would do.
      const existing = patch.id ? (await target.rulesService.allRules()).find((rule) => rule.id === patch.id) : undefined;
      const effectiveThen = (patch.actions ?? existing?.actions) as MailRule["actions"] | undefined;
      if (effectiveThen?.forwardTo?.length && patch.enabled !== false) {
        // Forwarding to an address of the same account would feed the copy back into the rule.
        const own = new Set(target.ownAddresses.map((address) => address.trim().toLowerCase()));
        const loop = effectiveThen.forwardTo.find((address) => own.has(address.trim().toLowerCase()));
        if (loop) throw new McpError(ErrorCode.InvalidParams, `${loop} is an address of this account, so the forwarded copy would come back and be forwarded again. Forward to another address.`);
        // It sends mail on its own: everything a send needs, and a confirmation like one.
        ensureSendAllowed(runtime);
        ensureOutboundRecipientsAllowed(runtime, target.config.smtp.username, effectiveThen.forwardTo);
        ensureDestructiveConfirmed(runtime, normalizeBoolean(args.confirmed, false), `Switch on forwarding from ${target.account.address} to ${effectiveThen.forwardTo.join(", ")}: it will send mail without asking each time`);
      } else if (patch.enabled !== false) {
        ensureMailboxWriteAllowed(runtime);
      }
      const rule = await withAudit(target.auditService, name, args, async () => target.rulesService.set(patch));
      const warnings: string[] = [];
      if (rule.enabled && !target.backgroundSyncService.getStatus().enabled) warnings.push("Background sync is off (PROTONMAIL_AUTO_SYNC), so the rule only acts on mail when you run apply_rules.");
      if (rule.enabled && (rule.actions.trash || rule.actions.delete)) warnings.push("This rule trashes or deletes, so it never runs by itself: use apply_rules (it shows a preview first).");
      if (rule.enabled && rule.actions.forwardTo) warnings.push("It forwards only mail that arrives from now on, once per message, at most 50 a day, and by default only mail from people.");
      return createTextResult({ account: target.account.address, rule, ...(warnings.length ? { warnings } : {}) });
    }

    case "delete_rule": {
      const id = requireString(args, "id");
      const outcome = await withAudit(target.auditService, name, args, async () => target.rulesService.remove(id));
      if (outcome.removed === "none") throw new McpError(ErrorCode.InvalidParams, `No rule or proposal with id ${id}.`);
      return createTextResult({ account: target.account.address, id, ...outcome, note: outcome.removed === "proposal" ? "It will not be proposed again." : undefined });
    }

    case "export_sieve": {
      const ruleId = optionalString(args, "ruleId");
      const all = await target.rulesService.allRules();
      if (ruleId && !all.some((rule) => rule.id === ruleId)) throw new McpError(ErrorCode.InvalidParams, `No rule with id ${ruleId}.`);
      // A named rule is exported even if it is switched off, the way apply_rules runs it.
      const rules = ruleId ? all.filter((rule) => rule.id === ruleId).map((rule) => ({ ...rule, enabled: true })) : all;
      const result = exportSieve(rules);
      return createTextResult({
        account: target.account.address,
        ...result,
        note: result.script
          ? "Not tried on a Proton account: paste it into a new Sieve filter in Proton's filter settings and check it there. The folders and labels it names must already exist. Proton may also run filters on mail it puts in Spam, which the local rules never touch."
          : all.length === 0
            ? "There are no rules to export."
            : "None of these rules can be expressed in Proton's Sieve; see unsupported.",
      });
    }

    case "apply_rules": {
      const dryRun = normalizeBoolean(args.dryRun, true);
      const limit = optionalInteger(args.limit, 1, 1000) ?? 200;
      const ruleId = optionalString(args, "ruleId");
      const all = await target.rulesService.allRules();
      if (ruleId && !all.some((rule) => rule.id === ruleId)) throw new McpError(ErrorCode.InvalidParams, `No rule with id ${ruleId}.`);
      // A named rule runs even if it is switched off (to try it); otherwise the enabled ones.
      const rules = ruleId ? all.filter((rule) => rule.id === ruleId).map((rule) => ({ ...rule, enabled: true })) : all.filter((rule) => rule.enabled);
      if (rules.length === 0) return createTextResult({ account: target.account.address, dryRun, note: "There are no enabled rules." });
      const folders = [...new Set(rules.map((rule) => rule.when.folder ?? "INBOX"))];
      const emails: EmailSummary[] = [];
      for (const folder of folders) emails.push(...(await target.localIndexService.search({ folder, limit: 3000 })).emails);
      const plan = planChanges(rules, emails, Date.now(), { ownAddresses: target.ownAddresses }).filter((change) => describe(change).length > 0);
      const kinds = requiredActions(plan);
      if (!dryRun) {
        assertPlanAllowed(target, plan.slice(0, limit));
        if (kinds.includes("delete")) {
          ensureDestructiveConfirmed(runtime, normalizeBoolean(args.confirmed, false), `Delete ${plan.filter((change) => change.disposition?.kind === "delete").length} message(s) for good`);
        }
      }
      const outcome = await withAudit(target.auditService, name, { ...args, dryRun }, async () => executePlan(target, plan, { automatic: false, dryRun, limit }));
      return createTextResult({
        account: target.account.address,
        ...outcome,
        matched: plan.length,
        ...(plan.length > limit ? { note: `${plan.length - limit} more match; this run covers the first ${limit}.` } : {}),
        ...(dryRun ? { next: "This was a preview; nothing changed. Run apply_rules with dryRun:false to do it." } : {}),
      });
    }

    default:
      throw new Error(`handleRuleTool: unexpected tool ${name}`);
  }
}
