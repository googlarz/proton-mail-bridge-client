import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalIndexService } from '../dist/services/local-index-service.js';
import { fixture, quietLog } from './support/review-fixtures.mjs';
const email = { id:'INBOX::1',folder:'INBOX',uid:1,seq:1,subject:'Ordinary',from:[],to:[],cc:[],bcc:[],replyTo:[],isRead:false,isStarred:false,flags:[],hasAttachments:false,attachments:[],labels:[],preview:'uniqueneedle' };
const snapshot = (emails, extra={}) => ({ syncedAt:new Date().toISOString(),folders:[{path:'INBOX',name:'INBOX',delimiter:'/',flags:[],listed:true,subscribed:true}],folderStats:[{folder:'INBOX',fetched:emails.length,total:1,...extra}],emails });
test('body-term search survives metadata-only refreshes', async t => {
 const index = new LocalIndexService(await fixture(t), quietLog);
 await index.recordSnapshot(snapshot([email]));
 assert.equal((await index.search({query:'uniqueneedle'})).emails.length,1);
 await index.recordSnapshot(snapshot([{...email,isRead:true,preview:undefined}], {strategy:'incremental_window'}));
 const results = await index.search({query:'uniqueneedle'});
 assert.equal(results.emails.length,1);
 assert.equal(results.emails[0].isRead,true);
});
test('observed empty mailbox removes messages and FTS without affecting other folders', async t => {
 const index = new LocalIndexService(await fixture(t), quietLog);
 await index.recordSnapshot(snapshot([email,{...email,id:'Archive::1',folder:'Archive'}]));
 await index.recordSnapshot(snapshot([], {strategy:'empty',total:0}));
 assert.equal((await index.getStatus()).storedMessageCount,1);
 assert.equal((await index.search({query:'uniqueneedle',folder:'INBOX'})).emails.length,0);
 assert.equal((await index.search({query:'uniqueneedle',folder:'Archive'})).emails.length,1);
});
test('incremental snapshots preserve the historical backfill cursor', async t => {
 const index = new LocalIndexService(await fixture(t), quietLog);
 await index.recordSnapshot(snapshot([email], {strategy:'full',backfilledToUid:500,uidValidity:'1'}));
 await index.recordSnapshot(snapshot([email], {strategy:'incremental',uidValidity:'1'}));
 assert.equal((await index.getSyncCheckpointMap()).INBOX.backfilledToUid,500);
 await index.recordSnapshot(snapshot([], {strategy:'empty',total:0,uidValidity:'1'}));
 assert.equal((await index.getSyncCheckpointMap()).INBOX.backfilledToUid,undefined);
});
