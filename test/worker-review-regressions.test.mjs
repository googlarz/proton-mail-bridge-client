import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { DeliveryQueueService } from '../dist/services/delivery-queue-service.js';
import { SnoozeService } from '../dist/services/snooze-service.js';
import { fixture, quietLog, deferred } from './support/review-fixtures.mjs';
const past=new Date(0).toISOString();
const payload={to:['owner@example.com'],subject:'test',body:'test'};

for(const kind of ['send','snooze'])for(const killOwner of [false,true]) {
 test(`${kind}: recovery ${killOwner?'handles a dead owner without retrying':'preserves another process’s live claim'}`, {timeout:10000}, async t => {
  const config=await fixture(t);
  let calls=0;
  const service=kind==='send'?new DeliveryQueueService(config,{sendEmail:async()=>{calls++;}},quietLog):new SnoozeService(config,{createFolder:async()=>{},moveEmail:async()=>{calls++;return {targetEmailId:'Folders/MCP-Snoozed::1'};},withTimeout:p=>p},quietLog);
  const record=kind==='send'?await service.enqueue(payload,past,'scheduled_send'):await service.snooze('INBOX::1',past);
  calls=0;
  const child=fork(new URL('./support/claim-owner.mjs',import.meta.url),[],{silent:true});
  child.stdout.resume();child.stderr.resume();
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}});
  const entered=once(child,'message');child.send({type:'start',config,kind});
  assert.equal((await entered)[0].type,'entered');
  if(killOwner){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
  await service.checkDue();
  assert.equal(calls,0);
  let state=await service.get(record.id);
  if(killOwner){assert.equal(state.status,'failed');assert.match(state.failureReason,/unknown/);}
  else {
   assert.equal(state.status,kind==='send'?'sending':'waking');
   const done=once(child,'message');child.send({type:'finish'});assert.equal((await done)[0].type,'done');
   state=await service.get(record.id);assert.equal(state.status,kind==='send'?'sent':'woken');
  }
 });
}
test('concurrent cancels issue one wake move and distinguish the in-progress result', async t => {
 const config=await fixture(t), entered=deferred(), finish=deferred();let wakeCalls=0;
 const imap={createFolder:async()=>{},withTimeout:p=>p,moveEmail:async(_id,to)=>{if(to==='INBOX'){wakeCalls++;entered.resolve();await finish.promise;}return {targetEmailId:to+'::2'};}};
 const snooze=new SnoozeService(config,imap,quietLog);
 const record=await snooze.snooze('INBOX::1',past);
 const first=snooze.cancel(record.id);await entered.promise;
 const second=await snooze.cancel(record.id);
 assert.equal(second.status,'waking');assert.equal(wakeCalls,1);
 finish.resolve();assert.equal((await first).status,'canceled');
});
test('read-only and archive-disabled workers pause snoozes without consuming retries', async t => {
 const config=await fixture(t);let calls=0;
 const imap={createFolder:async()=>{},withTimeout:p=>p,moveEmail:async()=>{calls++;return {targetEmailId:'INBOX::2'};}};
 const snooze=new SnoozeService(config,imap,quietLog);const record=await snooze.snooze('INBOX::1',past);calls=0;
 for(const policy of [{readOnly:true},{readOnly:false,allowedActions:['mark_read']}]){
  Object.assign(config.runtime,policy);
  for(let i=0;i<6;i++)assert.deepEqual(await snooze.checkDue(),{woken:0,failed:0});
  const state=await snooze.get(record.id);
  assert.equal(state.status,'pending');assert.equal(state.failureCount,undefined);assert.match(state.pausedReason,/disabled/);
  await assert.rejects(snooze.cancel(record.id),/disabled/);
 }
 assert.equal(calls,0);config.runtime.allowedActions=['archive'];
 assert.deepEqual(await snooze.checkDue(),{woken:1,failed:0});assert.equal(calls,1);
 assert.equal((await snooze.get(record.id)).pausedReason,undefined);
});
