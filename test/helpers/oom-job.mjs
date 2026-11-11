import { serveJob } from "../../dist/utils/child-job.js";

// A job that runs out of memory (the test starts it with a tiny --max-old-space-size), to see how the parent reports it.
serveJob(() => {
  const hoard = [];
  for (;;) hoard.push(new Array(100_000).fill(Math.random()));
});
