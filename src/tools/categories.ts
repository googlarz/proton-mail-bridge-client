import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { AccountBundle } from "../services/account-manager.js";
import {
  STARTER_CATEGORIES,
  authFailureOf,
  classifyMessage,
  protonClash,
  type CategoryDefinition,
  type CategoryVerdict,
  type LearnedWeight,
  type MessageSignals,
} from "../services/category-service.js";
import type { PlanItem } from "../services/triage-plan-service.js";
import type { EmailSummary } from "../types/index.js";
import { normalizeLimit } from "../utils/helpers.js";
import { ensureMailboxWriteAllowed } from "../utils/runtime-policy.js";
import { requireString } from "./args.js";
import { headerString } from "./compose.js";
import { maybeRefreshLocalIndex } from "./index-refresh.js";
import { createTextResult } from "./results.js";
import type { ToolContext } from "./context.js";
import type { ToolResult } from "./results.js";

// define_category / list_categories / categorize_inbox / correct_category: inbox categories the user defines, sorted by
// readable rules (see category-service.ts). Nothing here writes to the mailbox: categorize_inbox with dryRun false makes a
// triage plan of labels, which approve_plan applies (claimed once, under the runtime policy) and undo_plan takes back.

const NO_CATEGORIES = "No categories for this account yet. define_category makes one.";

interface CategoryState {
  categories: CategoryDefinition[];
  learned: LearnedWeight[];
}

interface Sorted {
  email: EmailSummary;
  verdict: CategoryVerdict;
}

const sameKey = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function inboxMessages(bundle: AccountBundle, limit: number): Promise<EmailSummary[]> {
  await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, { force: false, folder: "INBOX", limitPerFolder: 100 });
  return (await bundle.localIndexService.search({ folder: "INBOX", limit })).emails;
}

/** The verdict for each message, from the index; the authentication is read only where a verdict rests on the sender. */
async function sortMessages(bundle: AccountBundle, emails: EmailSummary[], state: CategoryState, contacts: Map<string, boolean>): Promise<Sorted[]> {
  const wantsContacts = state.categories.some((category) => category.knownContact);
  const sorted: Sorted[] = [];
  for (const email of emails) {
    const from = (email.from[0]?.address ?? "").trim().toLowerCase();
    if (wantsContacts && from && !contacts.has(from)) {
      contacts.set(from, (await bundle.localIndexService.search({ from: bundle.account.address, to: from, limit: 1 })).emails.length > 0);
    }
    const signals: MessageSignals = { from, replyTo: email.replyTo[0]?.address, subject: email.subject, automated: email.isAutomated, knownContact: contacts.get(from) };
    let verdict = classifyMessage(state.categories, state.learned, signals);
    if (verdict.senderBased) {
      try {
        const detail = await bundle.imapService.getEmailById(email.id);
        const authFailure = authFailureOf(headerString(detail.headers, "authentication-results"));
        if (authFailure) verdict = classifyMessage(state.categories, state.learned, { ...signals, authFailure });
      } catch {
        verdict = { ...verdict, reasons: [...verdict.reasons, "the sender's authentication could not be checked"] };
      }
    }
    sorted.push({ email, verdict });
  }
  return sorted;
}

function counts(sorted: Sorted[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { verdict } of sorted) {
    const name = verdict.category ?? "(none)";
    out[name] = (out[name] ?? 0) + 1;
  }
  return out;
}

function showCategory(category: CategoryDefinition, learned: LearnedWeight[]) {
  const clash = protonClash(category);
  const { createdAt: _created, updatedAt: _updated, ...shown } = category;
  return { ...shown, learnedSenders: learned.filter((entry) => sameKey(entry.category, category.name)).length, ...(clash ? { protonClash: clash } : {}) };
}

export async function handleCategoryTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { resolveAccountArg, primaryBundle, prefixedIdFor, resolveAccountForEmailId } = ctx;
  const present = (bundle: AccountBundle, { email, verdict }: Sorted) => ({
    emailId: prefixedIdFor(bundle, email.id),
    from: email.from[0]?.address ?? "",
    subject: email.subject,
    category: verdict.category,
    reasons: verdict.reasons,
    ...(verdict.runnerUp ? { runnerUp: verdict.runnerUp } : {}),
  });

  switch (name) {
    case "define_category": {
      const bundle = resolveAccountArg(args) ?? primaryBundle;
      const store = bundle.categoryService;
      const modes = [args.name !== undefined, args.starter === true, args.copyFrom !== undefined].filter(Boolean).length;
      if (modes !== 1) throw new McpError(ErrorCode.InvalidParams, "Give one of: name (define or change one category), starter: true (add the starter set) or copyFrom (copy another account's categories).");
      if (args.starter === true || args.copyFrom !== undefined) {
        let source: AccountBundle | undefined;
        if (args.copyFrom !== undefined) {
          source = resolveAccountArg({ account: args.copyFrom });
          if (!source || source === bundle) throw new McpError(ErrorCode.InvalidParams, "copyFrom must name another account than the one the categories go to.");
        }
        const drafts = source ? (await source.categoryService.list()).categories : STARTER_CATEGORIES;
        const { added, skipped } = await store.addAll(drafts);
        const { categories } = await store.list();
        const clashes = categories.filter((category) => added.includes(category.name)).flatMap((category) => {
          const note = protonClash(category);
          return note ? [{ category: category.name, note }] : [];
        });
        return createTextResult({
          account: bundle.account.address,
          added,
          ...(skipped.length ? { skipped, skippedNote: "A category with that name already exists here (or the limit is reached); it was left as it is." } : {}),
          ...(source ? { copiedFrom: source.account.address, corrections: "Not copied: corrections belong to the senders of each account's own mail." } : {}),
          ...(clashes.length ? { protonClash: clashes } : {}),
          next: "categorize_inbox shows where the INBOX mail would go. Nothing in the mailbox has changed.",
        });
      }
      const { category, created } = await store.define({
        name: args.name,
        description: args.description,
        senders: args.senders,
        keywords: args.keywords,
        automated: args.automated,
        knownContact: args.knownContact,
        label: args.label,
      });
      const { learned } = await store.list();
      const signalless = !category.senders && !category.keywords && category.automated === undefined && !category.knownContact;
      return createTextResult({
        account: bundle.account.address,
        created,
        category: showCategory(category, learned),
        ...(signalless ? { note: "This category has no signals yet: only mail you assign with correct_category goes in it." } : {}),
        ...(!category.label ? { label: "No label: categorize_inbox shows this category, but applying it changes nothing until a label is set." } : {}),
      });
    }

    case "list_categories": {
      const bundle = resolveAccountArg(args) ?? primaryBundle;
      const { categories, learned } = await bundle.categoryService.list();
      const display = (key: string) => categories.find((category) => sameKey(category.name, key))?.name ?? key;
      return createTextResult({
        account: bundle.account.address,
        categories: categories.map((category) => showCategory(category, learned)),
        corrections: learned.slice(-50).reverse().map((entry) => ({ sender: entry.sender, category: display(entry.category), weight: entry.weight })),
        note: categories.length ? "Descriptions are the user's own words, shown as written; sorting never reads them." : NO_CATEGORIES,
      });
    }

    case "categorize_inbox": {
      const bundle = resolveAccountArg(args) ?? primaryBundle;
      const limit = normalizeLimit(args.limit, 30, 1, 100);
      const dryRun = args.dryRun !== false;
      const state = await bundle.categoryService.list();
      if (state.categories.length === 0) return createTextResult({ account: bundle.account.address, messages: [], note: NO_CATEGORIES });
      const sorted = await sortMessages(bundle, await inboxMessages(bundle, limit), state, new Map());
      if (dryRun) {
        return createTextResult({
          account: bundle.account.address,
          dryRun: true,
          counts: counts(sorted),
          messages: sorted.map((entry) => present(bundle, entry)),
          next: "Nothing has changed. With dryRun false this makes a plan that adds each category's label; approve_plan applies it and undo_plan takes it back.",
        });
      }

      // The label folders as Bridge names them, so a plan targets the real one.
      const labelFolders = new Map(
        (await bundle.imapService.getFolders())
          .filter((folder) => folder.path.startsWith("Labels/"))
          .map((folder) => [folder.path.slice("Labels/".length).toLowerCase(), folder.path.slice("Labels/".length)]),
      );
      const noLabel = new Set<string>();
      const missingLabel = new Set<string>();
      let alreadyLabelled = 0;
      let unavailable = 0;
      const items: Array<Omit<PlanItem, "n">> = [];
      for (const { email, verdict } of sorted) {
        if (!verdict.category) continue;
        const wanted = state.categories.find((category) => category.name === verdict.category)?.label;
        if (!wanted) {
          noLabel.add(verdict.category);
          continue;
        }
        const label = labelFolders.get(wanted.toLowerCase());
        if (!label) {
          missingLabel.add(wanted);
          continue;
        }
        let detail: Awaited<ReturnType<typeof bundle.imapService.getEmailById>>;
        try {
          detail = await bundle.imapService.getEmailById(email.id);
        } catch {
          unavailable += 1;
          continue;
        }
        // Mail that already carries the label is left out, so undo never takes off a label it did not add.
        if (detail.labels.some((carried) => sameKey(carried, `Labels/${label}`) || sameKey(carried, label))) {
          alreadyLabelled += 1;
          continue;
        }
        items.push({
          emailId: detail.id,
          from: detail.from[0]?.address ?? "",
          subject: detail.subject,
          action: "label",
          target: label,
          reason: `category ${verdict.category}: ${verdict.reasons.join("; ")}`.slice(0, 300),
          source: "category",
          wasRead: detail.isRead,
          hadLabel: false,
        });
      }
      const skippedNotes = {
        ...(noLabel.size ? { withoutLabel: [...noLabel], withoutLabelNote: "These categories have no label, so applying them changes nothing; define_category with label sets one." } : {}),
        ...(missingLabel.size ? { missingLabels: [...missingLabel], missingLabelsNote: "These labels do not exist yet; create them with create_label, then run this again." } : {}),
        ...(alreadyLabelled ? { alreadyLabelled } : {}),
        ...(unavailable ? { unavailable, unavailableNote: "Messages that could not be read from the server (moved or deleted since the index was refreshed) are left out." } : {}),
      };
      if (items.length === 0) return createTextResult({ account: bundle.account.address, plan: null, counts: counts(sorted), ...skippedNotes, note: "Nothing to label." });
      const plan = await bundle.triagePlanService.create(items);
      let notAllowed: string | undefined;
      try {
        ensureMailboxWriteAllowed(bundle.config.runtime);
      } catch (error) {
        notAllowed = error instanceof Error ? error.message : String(error);
      }
      return createTextResult({
        account: bundle.account.address,
        planId: plan.id,
        items: plan.items.map((item) => ({ n: item.n, emailId: prefixedIdFor(bundle, item.emailId), from: item.from, subject: item.subject, do: `label ${item.target}`, reason: item.reason })),
        counts: counts(sorted),
        ...skippedNotes,
        ...(notAllowed ? { notAllowedNow: notAllowed } : {}),
        next: "Show the list to the user. approve_plan applies all of it, or only the numbers in `items`, or everything except `exclude`; undo_plan takes it back. Nothing has changed yet.",
      });
    }

    case "correct_category": {
      const emailId = requireString(args, "emailId");
      const wanted = requireString(args, "category");
      const named = resolveAccountArg(args);
      const resolved = resolveAccountForEmailId(emailId);
      if (named && named !== resolved.bundle) throw new McpError(ErrorCode.InvalidParams, `${emailId} belongs to another account than ${named.account.address}.`);
      const bundle = resolved.bundle;
      const store = bundle.categoryService;
      const category = await store.find(wanted);
      if (!category) {
        const known = (await store.list()).categories.map((entry) => entry.name);
        throw new McpError(ErrorCode.InvalidParams, `No category "${wanted}" on ${bundle.account.address}.${known.length ? ` Defined: ${known.join(", ")}.` : ` ${NO_CATEGORIES}`}`);
      }
      const detail = await bundle.imapService.getEmailById(resolved.rest);
      const sender = (detail.from[0]?.address ?? "").trim().toLowerCase();
      if (!sender) throw new McpError(ErrorCode.InvalidParams, `${emailId} has no sender address to learn from.`);

      const emails = await inboxMessages(bundle, normalizeLimit(args.limit, 30, 1, 100));
      const contacts = new Map<string, boolean>();
      const before = await sortMessages(bundle, emails, await store.list(), contacts);
      const weights = await store.learn(sender, category.name);
      const learnedState = await store.list();
      const after = await sortMessages(bundle, emails, learnedState, contacts);
      const was = new Map(before.map((entry) => [entry.email.id, entry.verdict.category]));
      // The corrected message itself, also when it is not among the INBOX mail looked at.
      const own =
        after.find((entry) => entry.email.id === detail.id)?.verdict ??
        classifyMessage(learnedState.categories, learnedState.learned, {
          from: sender,
          replyTo: detail.replyTo[0]?.address,
          subject: detail.subject,
          automated: detail.isAutomated,
          authFailure: authFailureOf(headerString(detail.headers, "authentication-results")),
        });
      const changed = after.filter((entry) => entry.email.id !== detail.id && was.get(entry.email.id) !== entry.verdict.category);
      const display = (key: string) => learnedState.categories.find((entry) => sameKey(entry.name, key))?.name ?? key;
      return createTextResult({
        account: bundle.account.address,
        emailId: prefixedIdFor(bundle, detail.id),
        learned: { sender, weights: weights.map((entry) => ({ category: display(entry.category), weight: entry.weight })) },
        thisMessage: { category: own.category, reasons: own.reasons },
        alsoChanges: changed.slice(0, 50).map((entry) => ({ ...present(bundle, entry), before: was.get(entry.email.id) ?? null })),
        note: "Only this server's categories learned something; the mailbox is unchanged. categorize_inbox with dryRun false makes a plan to apply the labels.",
      });
    }
  }
  throw new McpError(ErrorCode.MethodNotFound, `Unknown category tool: ${name}`);
}
