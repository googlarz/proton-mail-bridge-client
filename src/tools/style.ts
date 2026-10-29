import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { isFileNotFound } from "../utils/corrupt-store.js";
import { normalizeBoolean, normalizeLimit } from "../utils/helpers.js";
import { buildProfile, recipientKey, styleHints, type SentSample, type StyleProfile } from "../utils/style-profile.js";
import { optionalString } from "./args.js";
import { maybeRefreshLocalIndex } from "./index-refresh.js";
import { createTextResult } from "./results.js";
import type { ToolContext } from "./context.js";
import type { ToolResult } from "./results.js";

// get_style_profile: how you write, from your own sent mail, as a few plain hints for drafting. Worked out on this
// machine, cached for a week in style-profile.json (patterns and counts only, no sentences, no names).

const MAX_AGE_MS = 7 * 86_400_000;
const FETCH_BATCH = 6;

async function readCached(path: string): Promise<StyleProfile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as StyleProfile;
    return typeof parsed.generatedAt === "string" && parsed.overall ? parsed : undefined;
  } catch (error) {
    if (isFileNotFound(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

// A profile being built, per file: reading sent mail from Bridge can take longer than a client waits for one answer, so
// the build continues in the background and the next call picks up the result.
const building = new Map<string, Promise<StyleProfile>>();
const DEFAULT_WAIT_SECONDS = 25;

async function buildAndStore(bundle: ToolContext["primaryBundle"], path: string, limit: number): Promise<StyleProfile> {
  await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, { force: false, folder: "INBOX", limitPerFolder: 100 });
  const found = await bundle.localIndexService.search({ folder: "Sent", limit });
  const samples: SentSample[] = [];
  for (let start = 0; start < found.emails.length; start += FETCH_BATCH) {
    const batch = found.emails.slice(start, start + FETCH_BATCH);
    const details = await Promise.all(batch.map((email) => bundle.imapService.getEmailById(email.id).catch(() => undefined)));
    details.forEach((detail, index) => {
      const email = batch[index];
      if (detail?.text && email.to.length > 0) samples.push({ to: email.to.flatMap((entry) => (entry.address ? [entry.address] : [])), text: detail.text });
    });
  }
  const profile = buildProfile(samples);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, JSON.stringify(profile, null, 2));
  return profile;
}

export async function handleStyleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (name !== "get_style_profile") throw new Error(`Unknown style tool: ${name}`);
  const bundle = ctx.resolveAccountArg(args) ?? ctx.primaryBundle;
  const path = join(bundle.account.dataDir, "style-profile.json");
  const recipient = optionalString(args, "recipient");
  let profile = normalizeBoolean(args.refresh, false) ? undefined : await readCached(path);
  if (profile && Date.now() - Date.parse(profile.generatedAt) > MAX_AGE_MS) profile = undefined;
  let rebuilt = false;
  if (!profile) {
    const waitSeconds = normalizeLimit(args.waitSeconds, DEFAULT_WAIT_SECONDS, 1, 280);
    let job = building.get(path);
    if (!job) {
      job = buildAndStore(bundle, path, normalizeLimit(args.limit, 40, 10, 150)).finally(() => building.delete(path));
      building.set(path, job);
      job.catch(() => undefined);
    }
    let timer: NodeJS.Timeout | undefined;
    const ready = await Promise.race([
      job,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), waitSeconds * 1000);
        timer.unref();
      }),
    ]).finally(() => clearTimeout(timer));
    if (!ready) {
      return createTextResult({
        account: bundle.account.address,
        building: true,
        note: "Still reading sent mail to learn the style; this runs in the background. Ask again in a minute.",
      });
    }
    profile = ready;
    rebuilt = true;
  }
  const hints = styleHints(profile, recipient);
  return createTextResult({
    account: bundle.account.address,
    basedOn: profile.overall.messages,
    generatedAt: profile.generatedAt,
    rebuilt,
    hints: hints.length ? hints : ["Not enough sent mail to tell yet."],
    overall: profile.overall,
    ...(recipient ? { forRecipient: profile.byRecipient[recipientKey(recipient)] ?? profile.byDomain[recipient.split("@")[1]?.toLowerCase() ?? ""] ?? null } : {}),
  });
}
