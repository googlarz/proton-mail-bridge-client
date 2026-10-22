import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { isFileNotFound } from "../utils/corrupt-store.js";
import { normalizeBoolean, normalizeLimit } from "../utils/helpers.js";
import { buildProfile, styleHints, type SentSample, type StyleProfile } from "../utils/style-profile.js";
import { optionalString } from "./args.js";
import { maybeRefreshLocalIndex } from "./index-refresh.js";
import { createTextResult } from "./results.js";
import type { ToolContext } from "./context.js";
import type { ToolResult } from "./results.js";

// get_style_profile: how you write, from your own sent mail, as a few plain hints for drafting. Worked out on this
// machine, cached for a week in style-profile.json (patterns and counts only, no sentences, no names).

const MAX_AGE_MS = 7 * 86_400_000;

async function readCached(path: string): Promise<StyleProfile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as StyleProfile;
    return typeof parsed.generatedAt === "string" && parsed.overall ? parsed : undefined;
  } catch (error) {
    if (isFileNotFound(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
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
    const limit = normalizeLimit(args.limit, 60, 10, 150);
    await maybeRefreshLocalIndex(bundle.imapService, bundle.localIndexService, { force: false, folder: "INBOX", limitPerFolder: 100 });
    const found = await bundle.localIndexService.search({ folder: "Sent", limit });
    const samples: SentSample[] = [];
    for (const email of found.emails) {
      const detail = await bundle.imapService.getEmailById(email.id).catch(() => undefined);
      if (detail?.text && email.to.length > 0) samples.push({ to: email.to.flatMap((entry) => (entry.address ? [entry.address] : [])), text: detail.text });
    }
    profile = buildProfile(samples);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFileAtomic(path, JSON.stringify(profile, null, 2));
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
    ...(recipient ? { forRecipient: profile.byRecipient[recipient.toLowerCase()] ?? profile.byDomain[recipient.split("@")[1]?.toLowerCase() ?? ""] ?? null } : {}),
  });
}
