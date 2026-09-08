import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../dist/index.js';
import { fixture } from './support/review-fixtures.mjs';
import { ensureToolActionAllowed } from '../dist/utils/runtime-policy.js';

const deletionRoutes = [
  ['delete_email', { emailId: 'INBOX::1' }],
  ['batch_email_action', { emailIds: ['INBOX::1'], action: 'delete' }],
  ['apply_thread_action', { threadId: 'thread', action: 'delete' }],
  ['bulk_delete', { emailIds: ['INBOX::1'], permanent: true }],
  ['delete_thread', { messageId: 'message', permanent: true }],
  ['update_message_flags', { emailId: 'INBOX::1', flagsToAdd: ['\\Deleted'] }],
];
for (const [name, args] of deletionRoutes) {
  test(`${name} rejects unconfirmed deletion before any mailbox/index access`, async t => {
    const app = createServer(await fixture(t, { confirmDestructive: true }));
    let calls = 0;
    for (const key of ['deleteEmail', 'bulkDelete', 'deleteThread', 'updateMessageFlags', 'collectEmailsForIndex']) app.imapService[key] = async () => { calls++; };
    app.localIndexService.getThreadById = async () => { calls++; };
    const handler = app.server._requestHandlers.get('tools/call');
    await assert.rejects(handler({ method: 'tools/call', params: { name, arguments: args } }, {}), /Confirmation required/);
    assert.equal(calls, 0);
  });
}
test('confirmed batch deletion executes and dry run does not require confirmation', async t => {
  const config = await fixture(t, { confirmDestructive: true });
  const app = createServer(config);
  let calls = 0;
  app.imapService.deleteEmail = async () => { calls++; return { deleted: true }; };
  const handler = app.server._requestHandlers.get('tools/call');
  await handler({ method: 'tools/call', params: { name: 'batch_email_action', arguments: { emailIds: ['INBOX::1'], action: 'delete', confirmed: true } } }, {});
  assert.equal(calls, 1);
  assert.doesNotThrow(() => ensureToolActionAllowed(config.runtime, 'batch_email_action', { action: 'delete', dryRun: true }));
});
test('alternate tools cannot bypass the action allowlist', async t => {
  const config = await fixture(t, { allowedActions: ['mark_read'] });
  const app = createServer(config);
  const handler = app.server._requestHandlers.get('tools/call');
  for (const [name, args] of [
    ['move_email', { emailId: 'INBOX::1', targetFolder: 'Trash' }],
    ['bulk_move', {}], ['move_thread', {}], ['bulk_delete', { permanent: false }],
    ['bulk_delete', { permanent: 'true' }], ['delete_email', { confirmed: true }],
    ['update_message_flags', { flagsToAdd: ['\\Flagged'] }],
    ['bulk_update_flags', { flagsToRemove: ['\\Seen'] }],
    ['flag_thread', { flagsToAdd: ['\\Deleted'] }],
  ]) await assert.rejects(handler({ method: 'tools/call', params: { name, arguments: args } }, {}), /disabled/);
  assert.doesNotThrow(() => ensureToolActionAllowed(config.runtime, 'update_message_flags', { flagsToAdd: ['\\Seen'] }));
});

test('unsupported dryRun cannot bypass confirmation on flag updates or imports', async t => {
 const app=createServer(await fixture(t,{confirmDestructive:true}));
 const handler=app.server._requestHandlers.get('tools/call');
 for(const [name,args] of [
  ['update_message_flags',{emailId:'INBOX::1',flagsToAdd:['\\Deleted'],dryRun:true}],
  ['import_email',{flags:['\\Deleted'],dryRun:true}],
 ]) await assert.rejects(handler({method:'tools/call',params:{name,arguments:args}},{}),/Confirmation required/);
});
