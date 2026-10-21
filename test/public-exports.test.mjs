import test from "node:test";
import assert from "node:assert/strict";
import * as server from "../dist/index.js";

// Other code and the tests import these from the package entry point. Where a function lives is an internal matter
// (src/tools/*.ts, src/config-env.ts); this list is what must stay reachable from index.js.
const PUBLIC = [
  "CORE_TOOL_NAMES",
  "MissingCredentialsError",
  "NOT_CONFIGURED_MESSAGE",
  "THREAD_LIST_RESPONSE_BUDGET_CHARS",
  "buildConfigFromEnv",
  "buildForwardHtml",
  "buildForwardText",
  "buildReplyHtml",
  "buildReplyText",
  "buildSecurityInfo",
  "createServer",
  "createUnconfiguredServer",
  "ensureBulkBatchSize",
  "extractUnsubscribeInfo",
  "formatQuoteDate",
  "getBulkMaxBatchSize",
  "getBulkNotFoundEmailIds",
  "getReplyRecipients",
  "groupEmailIdsByAccount",
  "headerString",
  "ignoredArguments",
  "isNoopDraftPatch",
  "isRecoverableConnectionError",
  "mailboxChangedSinceCheckpoint",
  "main",
  "mergeBulkResults",
  "optionalClearableString",
  "paginateMergedAccountResults",
  "parseAuthenticationResults",
  "parseUnsubscribeMailto",
  "prefixBulkResult",
  "prefixNotFound",
  "redactDraftAttachmentsForListing",
  "redactQueueRecordAttachments",
  "stopAllAccounts",
  "stripUnshippableImages",
  "tagAccountIds",
  "trimThreadsToBudget",
  "truncateDraftBodyForResponse",
  "withAudit",
  "withBulkNotFound",
  "withSources",
  "writeAttachmentToDownloadDir",
];

test("the entry point still exports everything that was part of it", () => {
  const missing = PUBLIC.filter((name) => !(name in server));
  assert.deepEqual(missing, []);
});
