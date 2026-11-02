import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RulesService } from "../dist/services/rules-service.js";
import { runRulesOnNewMail } from "../dist/tools/rules-runner.js";

// A forward is claimed in the store before it is sent. If the claim itself fails (e.g. the store could not be
// replaced), nothing was sent and the message must stay unhandled so the next run retries it. A claim that
// succeeded followed by a failed send is not retried: at most once.

const ADDRESS = "owner@example.com";

function mail(n) {
  const at = new Date(Date.now() + 60_000).toISOString();
  return {
    id: `INBOX::1::${n}`, folder: "INBOX", uid: n, seq: n, messageId: `<m${n}@x>`, subject: "Hello", references: [],
    from: [{ address: "alice@example.com", name: "Alice" }], to: [{ address: ADDRESS }], cc: [], bcc: [], replyTo: [],
    date: at, internalDate: at, isRead: false, isStarred: false, flags: [], hasAttachments: false, attachments: [], labels: [], isAutomated: false,
  };
}

async function withBundle(fn) {
  const dir = await mkdtemp(join(tmpdir(), "rules-runner-"));
  const rulesService = new RulesService({ dataDir: dir });
  const sent = [];
  const bundle = {
    rulesService,
    ownAddresses: [ADDRESS],
    config: {
      smtp: { username: ADDRESS },
      runtime: { readOnly: false, allowSend: true, allowedActions: ["archive", "mark_read"], restrictOutboundToSelf: false },
    },
    imapService: {
      getEmailById: async (id) => ({ ...mail(1), id, text: "body", preview: "body" }),
      getAttachmentForForward: async () => ({}),
    },
    smtpService: { sendEmail: async (input) => { sent.push(input.to); return { messageId: "<r@x>", accepted: input.to, rejected: [], response: "250" }; } },
    auditService: { record: async () => {} },
    eventLog: { emit: () => {} },
  };
  try {
    await rulesService.set({ name: "fwd", enabled: true, when: { from: ["alice@example.com"] }, actions: { forwardTo: ["backup@example.com"] } });
    await fn(bundle, sent);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("a failed claim leaves the message unhandled, the next run forwards it once", async () => {
  await withBundle(async (bundle, sent) => {
    const claim = bundle.rulesService.claimForward.bind(bundle.rulesService);
    let calls = 0;
    bundle.rulesService.claimForward = async (...args) => {
      calls += 1;
      if (calls === 1) throw new Error("EPERM: operation not permitted, rename");
      return claim(...args);
    };
    const emails = [mail(1)];
    const first = await runRulesOnNewMail(bundle, emails);
    assert.equal(first.failed, 1);
    assert.equal(sent.length, 0);
    const second = await runRulesOnNewMail(bundle, emails);
    assert.equal(second.failed, 0);
    assert.equal(sent.length, 1);
    assert.equal(await runRulesOnNewMail(bundle, emails), undefined, "handled now: no third forward");
    assert.equal(sent.length, 1);
  });
});

test("a claimed forward whose send fails is not retried", async () => {
  await withBundle(async (bundle, sent) => {
    let fail = true;
    bundle.smtpService.sendEmail = async (input) => {
      if (fail) throw new Error("smtp down");
      sent.push(input.to);
      return { messageId: "<r@x>", accepted: input.to, rejected: [], response: "250" };
    };
    const emails = [mail(1)];
    const first = await runRulesOnNewMail(bundle, emails);
    assert.equal(first.failed, 1);
    fail = false;
    assert.equal(await runRulesOnNewMail(bundle, emails), undefined);
    assert.equal(sent.length, 0);
  });
});
