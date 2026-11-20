import type { AccountBundle } from "../services/account-manager.js";
import { isReversible, type JournalItem, type UndoJournal, type UndoTool } from "../services/undo-journal-service.js";
import type { BulkOperationResult, UndoSummary } from "../types/index.js";
import { createEmailId } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";
import { ensureEmailActionAllowed, ensureFlagChangeAllowed, ensureMailboxWriteAllowed } from "../utils/runtime-policy.js";
import { ensureMoveTargetAllowed } from "./actions.js";

// Undo for bulk operations (bulk_move, bulk_update_flags, bulk_delete with permanent:true, apply_rules). Before the operation
// runs, what it will touch is written to the account's undo journal; when it has run, what actually happened to each message
// is added. undo_plan with the undoId then puts back only that, under the current runtime policy. A message that was moved
// has a new UID, so the journal keeps the new id and, as a fallback, the Message-ID header to search for.

const lower = (value: string) => value.toLowerCase();

export function summarize(bundle: AccountBundle, journal: UndoJournal): UndoSummary {
  const reversible = journal.items.filter(isReversible).length;
  const irreversible = journal.irreversible ? journal.items.filter((item) => item.ok).length : journal.items.filter((item) => item.irreversible?.length).length;
  const notes: string[] = [];
  if (journal.irreversible) notes.push(`${journal.irreversible}: this cannot be undone`);
  else if (irreversible > 0) notes.push(`${irreversible} message(s) also had a change that cannot be put back (a forward, a permanent delete)`);
  if (!journal.irreversible && reversible > 0) notes.push(`undo_plan with undoId ${journal.id} puts the rest back`);
  return { undoId: journal.id, expiresAt: bundle.undoJournalService.expiresAt(journal), reversible, irreversible, ...(notes.length ? { note: notes.join("; ") } : {}) };
}

export interface BulkJournalParams {
  tool: Extract<UndoTool, "bulk_move" | "bulk_update_flags" | "bulk_delete">;
  folder: string;
  uids: number[];
  uidValidity?: string;
  targetFolder?: string;
  flagsToAdd?: string[];
  flagsToRemove?: string[];
}

/**
 * Runs a real bulk operation with undo data: the messages are read and the journal is stored first (if that fails nothing has
 * been changed), then `run` happens, then each message's outcome is written down. The result carries `undo`.
 */
export async function runWithUndo(bundle: AccountBundle, params: BulkJournalParams, run: () => Promise<BulkOperationResult>): Promise<BulkOperationResult> {
  if (params.uids.length === 0) return run();
  const { folder, uidValidity } = params;
  const permanent = params.tool === "bulk_delete";
  const snapshot = permanent ? undefined : await bundle.imapService.snapshotMessages(folder, params.uids, uidValidity);
  // A UID the server does not know is not journaled: the operation reports it as failed.
  const journaled = params.uids
    .filter((uid) => !snapshot || snapshot.has(uid))
    .map((uid) => ({ uid, item: { emailId: createEmailId(folder, uid, uidValidity), folder, ...(snapshot ? { messageId: snapshot.get(uid)?.messageId, flagsBefore: snapshot.get(uid)?.flags } : {}) } as JournalItem }));
  const journal = await bundle.undoJournalService.begin(params.tool, journaled.map((entry) => entry.item), permanent ? "permanently deleted, not even Trash holds a copy" : undefined);

  const result = await run();

  // The operation has happened: a failure to write its outcome must not turn it into an error (the caller would retry it).
  try {
    const byUid = new Map(result.results.map((entry) => [entry.uid, entry]));
    const outcomes = journaled.map(({ uid, item }): JournalItem => {
      const entry = byUid.get(uid);
      if (!entry) return { ...item, ok: false, error: "no outcome reported" };
      if (!entry.ok) return { ...item, ok: false, error: entry.error };
      if (permanent) return { ...item, ok: true };
      if (params.tool === "bulk_move") return { ...item, ok: true, movedTo: { folder: params.targetFolder as string, ...(entry.targetEmailId ? { emailId: entry.targetEmailId } : {}) } };
      const before = new Set((item.flagsBefore ?? []).map(lower));
      const notApplied = new Set((entry.notApplied ?? []).map(lower));
      return {
        ...item,
        ok: true,
        flagsAdded: (params.flagsToAdd ?? []).filter((flag) => !before.has(lower(flag)) && !notApplied.has(lower(flag))),
        flagsRemoved: (params.flagsToRemove ?? []).filter((flag) => before.has(lower(flag)) && !notApplied.has(lower(flag))),
      };
    });
    return { ...result, undo: summarize(bundle, await bundle.undoJournalService.complete(journal.id, outcomes)) };
  } catch (error) {
    logger.error("Could not write the undo outcome", "UndoJournal", { tool: params.tool, undoId: journal.id, error });
    return result;
  }
}

/** What a response says about undo: one journal as `undoId`, several (one per account) as a list. */
export function undoResponse(summaries: UndoSummary[]): Record<string, unknown> {
  if (summaries.length === 0) return {};
  if (summaries.length === 1) {
    const [only] = summaries;
    return { undoId: only.undoId, undoExpiresAt: only.expiresAt, ...(only.note ? { undoNote: only.note } : {}) };
  }
  return { undo: summaries };
}

// Moves a message back from where the operation put it. The new id the server gave is tried first; if that no longer works
// (the message moved again, or the folder was rebuilt), the Message-ID is searched for in that folder, and only a single
// match is acted on.
async function moveBack(bundle: AccountBundle, item: JournalItem): Promise<string | undefined> {
  const imap = bundle.imapService;
  const from = item.movedTo?.folder as string;
  if (item.movedTo?.emailId) {
    try {
      return (await imap.moveEmail(item.movedTo.emailId, item.folder)).targetEmailId;
    } catch (error) {
      if (!item.messageId) throw error;
    }
  }
  if (!item.messageId) throw new Error("no new id and no Message-ID were recorded, so the message cannot be found again");
  const uids = await imap.findUidsByMessageId(from, item.messageId);
  if (uids.length === 0) throw new Error(`the message is no longer in ${from}`);
  if (uids.length > 1) throw new Error(`${uids.length} messages in ${from} carry the same Message-ID, so the right one cannot be told apart`);
  const found = createEmailId(from, uids[0], await imap.getMailboxUidValidity(from));
  return (await imap.moveEmail(found, item.folder)).targetEmailId;
}

// Puts one message back, step by step. `work` is updated as each step succeeds, so a retry continues where this one stopped.
async function undoItem(bundle: AccountBundle, work: JournalItem, confirmed: boolean): Promise<void> {
  const runtime = bundle.config.runtime;
  const imap = bundle.imapService;
  if (work.movedTo) {
    ensureEmailActionAllowed(runtime, "move");
    await ensureMoveTargetAllowed(runtime, imap, work.folder);
    const restored = await moveBack(bundle, work);
    delete work.movedTo;
    if (restored) work.emailId = restored;
    else if (work.flagsAdded?.length || work.flagsRemoved?.length || work.labelsAdded?.length) {
      const uids = work.messageId ? await imap.findUidsByMessageId(work.folder, work.messageId) : [];
      if (uids.length !== 1) throw new Error("the message was moved back, but its new id could not be found, so its flags and labels were left as they are");
      work.emailId = createEmailId(work.folder, uids[0], await imap.getMailboxUidValidity(work.folder));
    }
  }
  const restoreFlags = work.flagsRemoved ?? [];
  const clearFlags = work.flagsAdded ?? [];
  if (restoreFlags.length || clearFlags.length) {
    ensureFlagChangeAllowed(runtime, restoreFlags, clearFlags, confirmed);
    const outcome = await imap.updateMessageFlags(work.emailId, restoreFlags, clearFlags);
    if (outcome.notApplied.length) throw new Error(`the server did not change: ${outcome.notApplied.join(", ")}`);
    delete work.flagsAdded;
    delete work.flagsRemoved;
  }
  if (work.labelsAdded?.length) {
    ensureMailboxWriteAllowed(runtime);
    const outcome = await imap.updateMessageLabels(work.emailId, [], work.labelsAdded);
    if (outcome.notFound.length) {
      work.labelsAdded = outcome.notFound;
      throw new Error(`could not take the label off: ${outcome.notFound.join(", ")}`);
    }
    delete work.labelsAdded;
  }
}

export interface UndoOutcome {
  undoId: string;
  tool: UndoTool;
  undone: number;
  failed: Array<{ emailId: string; error: string }>;
  /** Messages whose operation failed in the first place (nothing to put back). */
  notDone: number;
  /** Messages that also had a change that cannot be put back. */
  irreversible: number;
  status: UndoJournal["status"];
}

export async function undoJournal(bundle: AccountBundle, undoId: string, confirmed: boolean): Promise<UndoOutcome> {
  const service = bundle.undoJournalService;
  const journal = await service.beginUndo(undoId);
  const items: JournalItem[] = [];
  let undone = 0;
  const failed: UndoOutcome["failed"] = [];
  for (const item of journal.items) {
    if (!isReversible(item)) {
      items.push(item);
      continue;
    }
    const work: JournalItem = { ...item };
    try {
      await undoItem(bundle, work, confirmed);
      items.push({ ...work, undone: true, undoError: undefined });
      undone += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      items.push({ ...work, undoError: message });
      failed.push({ emailId: item.emailId, error: message });
    }
  }
  const saved = await service.finishUndo(undoId, items);
  return {
    undoId,
    tool: journal.tool,
    undone,
    failed,
    notDone: items.filter((item) => item.ok === false).length,
    irreversible: items.filter((item) => item.irreversible?.length).length,
    status: saved.status,
  };
}
