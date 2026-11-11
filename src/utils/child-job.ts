import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, type ResourceLimits, Worker, workerData } from "node:worker_threads";

// Runs one job in a process that can be killed. Document parsing used to run in worker_threads, but terminating a
// worker while zlib is being constructed leaves an uninitialised native handle, and Node then aborts the WHOLE
// process at worker teardown (CHECK "close before init" in ZlibContext::Close). A child killed with SIGKILL cannot
// take this process down.
//
// The MCP protocol runs over this process's stdout, so the child never gets it: stdin and stdout are /dev/null,
// stderr is read and thrown away so a chatty child cannot fill its pipe. The child is a script (see serveJob) that
// waits for one IPC message (the payload), sends one back (the outcome) and then idles until it is killed here.
//
// Inside Electron (Claude Desktop's own Node) process.execPath is the app's helper binary, which cannot run a plain
// script, so there the job runs in a worker thread as before. PROTONMAIL_FORCE_WORKER_THREADS=1 selects that mode
// anywhere; it exists for the tests and is not a supported setting.

export type JobEnd<R> =
  | { kind: "message"; message: R }
  | { kind: "timeout" }
  /**
   * No outcome. `started` is false when the child never got as far as running the script (spawn failed, bad flag,
   * script not found); that is only meaningful in fork mode: a worker thread whose script is missing reports
   * started: true, crashed: true. `signal` is set when a child was killed by one (an out-of-memory abort is SIGABRT).
   * `error` is the error event's error, when there was one.
   */
  | { kind: "died"; started: boolean; crashed: boolean; code: number | null; signal: NodeJS.Signals | null; error?: unknown };

const useWorkerThreads = () => Boolean(process.versions.electron) || process.env.PROTONMAIL_FORCE_WORKER_THREADS === "1";

interface JobOptions {
  timeoutMs: number;
  /** V8 flags for the child process (fork mode). */
  execArgv?: string[];
  /** The same limits for a worker thread (worker mode). */
  resourceLimits?: ResourceLimits;
}

/**
 * Runs `script` with `payload` and resolves, never rejects, once the job ended and the child or worker is gone. The
 * timer counts from the start. On timeout, error or an outcome the child gets SIGKILL (the worker is terminated).
 */
export function runJob<R>(script: URL, payload: unknown, options: JobOptions): Promise<JobEnd<R>> {
  return useWorkerThreads() ? runInWorker<R>(script, payload, options) : runInChild<R>(script, payload, options);
}

const live = new Set<ChildProcess>();
let exitHookInstalled = false;

// Sent by the child once its script is loaded and listening, to tell "never started" from "crashed while working".
const READY = { ready: true };

function runInChild<R>(script: URL, payload: unknown, options: JobOptions): Promise<JobEnd<R>> {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // Best effort: no child outlives this process. A child also exits by itself when its IPC channel closes.
    process.on("exit", () => {
      for (const child of live) child.kill("SIGKILL");
    });
  }
  return new Promise<JobEnd<R>>((resolve) => {
    let child: ChildProcess;
    try {
      child = fork(fileURLToPath(script), [], {
        // Advanced serialization moves Buffers and Uint8Arrays natively instead of as JSON.
        serialization: "advanced",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        // Explicit, so nothing is inherited: no --inspect port clash, no NODE_OPTIONS preload, and no secrets from this
        // process's environment (the child needs none; SystemRoot is what Node on Windows wants to find).
        execArgv: options.execArgv ?? [],
        env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
      });
    } catch (error) {
      resolve({ kind: "died", started: false, crashed: false, code: null, signal: null, error });
      return;
    }
    live.add(child);
    child.stderr?.resume();

    let started = false;
    let errored = false;
    let failure: unknown;
    let outcome: JobEnd<R> | undefined;
    const done = () => {
      clearTimeout(timer);
      live.delete(child);
      resolve(
        outcome ?? {
          kind: "died",
          started,
          crashed: errored || child.signalCode !== null || Boolean(child.exitCode),
          code: child.exitCode,
          signal: child.signalCode,
          error: failure,
        },
      );
    };
    // Records the outcome, kills the child and waits for its exit, so the caller's slot is free only once it is gone.
    const end = (result: JobEnd<R>) => {
      if (outcome) return;
      outcome = result;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      else done();
    };

    const timer = setTimeout(() => end({ kind: "timeout" }), options.timeoutMs);
    timer.unref?.();
    child.on("message", (message) => {
      if (message && (message as { ready?: boolean }).ready === true) started = true;
      else end({ kind: "message", message: message as R });
    });
    child.once("exit", done);
    child.on("error", (error) => {
      errored = true;
      failure ??= error;
      // No pid: the child never started, so there will be no exit event.
      if (child.pid === undefined) done();
      else end({ kind: "died", started, crashed: true, code: null, signal: null, error });
    });
    child.send(payload as never, (error) => {
      if (error) end({ kind: "died", started, crashed: true, code: null, signal: null, error });
    });
  });
}

function runInWorker<R>(script: URL, payload: unknown, options: JobOptions): Promise<JobEnd<R>> {
  return new Promise<JobEnd<R>>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(script, { workerData: payload, resourceLimits: options.resourceLimits });
    } catch (error) {
      resolve({ kind: "died", started: false, crashed: false, code: null, signal: null, error });
      return;
    }
    let settled = false;
    const finish = (result: JobEnd<R>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ kind: "timeout" }), options.timeoutMs);
    timer.unref?.();
    // No "never started" case for a worker (the old code did not tell one apart): an error event is a crash, as before.
    worker.once("message", (message) => finish({ kind: "message", message: message as R }));
    worker.once("error", (error) => finish({ kind: "died", started: true, crashed: true, code: null, signal: null, error }));
    worker.once("exit", (code) => finish({ kind: "died", started: true, crashed: false, code, signal: null }));
  });
}

/**
 * The entry point of a job script. `handle` gets the payload and returns the outcome message (it must not throw). It
 * runs under either mode: as a forked process (IPC) or as a worker thread (workerData and parentPort).
 */
export function serveJob(handle: (job: unknown) => unknown | Promise<unknown>): void {
  if (!isMainThread && parentPort) {
    const port = parentPort;
    void Promise.resolve(handle(workerData)).then((reply) => port.postMessage(reply));
    return;
  }
  process.on("disconnect", () => process.exit(0));
  process.once("message", (job) => {
    void Promise.resolve(handle(job)).then((reply) =>
      process.send?.(reply, (error) => {
        if (error) process.exit(1);
      }),
    );
  });
  process.send?.(READY);
}

/** Bounded concurrency with a bounded queue, for jobs that can each expand a document to tens of MB. */
export class JobSlots {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly max: number,
    private readonly maxQueued: number,
  ) {}

  /** Runs `work` when a slot is free; `busy` makes the error for a full queue. */
  async run<T>(work: () => Promise<T>, busy: () => Error): Promise<T> {
    if (this.running >= this.max) {
      if (this.waiting.length >= this.maxQueued) throw busy();
      // A finishing job hands its slot straight to the next one, so `running` stays at the limit.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.running++;
    }
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}
