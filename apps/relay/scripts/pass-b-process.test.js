import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
import { NativeProcess, bounded, executeOwned, startNative } from "./pass-b-process.js";

function fakeChild({ exitOnEnd = false, exitOnKill = true } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.commands = [];
  child.kills = 0;
  child.dead = false;
  child.stdin.on("data", chunk => {
    for (const line of String(chunk).trim().split("\n").filter(Boolean)) child.commands.push(JSON.parse(line));
  });
  child.beginExit = (code = 0, signal = null) => {
    if (child.dead) return;
    child.dead = true;
    child.finalCode = code; child.finalSignal = signal;
    child.emit("exit", code, signal);
  };
  child.closeStdio = () => {
    if (child.stdioClosed) return;
    child.stdioClosed = true;
    child.stdout.end(); child.stderr.end();
    child.emit("close", child.finalCode ?? null, child.finalSignal ?? null);
  };
  child.exit = (code = 0, signal = null) => {
    child.beginExit(code, signal);
    // Node's exit precedes stdio drain. Tests can use beginExit/closeStdio to
    // inject the final pipe bytes into that interval deliberately.
    queueMicrotask(() => child.closeStdio());
  };
  child.stdin.on("finish", () => { if (exitOnEnd) queueMicrotask(() => child.exit()); });
  child.kill = () => {
    child.kills++;
    if (exitOnKill) queueMicrotask(() => child.exit(null, "SIGTERM"));
    return true;
  };
  child.reply = value => child.stdout.write("PASS_B " + JSON.stringify(value) + "\n");
  return child;
}

function watchTimers(t) {
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const active = new Set();
  t.mock.method(globalThis, "setTimeout", (callback, milliseconds, ...args) => {
    const timer = set(() => { active.delete(timer); callback(...args); }, milliseconds);
    active.add(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", timer => { active.delete(timer); clear(timer); });
  return active;
}

function injectSpawn(t, factory) {
  const calls = [];
  const spy = t.mock.method(childProcess, "spawn", (...args) => { calls.push(args); return factory(...args); });
  syncBuiltinESMExports();
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
  return calls;
}

test("process module import does not spawn a child", async t => {
  const calls = injectSpawn(t, () => { throw new Error("Import must not spawn"); });
  await import(new URL("./pass-b-process.js?import-safety", import.meta.url));
  assert.equal(calls.length, 0);
});

test("NativeProcess correlates replies, discards raw output and clears success timers", async t => {
  const timers = watchTimers(t);
  const child = fakeChild();
  const native = new NativeProcess(child);
  const pending = native.request("metrics", {}, { timeoutMs: 1000 });
  child.stdout.write("RAW sensitive credential must not reach a result\n");
  child.stderr.write("RAW secret stderr\n");
  child.reply({ id: "unowned-id", ok: true, result: "IGNORE_ME" });
  child.reply({ id: child.commands[0].id, ok: true, result: { activeMedia: 0 } });
  assert.deepEqual(await pending, { activeMedia: 0 });
  assert.equal(native.pending.size, 0);
  assert.equal(timers.size, 0);
  child.exit();
});

test("native failed reply exposes only a fixed error code", async t => {
  const timers = watchTimers(t);
  const child = fakeChild();
  const native = new NativeProcess(child);
  const pending = native.request("enroll", {}, { timeoutMs: 1000 });
  child.reply({ id: child.commands[0].id, ok: false, errorCode: "RAW_CREDENTIAL", error: "private child error" });
  await assert.rejects(pending, error => error.code === "NATIVE_OPERATION_FAILED" && !error.message.includes("private"));
  assert.equal(native.pending.size, 0);
  assert.equal(timers.size, 0);
  child.exit();
});

test("child crash rejects every pending control and removes its timers", async t => {
  const timers = watchTimers(t);
  const child = fakeChild();
  const native = new NativeProcess(child);
  t.after(() => child.exit(1));
  const first = native.request("metrics", {}, { timeoutMs: 1000 });
  const second = native.request("presence", {}, { timeoutMs: 1000 });
  void first.catch(() => {}); void second.catch(() => {});
  child.exit(1);
  await assert.rejects(first, /CHILD_CRASH/);
  await assert.rejects(second, /CHILD_CRASH/);
  assert.equal(native.pending.size, 0);
  assert.equal(timers.size, 0);
  await assert.rejects(native.request("metrics"), /CHILD_CRASH/);
});

test("child error without close stops work but cannot confirm process cleanup", async t => {
  const timers = watchTimers(t);
  const child = fakeChild({ exitOnKill: false });
  const native = new NativeProcess(child);
  const pending = native.request("metrics", {}, { timeoutMs: 1000 });
  child.emit("error", new Error("RAW_CHILD_ERROR"));
  await assert.rejects(pending, error => error.code === "CHILD_CRASH" && !error.message.includes("RAW_CHILD"));
  assert.equal(native.pending.size, 0);
  assert.equal(timers.size, 0);
  assert.equal(native.exited, false);
  let closed = false;
  void native.closed.then(() => { closed = true; });
  await assert.rejects(native.request("presence"), /CHILD_CRASH/);
  assert.equal(child.commands.length, 1);
  assert.equal(closed, false);
  t.mock.method(child, "kill", () => {
    child.kills++;
    child.emit("error", new Error("SYNTHETIC_KILL_FAILED"));
    return false;
  });
  await assert.rejects(native.stop(10), /CHILD_STOP_UNCONFIRMED/);
  assert.equal(child.kills, 1);
  assert.equal(native.exited, false);
  assert.equal(closed, false);
  assert.equal(timers.size, 0);
  child.closeStdio();
  await native.closed;
  assert.equal(native.exited, true);
});

test("spawn error becomes confirmed process closure only after close arrives", async t => {
  const timers = watchTimers(t);
  const child = fakeChild({ exitOnKill: false });
  const native = new NativeProcess(child);
  const pending = native.request("configure", {}, { timeoutMs: 1000 });
  child.emit("error", new Error("SYNTHETIC_SPAWN_FAILED"));
  await assert.rejects(pending, /CHILD_CRASH/);
  assert.equal(native.exited, false);
  await assert.rejects(native.request("configure"), /CHILD_CRASH/);
  child.finalCode = -2;
  child.closeStdio();
  assert.equal(await native.closed, -2);
  assert.deepEqual(await native.stop(10), { confirmed: true, exitCode: -2 });
  assert.equal(child.kills, 0);
  assert.equal(timers.size, 0);
});

test("stdin stream error rejects pending controls without an unhandled stream error", async t => {
  const timers = watchTimers(t);
  const child = fakeChild();
  const native = new NativeProcess(child);
  t.after(() => child.exit(1));
  const first = native.request("metrics", {}, { timeoutMs: 1000 });
  const second = native.request("presence", {}, { timeoutMs: 1000 });
  void first.catch(() => {}); void second.catch(() => {});
  assert.doesNotThrow(() => child.stdin.emit("error", new Error("RAW_STDIN_SECRET")));
  await assert.rejects(first, error => error.code === "CHILD_CRASH" && !error.message.includes("RAW_STDIN"));
  await assert.rejects(second, /CHILD_CRASH/);
  assert.equal(native.pending.size, 0);
  assert.equal(timers.size, 0);
  child.exit(1);
});

test("synchronous stdin write failure is sanitized and clears pending state", async t => {
  const timers = watchTimers(t);
  const child = fakeChild();
  const native = new NativeProcess(child);
  t.after(() => child.exit(1));
  t.mock.method(child.stdin, "write", () => { throw new Error("RAW_WRITE_SECRET"); });
  await assert.rejects(native.request("metrics", {}, { timeoutMs: 1000 }),
    error => ["CHILD_CRASH", "INVALID_CONTROL_MESSAGE"].includes(error.code) && !error.message.includes("RAW_WRITE"));
  assert.equal(native.pending.size, 0);
  assert.equal(timers.size, 0);
  child.exit(1);
});

test("request cancellation and timeout reject once, remove pending state and timers", async t => {
  const timers = watchTimers(t);
  const child = fakeChild();
  const native = new NativeProcess(child);
  const abort = new AbortController();
  const cancelled = native.request("metrics", {}, { timeoutMs: 1000, signal: abort.signal });
  abort.abort();
  await assert.rejects(cancelled, /CANCELLED/);
  assert.equal(native.pending.size, 0);
  assert.equal(timers.size, 0);
  const timedOut = native.request("presence", {}, { timeoutMs: 5 });
  await assert.rejects(timedOut, /DEADLINE/);
  assert.equal(native.pending.size, 0);
  assert.equal(timers.size, 0);
  child.exit();
});

test("a trustworthy late effect is reported after request timeout without resuming control", async () => {
  const child = fakeChild();
  const effects = [];
  const native = new NativeProcess(child, { onEffect: effect => effects.push(effect) });
  const pending = native.request("create", {}, { timeoutMs: 5 });
  await assert.rejects(pending, /DEADLINE/);
  child.reply({ event: "effectConfirmed", resource: "session", id: "r".repeat(32) });
  child.reply({ id: child.commands[0].id, ok: true, result: { remoteSessionId: "r".repeat(32) } });
  assert.equal(effects.length, 1);
  assert.equal(native.pending.size, 0);
  child.exit();
});

test("exit drains a final exact-ID confirmation before close rejects pending control", async t => {
  const timers = watchTimers(t);
  const child = fakeChild();
  const effects = [];
  const native = new NativeProcess(child, { onEffect: effect => effects.push(effect) });
  const pending = native.request("create", {}, { timeoutMs: 1000 });
  const rejected = assert.rejects(pending, /CHILD_CRASH/);
  child.beginExit(1);
  assert.equal(native.exitObserved, true);
  assert.equal(native.exited, false);
  assert.equal(native.pending.size, 1);
  await assert.rejects(native.request("metrics"), /CHILD_CRASH/);
  const exactId = "s".repeat(32);
  child.reply({ event: "effectConfirmed", resource: "session", id: exactId });
  assert.equal(effects.length, 1);
  assert.equal(effects[0].id, exactId);
  child.closeStdio();
  await rejected;
  assert.equal(await native.closed, 1);
  assert.equal(native.exited, true);
  assert.equal(native.pending.size, 0);
  assert.equal(timers.size, 0);
});

test("malformed native protocol kills only the owned child", async () => {
  const child = fakeChild();
  const unrelated = fakeChild();
  const native = new NativeProcess(child);
  const pending = native.request("metrics");
  child.stdout.write("PASS_B malformed\n");
  await assert.rejects(pending, /INVALID_NATIVE_REPLY/);
  assert.equal(child.kills, 1);
  assert.equal(unrelated.kills, 0);
});

test("unbounded native output is rejected before a newline is required", async () => {
  const child = fakeChild();
  const native = new NativeProcess(child);
  const pending = native.request("metrics");
  child.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1, 65));
  await assert.rejects(pending, /CHILD_OUTPUT_LIMIT/);
  assert.equal(child.kills, 1);
});

test("stop closes stdin then terminates the tracked child under a bounded deadline", async t => {
  const timers = watchTimers(t);
  const child = fakeChild();
  const native = new NativeProcess(child);
  const pending = native.request("metrics");
  const rejected = assert.rejects(pending, /CANCELLED/);
  const result = await native.stop(20);
  await rejected;
  assert.equal(result.confirmed, true);
  assert.equal(child.kills, 1);
  assert.equal(child.stdin.writableEnded, true);
  assert.equal(native.pending.size, 0);
  assert.equal(timers.size, 0);
});

test("unconfirmed child termination remains a cleanup error", async t => {
  const timers = watchTimers(t);
  const child = fakeChild({ exitOnKill: false });
  const native = new NativeProcess(child);
  await assert.rejects(native.stop(10), /CHILD_STOP_UNCONFIRMED/);
  assert.equal(child.kills, 1);
  assert.equal(native.exited, false);
  assert.equal(timers.size, 0);
  child.exit();
});

test("terminate immediately stops only the owned child without claiming confirmed exit", async t => {
  const timers = watchTimers(t);
  const child = fakeChild({ exitOnKill: false });
  const unrelated = fakeChild();
  const native = new NativeProcess(child);
  const pending = native.request("metrics", {}, { timeoutMs: 1000 });
  const rejected = assert.rejects(pending, /CANCELLED/);
  assert.equal(native.terminate(), false);
  assert.equal(child.kills, 1);
  assert.equal(unrelated.kills, 0);
  await rejected;
  assert.equal(native.pending.size, 0);
  assert.equal(timers.size, 0);
  child.exit();
  await native.closed;
  assert.equal(native.terminate(), true);
  assert.equal(child.kills, 1);
});

test("startNative passes fixed test argv, hides the window and filters inherited secrets", async t => {
  const child = fakeChild();
  const calls = injectSpawn(t, () => child);
  const key = "CLASSROOM_PASS_B_TEST_SECRET";
  const old = process.env[key];
  process.env[key] = "DO_NOT_INHERIT";
  try {
    const native = startNative("synthetic.exe", "http://127.0.0.1:8794/", () => {});
    assert.equal(calls.length, 1);
    const [executable, args, options] = calls[0];
    assert.equal(executable, "synthetic.exe");
    assert.deepEqual(args, ["--exact", "application::remote_control::pass_b::remote_pass_b_runner", "--ignored", "--nocapture", "--test-threads=1", "--format=terse"]);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.env[key], undefined);
    assert.equal(options.env.CLASSROOM_REMOTE_BASE_URL, "http://127.0.0.1:8794/");
    child.exit();
    await native.closed;
    assert.equal(native.exited, true);
  } finally { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
});

test("executeOwned returns captured stdout only and never forwards child stderr", async t => {
  const timers = watchTimers(t);
  const child = fakeChild();
  const calls = injectSpawn(t, () => child);
  const owned = [];
  const pending = executeOwned("synthetic.exe", ["--mock"], { cwd: "I:\\ChatGPT\\teachTools", timeoutMs: 1000, onChild: value => owned.push(value) });
  child.stdout.write("{\"confirmed\":true}");
  child.stderr.write("SENSITIVE_STDERR");
  child.exit();
  assert.deepEqual(await pending, { code: 0, signal: null, stdout: '{"confirmed":true}' });
  assert.deepEqual(owned, [child]);
  assert.equal(calls[0][2].windowsHide, true);
  assert.equal(calls[0][2].shell, false);
  assert.equal(timers.size, 0);
});

test("executeOwned timeout terminates its child and does not report success", async t => {
  const timers = watchTimers(t);
  const child = fakeChild();
  injectSpawn(t, () => child);
  const pending = executeOwned("synthetic.exe", [], { timeoutMs: 5 });
  await assert.rejects(pending, /DEADLINE/);
  assert.equal(child.kills, 1);
  assert.equal(timers.size, 0);
});

test("executeOwned has a final rejection when its killed child never closes", async t => {
  const scheduled = new Map();
  t.mock.method(globalThis, "setTimeout", (callback, milliseconds) => {
    const timer = { callback, milliseconds };
    scheduled.set(timer, timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", timer => scheduled.delete(timer));
  const child = fakeChild({ exitOnKill: false });
  injectSpawn(t, () => child);
  const pending = executeOwned("synthetic.exe", [], { timeoutMs: 5 });
  const fire = milliseconds => {
    const timer = [...scheduled.values()].find(value => value.milliseconds === milliseconds);
    assert.ok(timer);
    scheduled.delete(timer);
    timer.callback();
  };
  fire(5);
  assert.equal(child.kills, 1);
  fire(3000);
  await assert.rejects(pending, /CHILD_STOP_UNCONFIRMED/);
  assert.equal(scheduled.size, 0);
  child.exit();
});

test("executeOwned child crash and output overflow are failures without raw errors", async t => {
  const timers = watchTimers(t);
  const children = [];
  injectSpawn(t, () => { const child = fakeChild(); children.push(child); return child; });
  const crashed = executeOwned("synthetic.exe", [], { timeoutMs: 1000 });
  children[0].emit("error", new Error("RAW_SECRET_PROCESS_FAILURE"));
  await assert.rejects(crashed, error => error.code === "CHILD_CRASH" && !error.message.includes("RAW_SECRET"));
  children[0].exit(1);
  const overflow = executeOwned("synthetic.exe", [], { timeoutMs: 1000 });
  children[1].stdout.write(Buffer.alloc(1024 * 1024 + 1, 65));
  await assert.rejects(overflow, /DEADLINE|OUTPUT_LIMIT/);
  assert.equal(children[1].kills, 1);
  assert.equal(timers.size, 0);
});

test("invalid process deadlines reject before spawn and bounded success clears its timer", async t => {
  const timers = watchTimers(t);
  const calls = injectSpawn(t, () => { throw new Error("No spawn expected"); });
  for (const timeoutMs of [0, -1, NaN, Infinity, 120001]) assert.throws(() => executeOwned("synthetic.exe", [], { timeoutMs }), /INVALID_CHILD_DEADLINE/);
  assert.equal(calls.length, 0);
  assert.equal(await bounded(() => 42, 1000), 42);
  assert.equal(timers.size, 0);
});
