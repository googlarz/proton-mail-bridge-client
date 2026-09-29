import { LocalIndexService } from "../../dist/services/local-index-service.js";

// Tests that build services indirectly (AccountManager, createServer) can't call
// close() themselves. Track every LocalIndexService that opens a db so cleanup can
// release the handles first — Windows refuses to delete a file that is still open.
const opened = new Set();
const original = LocalIndexService.prototype.ensureDb;
LocalIndexService.prototype.ensureDb = function (...args) {
  opened.add(this);
  return original.apply(this, args);
};

export async function closeTrackedIndexes() {
  const all = [...opened];
  opened.clear();
  await Promise.all(all.map((service) => service.close()));
}
