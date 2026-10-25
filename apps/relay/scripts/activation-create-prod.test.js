import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runActivationCreate } from "./activation-create-prod.js";

const clock = 1800000000000;
const success = () => ({ status: 0, signal: null, stdout: JSON.stringify([
  { success: true, results: [], meta: { changes: 1 } },
]), stderr: "" });
function invoke(executor = success, overrides = {}) {
  let out = "";
  let err = "";
  const calls = [];
  const status = runActivationCreate({
    execute: args => { calls.push(args); assert.equal(out, ""); return executor(args); },
    now: () => clock,
    stdout: text => { out += text; },
    stderr: text => { err += text; },
    ...overrides,
  });
  return { status, out, err, calls };
}

test("creates a 32-byte base64url code only after one confirmed production D1 insert", () => {
  const result = invoke();
  assert.equal(result.status, 0);
  assert.equal(result.err, "");
  assert.match(result.out, /^[A-Za-z0-9_-]{43}\n$/);
  const code = result.out.trim();
  assert.equal(Buffer.from(code, "base64url").length, 32);
  assert.equal(result.calls.length, 1);
  const args = result.calls[0];
  assert.deepEqual(args.slice(0, 5), ["d1", "execute", "INSTALLATIONS", "--remote", "--json"]);
  assert.equal(args[5], "--config");
  assert.equal(args[6], fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)));
  assert.equal(args[7], "--command");
  assert.equal(args.length, 9);
  const sql = args[8];
  const fields = /^INSERT INTO activation_codes\(code_hash, expires_at, consumed_at\) VALUES \('([a-f0-9]{64})', ([0-9]+), NULL\)$/.exec(sql);
  assert.ok(fields);
  assert.equal(fields[1], createHash("sha256").update(code, "utf8").digest("hex"));
  assert.equal(Number(fields[2]), clock + 600000);
  assert.ok(!JSON.stringify(args).includes(code));
});

test("successive invocations generate different activation codes", () => {
  assert.notEqual(invoke().out, invoke().out);
});

for (const [label, response] of [
  ["nonzero exit even with success JSON", { ...success(), status: 7 }],
  ["spawn error", { ...success(), error: new Error("sensitive child diagnostics") }],
  ["terminated process", { ...success(), status: null, signal: "SIGTERM" }],
  ["timeout", { ...success(), error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }],
  ["invalid JSON", { ...success(), stdout: "not JSON" }],
  ["D1 failure despite exit zero", { ...success(), stdout: JSON.stringify([{ success: false, meta: { changes: 1 } }]) }],
  ["unconfirmed write count", { ...success(), stdout: JSON.stringify([{ success: true, meta: { changes: 0 } }]) }],
  ["missing metadata", { ...success(), stdout: JSON.stringify([{ success: true }]) }],
  ["unexpected multiple results", { ...success(), stdout: JSON.stringify([{ success: true, meta: { changes: 1 } }, { success: true, meta: { changes: 1 } }]) }],
  ["missing result", undefined],
]) {
  test(label + " exits nonzero without releasing a code or echoing Wrangler output", () => {
    const result = invoke(() => response);
    assert.notEqual(result.status, 0);
    assert.equal(result.out, "");
    assert.match(result.err, /未輸出 activation code/);
    assert.ok(!result.err.includes("sensitive child diagnostics"));
    assert.ok(!result.err.includes("not JSON"));
  });
}

test("thrown Wrangler failure remains controlled without leaking child output", () => {
  const result = invoke(() => { throw new Error("secret from child exception"); });
  assert.notEqual(result.status, 0);
  assert.equal(result.out, "");
  assert.ok(!result.err.includes("secret from child exception"));
});

test("child stdout and stderr are suppressed even on success", () => {
  const result = invoke(() => ({ ...success(), stderr: "sensitive child stderr" }));
  assert.equal(result.status, 0);
  assert.match(result.out, /^[A-Za-z0-9_-]{43}\n$/);
  assert.equal(result.err, "");
});

test("invalid clock fails before invoking Wrangler", () => {
  const result = invoke(success, { now: () => NaN });
  assert.notEqual(result.status, 0);
  assert.equal(result.out, "");
  assert.equal(result.calls.length, 0);
});

test("unsupported arguments fail before invoking Wrangler", () => {
  const result = invoke(success, { args: ["--local"] });
  assert.notEqual(result.status, 0);
  assert.equal(result.out, "");
  assert.equal(result.calls.length, 0);
  assert.match(result.err, /用法/);
});

test("an omitted executor cannot accidentally invoke the real production CLI in tests", () => {
  const result = invoke(success, { execute: undefined });
  assert.notEqual(result.status, 0);
  assert.equal(result.out, "");
  assert.equal(result.calls.length, 0);
});
