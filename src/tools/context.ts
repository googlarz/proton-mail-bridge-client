// What a tool handler that lives outside createServer() needs from it: the configuration and the account helpers,
// which close over the account manager. A handler gets this as its third argument.

import type { AccountBundle, AccountManager } from "../services/account-manager.js";
import type { ProtonMailConfig } from "../types/index.js";

export interface ToolContext {
  config: ProtonMailConfig;
  accountManager: AccountManager;
  primaryBundle: AccountBundle;
  /** The account named by the `account` argument, or undefined when there is none. */
  resolveAccountArg(args: Record<string, unknown>): AccountBundle | undefined;
  /** The account an id belongs to (by its "<slug>::" prefix), and the id without the prefix. */
  resolveAccountForEmailId(emailId: string): { bundle: AccountBundle; rest: string };
  /** An id as a caller sees it: prefixed for every account but the primary. */
  prefixedIdFor(bundle: AccountBundle, rawId: string): string;
}
