import { DeliveryQueueService } from '../../dist/services/delivery-queue-service.js';
import { SnoozeService } from '../../dist/services/snooze-service.js';
import { quietLog, deferred } from './review-fixtures.mjs';
const gate=deferred();
process.on('message', async message => {
 if(message.type==='finish') { gate.resolve(); return; }
 if(message.type!=='start')return;
 const {config,kind}=message;
 const perform=async()=>{process.send({type:'entered'});await gate.promise;return {messageId:'sent-id',targetEmailId:'INBOX::99'};};
 const service=kind==='send'
  ? new DeliveryQueueService(config,{sendEmail:perform},quietLog)
  : new SnoozeService(config,{moveEmail:perform,withTimeout:p=>p},quietLog);
 try { await service.checkDue();process.send({type:'done'}); }
 catch(error){process.send({type:'error',message:error.message});}
});
