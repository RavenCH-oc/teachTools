import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

export class RunnerError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export async function bounded(operation, milliseconds, code = "DEADLINE") {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new RunnerError(code)), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

// Child stderr and non-protocol stdout are deliberately discarded, never copied
// to logs/reports. Only the owned ChildProcess handle may be terminated.
export class NativeProcess {
  constructor(child, { onEffect = () => {} } = {}) {
    this.child = child; this.pending = new Map(); this.exited = false; this.exitCode = null; this.errored = false;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.bytes = 0;
    child.stdout.on("data", chunk => {
      this.bytes += chunk.length;
      if (this.bytes > 4 * 1024 * 1024) { this.fail("CHILD_OUTPUT_LIMIT"); child.stdout.destroy(); child.kill(); }
    });
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", line => {
      if (line.length > 128 * 1024) { this.fail("CHILD_OUTPUT_LIMIT"); child.kill(); return; }
      if (!line.startsWith("PASS_B ")) return;
      let value;
      try { value = JSON.parse(line.slice(7)); } catch { this.fail("INVALID_NATIVE_REPLY"); child.kill(); return; }
      if (value.event === "effectConfirmed") {
        try { onEffect(value); } catch { this.fail("LEDGER_CONFIRMATION_FAILED"); child.kill(); }
        return;
      }
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id); pending.dispose();
      if (value.ok === true) pending.resolve(value.result);
      else pending.reject(new RunnerError("NATIVE_OPERATION_FAILED"));
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => this.fail("CHILD_CRASH"));
    // An error can report a failed kill/send while the child is still running.
    // Stop further work, but only `close` confirms that the owned process and
    // its stdio are gone; keep draining any trustworthy exact-ID confirmation.
    child.on("error", () => { this.errored = true; this.fail("CHILD_CRASH"); });
    // `exit` can precede the last stdout bytes. Keep parsing trusted exact-ID
    // confirmations until `close`, which means stdio has drained.
    child.on("exit", code => { this.exitObserved = true; this.exitCode = code; });
    child.on("close", code => { this.fail("CHILD_CRASH"); this.finish(code); });
  }
  finish(code) {
    if (this.exited) return;
    this.exited = true; this.exitCode = code; this.lines.close(); this.resolveClosed(code);
  }
  fail(code) {
    for (const pending of this.pending.values()) { pending.dispose(); pending.reject(new RunnerError(code)); }
    this.pending.clear();
  }
  terminate() {
    this.fail("CANCELLED");
    if (!this.exited) this.child.kill();
    return this.exited;
  }
  request(command, fields = {}, { timeoutMs = 45000, signal } = {}) {
    if (this.exited || this.exitObserved || this.errored || signal?.aborted) return Promise.reject(new RunnerError(signal?.aborted ? "CANCELLED" : "CHILD_CRASH"));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) return Promise.reject(new RunnerError("INVALID_CONTROL_DEADLINE"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const stop = code => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id); pending.dispose(); reject(new RunnerError(code));
      };
      const timer = setTimeout(() => stop("DEADLINE"), timeoutMs);
      const onAbort = () => stop("CANCELLED");
      this.pending.set(id, { resolve, reject, dispose: () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); } });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.child.stdin.write(JSON.stringify({ id, command, ...fields }) + "\n", error => { if (error) stop("CHILD_CRASH"); });
      } catch { stop("INVALID_CONTROL_MESSAGE"); }
    });
  }
  async stop(timeoutMs = 5000) {
    this.fail("CANCELLED");
    if (!this.exited) {
      this.child.stdin.end();
      try { await bounded(() => this.closed, Math.max(1, timeoutMs / 2)); }
      catch { this.child.kill(); await bounded(() => this.closed, Math.max(1, timeoutMs / 2), "CHILD_STOP_UNCONFIRMED"); }
    }
    return { confirmed: this.exited, exitCode: this.exitCode };
  }
}

export function startNative(executable, origin, onEffect) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|COMSPEC|PATHEXT)$/i.test(key)));
  env.CLASSROOM_REMOTE_BASE_URL = origin;
  const child = spawn(executable, ["--exact", "application::remote_control::pass_b::remote_pass_b_runner", "--ignored", "--nocapture", "--test-threads=1", "--format=terse"],
    { env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
  return new NativeProcess(child, { onEffect });
}

export function executeOwned(executable, args, { cwd, timeoutMs, onChild = () => {} } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) throw new RunnerError("INVALID_CHILD_DEADLINE");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    onChild(child);
    let stdout = "", bytes = 0, stopped = false, killTimer;
    const stop = () => {
      if (stopped) return;
      stopped = true; child.kill();
      killTimer = setTimeout(() => reject(new RunnerError("CHILD_STOP_UNCONFIRMED")), 3000);
    };
    const timer = setTimeout(stop, timeoutMs);
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) stop();
      else stdout += chunk;
    });
    child.stderr.on("data", () => {});
    child.on("error", () => { clearTimeout(timer); clearTimeout(killTimer); reject(new RunnerError("CHILD_CRASH")); });
    child.on("close", (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (stopped) reject(new RunnerError("DEADLINE"));
      else resolve({ code, signal, stdout });
    });
  });
}
