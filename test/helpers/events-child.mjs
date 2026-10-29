// Child process used by test/events.test.mjs: appends <count> events to the event log of <dataDir>, one append each, as
// a second server process on the same data directory would.
import { EventLogService } from "../../dist/services/event-log-service.js";

const [, , dataDir, count, tag] = process.argv;
const log = new EventLogService({ dataDir, smtp: { username: "owner@example.com" } });
for (let i = 0; i < Number(count); i += 1) {
  await log.append([{ type: "mail.new", emailId: `INBOX::${tag}${i}`, from: `${tag}${i}@example.com`, subject: `${tag} ${i}` }]);
}
