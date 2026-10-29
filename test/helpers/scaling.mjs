import assert from "node:assert/strict";

// A wall-clock limit measures the machine as much as the code. These compare the code with itself: the same input at size
// n and at 4n, in one process, after a warm-up, each the fastest of a few runs. Linear work gives a ratio near 4, quadratic
// work 16, so a ratio of at most 8 passes anything up to mildly super-linear. The ceiling only catches a hang.
export const SCALING_RATIO = 8;
export const HANG_CEILING_MS = 15_000;
// Below this a timer reading is mostly noise, so a faster small run is rated as if it took this long.
const NOISE_FLOOR_MS = 10;

const fastest = (run, input, runs) => {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    run(input);
    best = Math.min(best, performance.now() - started);
  }
  return best;
};

/**
 * `make(size)` builds the input, `run(input)` does the work. Asserts that 4x the input costs at most `ratio` times as much
 * (and that no run reaches the hang ceiling). Returns the two timings and their ratio for the failure message's sake.
 */
export function assertScalesWithInput(label, make, run, size, { ratio = SCALING_RATIO, runs = 3, ceilingMs = HANG_CEILING_MS } = {}) {
  const small = make(size);
  const large = make(size * 4);
  run(small);
  const smallMs = fastest(run, small, runs);
  const largeMs = fastest(run, large, runs);
  const measured = largeMs / Math.max(smallMs, NOISE_FLOOR_MS);
  const detail = `${label}: ${smallMs.toFixed(1)} ms at ${size}, ${largeMs.toFixed(1)} ms at ${size * 4} (x${measured.toFixed(1)})`;
  assert.ok(largeMs < ceilingMs, `hang? ${detail}`);
  assert.ok(measured <= ratio, `super-linear: ${detail}`);
  return { smallMs, largeMs, ratio: measured };
}
