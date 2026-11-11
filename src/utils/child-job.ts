import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";

// Runs one job in a child process that can be killed. Document parsing used to run in worker_threads, but terminating
// a worker while zlib is being constructed leaves an uninitialised native handle, and Node then aborts the WHOLE
// process at worker teardown (CHECK "close before init" in ZlibContext::Close). A child killed with SIGKILL cannot
// take this process down.
//
// The MCP protocol runs over this process's stdout, so the child never gets it: stdin and stdout are /dev/null,
// stderr is read and thrown away so a chatty child cannot fill its pipe. The child is a script that waits for one
// IPC message (the payload), sends one back (the outcome) and then idles until it is killed here.

export type ChildJobEnd<R> =
  | { kind: "message"; message: R }
  | { kind: "timeout" }
  /** The child exited, crashed (out of memory included) or could not be started or reached, without an outcome. */
  | { kind: "died"; code: number | null; signal: NodeJS.Signals | null };

const live = new Set<ChildProcess>();
let exitHookInstalled = false;

/**
 * Starts `script` in a child, sends it `payload` and resolves, never rejects, once the job ended and the child is
 * gone. The timer counts from the start. On timeout, error or an outcome the child gets SIGKILL.
 */
export function runInChild<R>(script: URL, payload: unknown, options: { timeoutMs: number; execArgv?: string[] }): Promise<ChildJobEnd<R>> {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // Best effort: no child outlives this process. A child also exits by itself when its IPC channel closes.
    process.on("exit", () => {
      for (const child of live) child.kill("SIGKILL");
    });
  }
  return new Promise<ChildJobEnd<R>>((resolve) => {
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
    } catch {
      resolve({ kind: "died", code: null, signal: null });
      return;
    }
    live.add(child);
    child.stderr?.resume();

    let outcome: ChildJobEnd<R> | undefined;
    const done = () => {
      clearTimeout(timer);
      live.delete(child);
      resolve(outcome ?? { kind: "died", code: child.exitCode, signal: child.signalCode });
    };
    // Records the outcome, kills the child and waits for its exit, so the caller's slot is free only once it is gone.
    const end = (result: ChildJobEnd<R>) => {
      if (outcome) return;
      outcome = result;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      else done();
    };

    const timer = setTimeout(() => end({ kind: "timeout" }), options.timeoutMs);
    timer.unref?.();
    child.once("message", (message) => end({ kind: "message", message: message as R }));
    child.once("exit", done);
    child.once("error", () => {
      // No pid: the child never started, so there will be no exit event.
      if (child.pid === undefined) done();
      else end({ kind: "died", code: null, signal: null });
    });
    child.send(payload as never, (error) => {
      if (error) end({ kind: "died", code: null, signal: null });
    });
  });
}
