import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { createProductionAdapter, d1Statement } from "./pass-b-adapters.js";

const now = 1_800_000_000_000;
const activationHash = "a".repeat(64);
const installationId = randomUUID();
const confirmed = changes => ({ code: 0, signal: null,
  stdout: JSON.stringify([{ success: true, meta: { changes } }]) });

test("adapter import and construction do not execute transports or Wrangler", async () => {
  let calls = 0;
  const module = await import(new URL("./pass-b-adapters.js?import-only", import.meta.url));
  const adapter = module.createProductionAdapter({ execute: async () => { calls++; return confirmed(1); } });
  assert.equal(typeof adapter.provision, "function");
  assert.equal(calls, 0);
  assert.throws(() => createProductionAdapter(), /EXPLICIT_D1_EXECUTOR_REQUIRED/);
});

test("D1 statements use only exact owned installation ID or activation hash", () => {
  assert.deepEqual(d1Statement("provision", activationHash, now), {
    sql: `INSERT INTO activation_codes(code_hash, expires_at, consumed_at) VALUES ('${activationHash}', ${now + 600000}, NULL)`,
    expectedChanges: 1,
  });
  assert.deepEqual(d1Statement("revoke", installationId, now), {
    sql: `UPDATE installations SET status = 'REVOKED', revoked_at = ${now} WHERE id = '${installationId}' AND status = 'ACTIVE'`,
    expectedChanges: 1,
  });
  assert.deepEqual(d1Statement("activationCleanup", activationHash, now), {
    sql: `DELETE FROM activation_codes WHERE code_hash = '${activationHash}'`, expectedChanges: null,
  });
  for (const [operation, id] of [["deleteAll", installationId], ["revoke", "ACTIVE"],
    ["revoke", installationId + "' OR 1=1 --"], ["activationCleanup", "*"],
    ["provision", "raw-code"], ["provision", activationHash + "'"], ["revoke", activationHash]]) {
    assert.throws(() => d1Statement(operation, id, now), /INVALID_EXACT_D1_OPERATION/);
  }
});

test("D1 clock and activation expiry remain bounded safe integers", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, "1800000000000"]) {
    assert.throws(() => d1Statement("provision", activationHash, value), /INVALID_D1_CLOCK/);
  }
  assert.throws(() => d1Statement("provision", activationHash, Number.MAX_SAFE_INTEGER), /INVALID_D1_CLOCK/);
});

test("production adapter passes a hash, never raw activation code, in child argv", async () => {
  const code = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(code).digest("hex");
  const calls = [];
  const adapter = createProductionAdapter({ now: () => now, execute: async args => {
    calls.push(args); return confirmed(1);
  } });
  assert.deepEqual(await adapter.provision(hash), { confirmed: true, disposition: "INSERTED" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 6), ["d1", "execute", "INSTALLATIONS", "--remote", "--json", "--config"]);
  assert.equal(calls[0].at(-2), "--command");
  assert.equal(calls[0].at(-1), d1Statement("provision", hash, now).sql);
  assert.equal(JSON.stringify(calls).includes(code), false);
  await assert.rejects(adapter.provision(code), /INVALID_EXACT_D1_OPERATION/);
  assert.equal(calls.length, 1);
});

test("revoke and cleanup target exact IDs; an absent exact hash is confirmed absent", async () => {
  const calls = [];
  const adapter = createProductionAdapter({ now: () => now, execute: async args => {
    calls.push(args); return confirmed(args.at(-1).startsWith("DELETE") ? 0 : 1);
  } });
  assert.deepEqual(await adapter.revoke(installationId), { confirmed: true, disposition: "REVOKED_ROW_RETAINED" });
  assert.deepEqual(await adapter.activationCleanup(activationHash), { confirmed: true, disposition: "ABSENT" });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].at(-1).includes(`WHERE id = '${installationId}' AND status = 'ACTIVE'`));
  assert.ok(calls[1].at(-1).endsWith(`WHERE code_hash = '${activationHash}'`));
  assert.equal(calls.some(args => /SELECT|ORDER BY|LIMIT\s+1/i.test(args.at(-1))), false);
});

for (const [name, result] of [
  ["nonzero exit", { ...confirmed(1), code: 1 }],
  ["terminated child", { ...confirmed(1), signal: "SIGTERM" }],
  ["lost response", { code: 0, stdout: "" }],
  ["malformed response", { code: 0, stdout: "not JSON" }],
  ["object instead of array", { code: 0, stdout: JSON.stringify({ success: true, meta: { changes: 1 } }) }],
  ["multiple responses", { code: 0, stdout: JSON.stringify([{ success: true, meta: { changes: 1 } }, { success: true, meta: { changes: 1 } }]) }],
  ["reported failure", { code: 0, stdout: JSON.stringify([{ success: false, meta: { changes: 1 } }]) }],
  ["missing changes", { code: 0, stdout: JSON.stringify([{ success: true, meta: {} }]) }],
  ["fractional changes", confirmed(0.5)],
  ["zero inserts", confirmed(0)],
  ["multiple inserts", confirmed(2)],
]) {
  test(`unconfirmed provision (${name}) rejects once without retry or success`, async () => {
    let calls = 0;
    const adapter = createProductionAdapter({ execute: async () => { calls++; return result; } });
    await assert.rejects(adapter.provision(activationHash), /D1_EFFECT_UNCONFIRMED/);
    assert.equal(calls, 1);
  });
}

test("executor response loss is not retried and cannot report cleanup success", async () => {
  let calls = 0;
  const adapter = createProductionAdapter({ execute: async () => { calls++; throw new Error("MOCK_RESPONSE_LOST"); } });
  await assert.rejects(adapter.provision(activationHash));
  assert.equal(calls, 1);
  const invalidCleanup = createProductionAdapter({ execute: async () => confirmed(2) });
  await assert.rejects(invalidCleanup.activationCleanup(activationHash), /D1_EFFECT_UNCONFIRMED/);
  const unconfirmedRevoke = createProductionAdapter({ execute: async () => confirmed(0) });
  await assert.rejects(unconfirmedRevoke.revoke(installationId), /D1_EFFECT_UNCONFIRMED/);
});
