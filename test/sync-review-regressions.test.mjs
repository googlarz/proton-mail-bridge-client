import test from 'node:test';
import assert from 'node:assert/strict';
import { SimpleIMAPService, planFolderSync } from '../dist/services/simple-imap-service.js';
import { LocalIndexService } from '../dist/services/local-index-service.js';
import { fixture, quietLog } from './support/review-fixtures.mjs';
const plan = (checkpoint, extra={}) => planFolderSync({folder:'INBOX',exists:100000,uidNext:100001,uidValidity:'1',limit:50,full:false,checkpoint,...extra});

test('large incremental backlogs progress in bounded batches, including limit one', () => {
 for (const limit of [1,50,500]) {
  let high=1000;
  while(high<1200) {
   const batch=plan({highestUid:high,uidValidity:'1'}, {uidNext:1201,limit});
   assert.ok(batch.endUid-batch.startUid+1<=limit);
   assert.ok(batch.startUid<=high+1, 'must not skip UIDs');
   assert.ok(batch.checkpointHighestUid>high, 'must make forward progress');
   high=batch.checkpointHighestUid;
  }
  assert.equal(high,1200);
 }
});
test('full sync refreshes new mail during and after backfill within the total budget', () => {
 for(const floor of [500,1]) {
  const p=plan({highestUid:1000,backfilledToUid:floor,uidValidity:'1'},{full:true,uidNext:1002});
  const ranges=[p,...(p.refreshRange?[p.refreshRange]:[])];
  assert.ok(ranges.some(r=>r.startUid<=1001 && r.endUid>=1001));
  assert.ok(ranges.reduce((n,r)=>n+r.endUid-r.startUid+1,0)<=50);
  assert.equal(p.checkpointHighestUid,1001);
 }
});

test('full cycles update old flags and expunges and discover new mail after completed backfill', async t => {
 const config=await fixture(t);
 const imap=new SimpleIMAPService(config,quietLog);
 const index=new LocalIndexService(config,quietLog);
 const folder={path:'INBOX',name:'INBOX',delimiter:'/',flags:[],listed:true,subscribed:true};
 const live=new Map(Array.from({length:6},(_,i)=>[i+1,{uid:i+1,seq:i+1,envelope:{subject:'message '+(i+1)},flags:new Set(),size:40}]));
 const client={mailbox:{uidNext:7,uidValidity:1n,exists:6},async *fetch(range,query){const [lo,hi]=range.split(':').map(Number);for(const [uid,msg] of live)if(uid>=lo&&uid<=hi)yield {...msg,...(query.source?{source:Buffer.from("Subject: message\r\n\r\nuniqueneedle")}: {})};},async fetchOne(uid){return {uid:Number(uid),source:Buffer.from('Subject: message\r\n\r\nuniqueneedle')};}};
 imap.withMailbox=async(_folder,_readOnly,fn)=>fn(client);
 async function cycle() {
  const batch=await imap.collectFolderForIndex('INBOX',{full:true,limit:3,includeAttachmentText:true,checkpoint:(await index.getSyncCheckpointMap()).INBOX,syncedAt:new Date().toISOString()});
  assert.ok(batch.emails.length<=3);
  await index.recordSnapshot({folders:[folder],emails:batch.emails,folderStats:[batch.checkpoint],syncedAt:new Date().toISOString()});
 }
 await cycle();await cycle();
 assert.equal((await index.getStatus()).storedMessageCount,6);
 live.delete(1);live.get(2).flags.add('\\Seen');live.set(7,{uid:7,seq:6,envelope:{subject:'new mail'},flags:new Set(),size:40});client.mailbox.uidNext=8;
 for(let i=0;i<4;i++)await cycle();
 const results=(await index.search({limit:100})).emails;
 assert.ok(results.some(e=>e.uid===7));
 assert.ok(!results.some(e=>e.uid===1));
 assert.equal(results.find(e=>e.uid===2).isRead,true);
 assert.equal((await index.search({query:'uniqueneedle'})).emails.length,6);
});

test('source indexing is bounded per message and per folder', async t => {
 const imap=new SimpleIMAPService(await fixture(t),quietLog);
 let requested=0;
 const client={mailbox:{uidNext:51,uidValidity:1n,exists:50},async *fetch(_range,query){
  assert.ok(query.source.maxLength<=1024*1024);
  for(let uid=1;uid<=50;uid++) {
   requested+=query.source.maxLength;
   yield {uid,seq:uid,envelope:{subject:'large'},size:100*1024*1024,source:Buffer.alloc(query.source.maxLength,32)};
  }
 }};
 imap.withMailbox=async(_folder,_readOnly,fn)=>fn(client);
 const result=await imap.collectFolderForIndex('INBOX',{full:false,limit:50,includeAttachmentText:false,syncedAt:new Date().toISOString()});
 assert.equal(result.emails.length,50);
 assert.ok(requested<=16*1024*1024);
 assert.equal(result.checkpoint.highestUid,50);
});

test('full sync discovers the first message after an empty-mailbox checkpoint', () => {
 const p=plan({highestUid:0,uidValidity:'1',total:0},{full:true,exists:1,uidNext:2});
 assert.equal(p.startUid,1);
 assert.equal(p.endUid,1);
 assert.equal(p.checkpointHighestUid,1);
});
