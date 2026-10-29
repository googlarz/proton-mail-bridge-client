import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { AccountBundle, AccountManager } from "../services/account-manager.js";
import { type Grant, GrantService, grantStatus } from "../services/grant-service.js";
import type { ProtonMailConfig } from "../types/index.js";
import type { ApprovalMode } from "../utils/approval.js";
import { isGrantableTool } from "../utils/delegation.js";
import { normalizeBoolean, parseEmails } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";
import { type MailTaint, isGatedAction } from "../utils/mail-security.js";
import { optionalAddressList, optionalString } from "./args.js";
import { sanitizeAuditValue } from "./audit.js";
import { getReplyRecipients, uniqueAddresses } from "./compose.js";
import { type ToolResult, createTextResult } from "./results.js";
import type { ToolContext } from "./context.js";

// PROTONMAIL_DELEGATION=on: a gated send that a grant covers counts as already approved. Two steps, so that the people
// and the model see no difference when nothing matches:
//   approve()  in front of the tool call: finds a grant that covers the recipients the call will really use, and only then
//              stands in for the person's confirmation (nothing is spent yet);
//   claim()    inside the handler, once the final recipients are known and every other check has passed, immediately
//              before the mail is sent or queued: spends the use under the store's lock and writes it to the audit and
//              event logs. A grant that no longer covers the call by then (used up by another process, revoked, a draft
//              edited in between) stops the send.
// A grant never replaces the taint gate (a session that read steering mail still needs the person), read-only mode,
// PROTONMAIL_ALLOW_SEND, the outbound allow-list or any other check: those run before claim() or are not asked at all.

interface Resolvers {
  resolveAccountForEmailId(id: string): { bundle: AccountBundle; rest: string };
  allAccountAddresses(): string[];
}

export class Delegation {
  private readonly stores = new Map<string, GrantService>();
  // Calls approve() let through on a grant, by their argument object (server-side identity: a model cannot forge membership).
  private readonly delegated = new WeakSet<object>();

  constructor(
    private readonly deps: Resolvers & { config: ProtonMailConfig; accountManager: AccountManager; taint: MailTaint },
  ) {}

  grants(bundle: AccountBundle): GrantService {
    let store = this.stores.get(bundle.account.slug);
    if (!store) {
      store = new GrantService(bundle.config, bundle.account.address);
      this.stores.set(bundle.account.slug, store);
    }
    return store;
  }

  /**
   * Whether a grant stands in for the person's approval of this call. When it does, `confirmed` is set for the checks
   * behind this one. Anything doubtful (an unreadable argument, a lookup that fails, a store that cannot be read) is "no".
   */
  async approve(name: string, args: Record<string, unknown>, options: { declared: ReadonlySet<string>; approval: ApprovalMode; canElicit: boolean }): Promise<boolean> {
    const { config, taint } = this.deps;
    if (config.runtime.delegation !== "on" || !isGrantableTool(name)) return false;
    try {
      // A preview is not gated; and a session that read steering mail needs the person, not a standing permission.
      if (!isGatedAction(name, args, options.declared) || taint.current()) return false;
      // Only a call that would otherwise be stopped (the person asked, or the handler wanting confirmed: true) spends a grant.
      const personWouldBeAsked = options.approval === "require" || (options.approval === "elicit" && options.canElicit);
      if (!personWouldBeAsked && !(config.runtime.confirmDestructive && !normalizeBoolean(args.confirmed, false))) return false;
      const target = await this.resolve(name, args);
      if (!target || !(await this.grants(target.bundle).find({ tool: name, recipients: target.recipients }))) return false;
      // The taint is read again with nothing awaited between here and the gate that follows.
      if (taint.current()) return false;
      args.confirmed = true;
      this.delegated.add(args);
      return true;
    } catch (error) {
      logger.warn("Delegation could not be checked; the normal confirmation applies", "Delegation", error);
      return false;
    }
  }

  /**
   * Called by a send handler right before it sends or queues: spends the use. Does nothing for a call no grant approved.
   * `bundle` is the account the mail goes out through, `recipients` every To, Cc and Bcc address it will really use, and
   * `source` (a forward) the account the forwarded message is read from.
   */
  async claim(args: Record<string, unknown>, tool: string, bundle: AccountBundle, recipients: readonly string[], source?: AccountBundle): Promise<void> {
    if (!this.delegated.delete(args)) return;
    const refuse = (text: string) => new McpError(ErrorCode.InvalidRequest, `${text} Do not retry unless the user asks for it.`);
    if (source && source.account.slug !== bundle.account.slug) {
      throw refuse(`${tool} was not run: a delegation grant covers only a message of its own account, not one of ${source.account.address}. Ask the user to approve it.`);
    }
    if (this.deps.taint.current()) {
      throw refuse(`${tool} was not run: a message read in this session looks like an attempt to steer an AI, so a delegation grant cannot stand in for the user. Ask the user whether ${tool} is really wanted.`);
    }
    const claimed = await this.grants(bundle).claim({ tool, recipients });
    if (!claimed) {
      throw refuse(`${tool} was not run: no delegation grant covers it any more (used up, expired, revoked, or a recipient is not on it). Ask the user to approve it.`);
    }
    const { grant, remaining } = claimed;
    try {
      await bundle.auditService.record({
        timestamp: new Date().toISOString(),
        tool: "delegation_use",
        status: "success",
        durationMs: 0,
        input: sanitizeAuditValue({ grantId: grant.id, tool, account: grant.account, recipients, remainingUses: remaining }) as Record<string, unknown>,
      });
    } catch (error) {
      // The use is already spent in the store; failing here would only hide that.
      logger.error("Could not write the audit entry for a delegation use", "Delegation", { grantId: grant.id, error });
    }
    bundle.eventLog.emit({ type: "delegation.used", refId: grant.id, detail: `${tool} under grant ${grant.id}: ${remaining} of ${grant.maxUses} uses left` });
  }

  // The account a call sends through and the recipients it will use, worked out the way each handler does (sending.ts, drafts.ts).
  private async resolve(name: string, args: Record<string, unknown>): Promise<{ bundle: AccountBundle; recipients: string[] } | undefined> {
    const { accountManager } = this.deps;
    const list = (key: string) => parseEmails(optionalAddressList(args, key));
    const sendingAs = (from: string | undefined, fallback: AccountBundle) => (from ? accountManager.byAddress(from) : undefined) ?? fallback;
    switch (name) {
      case "send_email": {
        const from = optionalString(args, "from");
        return { bundle: sendingAs(from, accountManager.primary()), recipients: [...list("to"), ...list("cc"), ...list("bcc")] };
      }
      case "forward_email": {
        const emailId = optionalString(args, "emailId");
        if (!emailId) return undefined;
        const { bundle: read } = this.deps.resolveAccountForEmailId(emailId);
        const sending = sendingAs(optionalString(args, "from"), read);
        // A forward hands the message's content to the recipients: only a message of the grant's own account may go.
        if (sending.account.slug !== read.account.slug) return undefined;
        return { bundle: sending, recipients: [...list("to"), ...list("cc"), ...list("bcc")] };
      }
      case "reply_to_email":
      case "reply_all_email": {
        const emailId = optionalString(args, "emailId");
        if (!emailId) return undefined;
        const { bundle: read, rest } = this.deps.resolveAccountForEmailId(emailId);
        const detail = await read.imapService.getEmailById(rest);
        const replyAll = name === "reply_all_email" || normalizeBoolean(args.replyAll, false);
        const base = getReplyRecipients(detail, read.config.smtp.username, replyAll, this.deps.allAccountAddresses());
        return {
          bundle: sendingAs(optionalString(args, "from"), read),
          recipients: [...uniqueAddresses(base.to), ...uniqueAddresses([...base.cc, ...list("cc")]), ...list("bcc")],
        };
      }
      case "send_draft":
      case "schedule_draft": {
        const draftId = optionalString(args, "draftId");
        if (!draftId) return undefined;
        const { bundle: stored, rest } = this.deps.resolveAccountForEmailId(draftId);
        const draft = await stored.draftStore.getDraft(rest);
        return { bundle: sendingAs(draft.from, stored), recipients: [...draft.to, ...draft.cc, ...draft.bcc] };
      }
      default:
        return undefined;
    }
  }
}

const activeGrant = (grant: Grant, now: Date) => grantStatus(grant, now) === "active";

// list_grants: what the person has delegated, read-only. There is deliberately no MCP tool that makes, changes or revokes a grant
// (a model with file or shell access is outside what grants protect against).
export async function handleDelegationTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  switch (name) {
    case "list_grants": {
      const now = new Date();
      const perAccount = await Promise.all(ctx.selectedBundles(args).map((bundle) => ctx.delegation.grants(bundle).list()));
      const grants = perAccount
        .flat()
        .filter((grant) => activeGrant(grant, now))
        .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt))
        .map((grant) => ({
          id: grant.id,
          account: grant.account,
          note: grant.note,
          tools: grant.tools,
          recipients: grant.recipients,
          remainingUses: grant.maxUses - grant.usedCount,
          maxUses: grant.maxUses,
          expiresAt: grant.expiresAt,
        }));
      const delegation = ctx.config.runtime.delegation ?? "off";
      return createTextResult({
        delegation,
        count: grants.length,
        grants,
        ...(delegation === "off" ? { note: "PROTONMAIL_DELEGATION is off on this server: grants are listed but not applied, so every send still needs the usual confirmation." } : {}),
      });
    }
    default:
      throw new Error(`handleDelegationTool: unexpected tool ${name}`);
  }
}
