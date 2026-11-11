import { serveJob } from "../../dist/utils/child-job.js";

// Exits the way V8's out-of-memory abort looks on Windows: exit code 134 and no signal.
serveJob(() => {
  process.exit(134);
});
