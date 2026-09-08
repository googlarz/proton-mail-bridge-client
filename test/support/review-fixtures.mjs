import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export const quietLog = { warn() {}, error() {}, info() {}, debug() {} };
export async function fixture(t, runtime = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'proton-regression-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return {
    dataDir, smtp: { username: 'owner@example.com' }, imap: { username: 'owner@example.com' },
    autoSync: false, cacheEnabled: true, syncInterval: 5,
    runtime: { readOnly: false, allowSend: true, allowedActions: ['mark_read','mark_unread','star','unstar','move','archive','trash','restore','delete'],
      confirmDestructive: false, restrictOutboundToSelf: false, opDelayMs: 0, ...runtime },
  };
}
export function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
