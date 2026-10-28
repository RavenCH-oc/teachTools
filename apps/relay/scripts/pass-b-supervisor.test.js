import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { parseArguments, plan, executeCommand, supervise, validateAuthorization, readBuildManifest } from "./pass-b.js";
import { artifactRoot, sourceIdentity, sha256 } from "./pass-b-build.js";
import { createProductionAdapter } from "./pass-b-adapters.js";
import { RunLedger } from "./pass-b-ledger.js";
import { validateProfile, createDeadline, CANONICAL_ORIGIN, LIMITS } from "./pass-b-safety.js";

function fixture({ failCommand, effectiveUrl, cleanup, adapterCleanup, workload, afterRequest, lostReply, persist } = {}) {
  const profile = validateProfile({ mode: "loopback", students: 2 });
  const ledger = new RunLedger(profile.runId, { persist });
  const calls = [];
  const installationId = randomUUID(), remoteSessionId = "R".repeat(32);
  let onEffect;
  const native = {
    async request(command, fields, options) {
      calls.push({ operation: command, ...(command === "close" ? { id: fields.remoteSessionId } : {}) });
      assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 45000);
      if (command === failCommand) throw Object.assign(new Error("synthetic failure"), { code: "CHILD_CRASH" });
      let result;
      if (command === "configure") result = { effectiveUrl: effectiveUrl ?? profile.origin, rawLimit: LIMITS.rawBytes, wireLimit: LIMITS.teacherUtf8Bytes };
      else if (command === "enroll") {
        assert.equal(fields.activationCode.length, 43);
        if (lostReply === command) throw Object.assign(new Error("reply lost"), { code: "DEADLINE" });
        onEffect?.({ resource: "installation", id: installationId });
        result = { installationId };
      } else if (command === "create") {
        if (lostReply === command) throw Object.assign(new Error("reply lost"), { code: "DEADLINE" });
        onEffect?.({ resource: "session", id: remoteSessionId });
        result = { remoteSessionId };
      } else if (command === "cleanup") result = cleanup ?? { credentialCleaned: true, temporaryDataCleaned: true };
      else if (command === "metrics") result = { nativeRawBytesReserved: 10, teacherWsUtf8BytesReserved: 20 };
      else result = { confirmed: true };
      await afterRequest?.(command, result, { onEffect, native, ledger });
      return result;
    },
    async stop() { calls.push({ operation: "stop-child" }); return { confirmed: true, exitCode: 0 }; },
    terminate() { calls.push({ operation: "terminate-child" }); return { requested: true }; },
  };
  const adapter = {
    async provision(id) { calls.push({ operation: "provision", id }); return { confirmed: true }; },
    async revoke(id) { calls.push({ operation: "revoke", id }); return adapterCleanup ?? { confirmed: true }; },
    async activationCleanup(id) { calls.push({ operation: "activation-cleanup", id }); return { confirmed: true }; },
    async dispose() { calls.push({ operation: "dispose-adapter" }); return { confirmed: true }; },
  };
  const configuration = { clientModule: "synthetic-module-not-imported", clientHash: "c".repeat(64), imageHash: "d".repeat(64) };
  const options = { profile, ledger, configuration,
    deadline: createDeadline({ totalMs: 2000, cleanupMs: 500 }),
    createAdapter: async () => { calls.push({ operation: "create-adapter" }); return adapter; },
    nativeFactory: callback => { calls.push({ operation: "start-child" }); onEffect = callback; return native; },
    workload: workload ?? (async supplied => {
      calls.push({ operation: "workload" });
      assert.equal(supplied.students, 2);
      assert.equal(supplied.remoteSessionId, remoteSessionId);
      return { runnerCompleted: true, productGatesPass: true, cleanup: { complete: true } };
    }),
  };
  return { profile, ledger, native, adapter, calls, installationId, remoteSessionId, options };
}

test("default CLI and executeCommand plan have no adapter/native/workload effects", async () => {
  let effects = 0;
  assert.deepEqual(parseArguments([]), { command: "plan", students: 30 });
  const result = await executeCommand(parseArguments([]), { createAdapter: () => { effects += 1; }, nativeFactory: () => { effects += 1; }, workload: () => { effects += 1; } });
  assert.equal(result.productionEffects, "NONE");
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.productionExecution, "NOT_EXECUTED");
  assert.equal(effects, 0);
  assert.deepEqual(plan().profile.stages, [1, 4, 5, 10, 20, 30]);
});

test("production entry requires separate command, manifest and authorization; arbitrary overrides are rejected", () => {
  for (const args of [["execute-production"], ["execute-production", "--manifest", "x"], ["plan", "--origin", CANONICAL_ORIGIN],
    ["plan", "--students", "31"], ["loopback-smoke", "--manifest", "x", "--students", "Infinity"],
    ["loopback-smoke", "--manifest", "x", "--teachers", "2"], ["soak"]]) assert.throws(() => parseArguments(args));
});

test("successful orchestration uses exact owned IDs, closes before revoke and cleans every local resource", async () => {
  const f = fixture();
  const report = await supervise(f.options);
  assert.equal(report.overall, "PASS");
  assert.equal(report.cleanupComplete, true);
  assert.equal(report.productionExecution, undefined);
  const names = f.calls.map(row => row.operation);
  assert.equal(names.filter(name => name === "enroll").length, 1);
  assert.equal(names.filter(name => name === "create").length, 1);
  assert.ok(names.indexOf("close") < names.indexOf("revoke"));
  assert.equal(f.calls.find(row => row.operation === "close").id, f.remoteSessionId);
  assert.equal(f.calls.find(row => row.operation === "revoke").id, f.installationId);
  assert.equal(f.calls.find(row => row.operation === "provision").id, f.calls.find(row => row.operation === "activation-cleanup").id);
  assert.ok(names.indexOf("cleanup") < names.indexOf("stop-child"));
  assert.ok(names.includes("dispose-adapter"));
});

test("a provisioning INSERT that commits after exact DELETE cannot be reported cleaned", async () => {
  const f = fixture({ effectiveUrl: CANONICAL_ORIGIN });
  const profile = validateProfile({ mode: "production", students: 2, runId: f.profile.runId });
  const effects = [];
  let activationExists = false, insertHash, commitInsert;
  const confirmed = changes => ({ code: 0, signal: null, stdout: JSON.stringify([{ success: true, meta: { changes } }]) });
  const pendingInsert = new Promise(resolve => {
    commitInsert = () => { activationExists = true; effects.push("insert-committed"); resolve(confirmed(1)); };
  });
  const adapter = createProductionAdapter({ execute: async args => {
    const sql = args.at(-1);
    if (sql.startsWith("INSERT")) {
      insertHash = sql.match(/VALUES \('([a-f0-9]{64})'/)?.[1];
      effects.push("insert-dispatched");
      return pendingInsert;
    }
    assert.equal(sql, `DELETE FROM activation_codes WHERE code_hash = '${insertHash}'`);
    assert.equal(activationExists, false);
    effects.push("delete-confirmed-absent");
    return confirmed(0);
  } });
  const report = await supervise({ ...f.options, profile, createAdapter: async () => adapter,
    deadline: createDeadline({ totalMs: 2000, cleanupMs: 1900 }) });
  assert.deepEqual(effects, ["insert-dispatched", "delete-confirmed-absent"]);
  assert.equal(report.overall, "FAIL");
  assert.equal(report.failureCode, "DEADLINE");
  assert.equal(report.cleanupDisposition, "CLEANUP_INCOMPLETE");
  assert.equal(report.cleanupComplete, false);
  assert.deepEqual(report.unresolved, ["activation"]);
  assert.equal(report.resources.activation.cleanup, "EFFECT_UNKNOWN");
  assert.equal(report.resources.activation.cleanupCode, "CREATE_OUTCOME_UNKNOWN");
  assert.equal(f.calls.some(row => ["enroll", "create", "workload"].includes(row.operation)), false);
  commitInsert();
  await pendingInsert;
  assert.equal(activationExists, true);
  assert.equal(f.ledger.publicReport().cleanupComplete, false);
  assert.deepEqual(effects, ["insert-dispatched", "delete-confirmed-absent", "insert-committed"]);
});

test("a lost provisioning response remains unknown after successful best-effort cleanup", async () => {
  const f = fixture({ effectiveUrl: CANONICAL_ORIGIN });
  const profile = validateProfile({ mode: "production", students: 2, runId: f.profile.runId });
  const effects = [];
  let commitRemoteInsert, activationExists = false, insertHash;
  const adapter = createProductionAdapter({ execute: async args => {
    const sql = args.at(-1);
    if (sql.startsWith("INSERT")) {
      insertHash = sql.match(/VALUES \('([a-f0-9]{64})'/)?.[1];
      effects.push("insert-response-lost");
      commitRemoteInsert = () => { activationExists = true; effects.push("remote-insert-committed"); };
      // The client/child is already done; the remote effect is still unknown.
      return { code: 0, signal: null, stdout: "" };
    }
    assert.equal(sql, `DELETE FROM activation_codes WHERE code_hash = '${insertHash}'`);
    effects.push("delete-confirmed-absent");
    return { code: 0, signal: null, stdout: JSON.stringify([{ success: true, meta: { changes: 0 } }]) };
  } });
  const report = await supervise({ ...f.options, profile, createAdapter: async () => adapter });
  assert.deepEqual(effects, ["insert-response-lost", "delete-confirmed-absent"]);
  assert.equal(report.cleanupComplete, false);
  assert.equal(report.resources.activation.state, "EFFECT_UNKNOWN");
  assert.equal(report.resources.activation.cleanup, "EFFECT_UNKNOWN");
  assert.equal(report.resources.activation.cleanupCode, "CREATE_OUTCOME_UNKNOWN");
  assert.equal(report.overall, "FAIL");
  assert.equal(f.calls.some(row => ["enroll", "create", "workload"].includes(row.operation)), false);
  commitRemoteInsert();
  assert.equal(activationExists, true);
  assert.equal(f.ledger.publicReport().cleanupComplete, false);
  assert.equal(effects.filter(value => value.startsWith("insert-")).length, 1);
});

test("native effective URL mismatch is rejected before provision, enrollment or workload", async () => {
  const f = fixture({ effectiveUrl: CANONICAL_ORIGIN });
  const report = await supervise(f.options);
  assert.equal(report.overall, "FAIL");
  for (const operation of ["provision", "enroll", "create", "workload"]) assert.equal(f.calls.some(row => row.operation === operation), false);
  assert.ok(f.calls.some(row => row.operation === "stop-child"));
  assert.ok(f.calls.some(row => row.operation === "dispose-adapter"));
});

test("lost enrollment reply forbids retry and unknown installation is never scanned or revoked", async () => {
  const f = fixture({ lostReply: "enroll" });
  const report = await supervise(f.options);
  assert.equal(report.resources.installation.state, "EFFECT_UNKNOWN");
  assert.ok(report.unresolved.includes("installation"));
  assert.equal(report.cleanupDisposition, "CLEANUP_INCOMPLETE");
  assert.equal(f.calls.filter(row => row.operation === "enroll").length, 1);
  assert.equal(f.calls.some(row => ["create", "workload", "revoke", "scan"].includes(row.operation)), false);
  assert.equal(report.overall, "FAIL");
});

test("lost Session create reply stops workload, retains unknown Session and only revokes known installation", async () => {
  const f = fixture({ lostReply: "create" });
  const report = await supervise(f.options);
  assert.equal(report.resources.session.state, "EFFECT_UNKNOWN");
  assert.ok(report.unresolved.includes("session"));
  assert.equal(f.calls.filter(row => row.operation === "create").length, 1);
  assert.equal(f.calls.some(row => ["workload", "close", "scan"].includes(row.operation)), false);
  assert.equal(f.calls.find(row => row.operation === "revoke").id, f.installationId);
  assert.equal(report.overall, "FAIL");
});

test("credential cleanup failure cannot be hidden by successful workload", async () => {
  const f = fixture({ cleanup: { credentialCleaned: false, temporaryDataCleaned: true } });
  const report = await supervise(f.options);
  assert.equal(report.workloadPassed, true);
  assert.equal(report.overall, "FAIL");
  assert.ok(report.unresolved.includes("credential"));
});

test("resolved but unconfirmed cleanup cannot be marked confirmed", async () => {
  const f = fixture({ adapterCleanup: { confirmed: false } });
  const report = await supervise(f.options);
  assert.equal(report.workloadPassed, true);
  assert.equal(report.overall, "FAIL");
  assert.ok(report.unresolved.includes("installation"));
});

function assertLedgerFailure(report, calls) {
  assert.equal(report.overall, "FAIL");
  assert.equal(report.failureCode, "LEDGER_UPDATE_FAILED");
  assert.equal(report.ledgerPersistence, "FAILED");
  assert.equal(report.cleanupDisposition, "CLEANUP_INCOMPLETE");
  assert.equal(report.cleanupComplete, false);
  assert.equal(report.emergencyStopRequested, true);
  assert.ok(calls.some(row => ["stop-child", "terminate-child"].includes(row.operation)));
  assert.ok(calls.some(row => row.operation === "dispose-adapter"));
  assert.equal(JSON.stringify(report).includes("PRIVATE_FILESYSTEM_FAILURE"), false);
}

test("a stopped-state persistence failure still tears down owned resources and forbids further remote effects", async () => {
  let failed = false, writesAfterFailure = 0;
  const f = fixture({ persist: state => {
    if (failed) writesAfterFailure++;
    if (state.stopped && !failed) { failed = true; throw new Error("PRIVATE_FILESYSTEM_FAILURE"); }
  } });
  const report = await supervise(f.options);
  assertLedgerFailure(report, f.calls);
  assert.equal(report.workloadPassed, true);
  assert.equal(writesAfterFailure, 0, "failed durable state is never treated as recovered by a later successful write");
  for (const operation of ["close", "revoke", "activation-cleanup"]) assert.equal(f.calls.some(row => row.operation === operation), false);
});

test("cleanup intent persistence failure prevents its remote action but cannot skip local teardown", async () => {
  const f = fixture({ persist: state => {
    if (state.resources.session.cleanup === "INTENT_RECORDED") throw new Error("PRIVATE_FILESYSTEM_FAILURE");
  } });
  const report = await supervise(f.options);
  assertLedgerFailure(report, f.calls);
  assert.equal(report.resources.session.cleanup, "NOT_EXECUTED");
  for (const operation of ["close", "revoke", "activation-cleanup"]) assert.equal(f.calls.some(row => row.operation === operation), false);
});

test("native effect confirmation persistence failure stops enrollment progression and preserves unknown ownership", async () => {
  const f = fixture({ persist: state => {
    if (state.resources.installation.state === "CONFIRMED_CREATED") throw new Error("PRIVATE_FILESYSTEM_FAILURE");
  } });
  const report = await supervise(f.options);
  assertLedgerFailure(report, f.calls);
  assert.equal(f.calls.filter(row => row.operation === "enroll").length, 1);
  assert.equal(f.ledger.exactId("installation"), null);
  assert.ok(report.unresolved.includes("installation"));
  for (const operation of ["create", "workload", "close", "revoke", "activation-cleanup"]) {
    assert.equal(f.calls.some(row => row.operation === operation), false);
  }
});

test("cleanup confirmation persistence failure retains its pending intent and blocks the next remote action", async () => {
  const f = fixture({ persist: state => {
    if (state.resources.session.cleanup === "CONFIRMED_CLEANED") throw new Error("PRIVATE_FILESYSTEM_FAILURE");
  } });
  const report = await supervise(f.options);
  assertLedgerFailure(report, f.calls);
  assert.equal(f.calls.filter(row => row.operation === "close").length, 1);
  assert.equal(report.resources.session.cleanup, "INTENT_RECORDED");
  assert.ok(report.unresolved.includes("session"));
  for (const operation of ["revoke", "activation-cleanup"]) assert.equal(f.calls.some(row => row.operation === operation), false);
});

test("close error is recorded before exact revoke and leaves Session cleanup incomplete", async () => {
  const f = fixture({ failCommand: "close" });
  const report = await supervise(f.options);
  const names = f.calls.map(row => row.operation);
  assert.ok(names.indexOf("close") < names.indexOf("revoke"));
  assert.equal(report.overall, "FAIL");
  assert.ok(report.unresolved.includes("session"));
  assert.equal(report.resources.session.cleanup, "EFFECT_UNKNOWN");
});

test("cancellation before setup has zero child, D1 and workload effects", async () => {
  const f = fixture();
  const controller = new AbortController(); controller.abort();
  const report = await supervise({ ...f.options, signal: controller.signal });
  assert.equal(report.failureCode, "CANCELLED");
  assert.equal(report.overall, "FAIL");
  assert.deepEqual(f.calls, []);
});

test("slow adapter startup disposes its early owned handle before the factory becomes ready", async () => {
  const f = fixture();
  const report = await supervise({ ...f.options,
    deadline: createDeadline({ totalMs: 150, cleanupMs: 100 }),
    createAdapter: ({ onOwned }) => {
      f.calls.push({ operation: "create-adapter" });
      onOwned({ dispose: f.adapter.dispose });
      return new Promise(() => {});
    },
  });
  assert.equal(report.overall, "FAIL");
  assert.equal(report.failureCode, "DEADLINE");
  assert.equal(f.calls.filter(row => row.operation === "dispose-adapter").length, 1);
  assert.equal(report.resources.child.cleanup, "CONFIRMED_CLEANED");
  for (const operation of ["start-child", "provision", "enroll", "create", "workload"]) {
    assert.equal(f.calls.some(row => row.operation === operation), false);
  }
});

test("exhausted total deadline still requests immediate owned teardown without new remote operations", async () => {
  let now = 0;
  const f = fixture({ afterRequest: async command => { if (command === "metrics") now = 1000; } });
  const report = await supervise({ ...f.options, deadline: createDeadline({ totalMs: 1000, cleanupMs: 100, now: () => now }) });
  const names = f.calls.map(row => row.operation);
  assert.equal(report.overall, "FAIL");
  assert.equal(report.cleanupDisposition, "CLEANUP_INCOMPLETE");
  assert.ok(names.includes("terminate-child"), "termination request is not skipped just because no wait budget remains");
  assert.ok(names.includes("dispose-adapter"), "owned loopback server still receives disposal request");
  assert.equal(names.includes("close"), false);
  assert.equal(names.includes("revoke"), false);
  assert.equal(names.includes("activation-cleanup"), false);
});

test("child crash while creating Session triggers no workload or retry and preserves unknown effect", async () => {
  const f = fixture({ failCommand: "create" });
  const report = await supervise(f.options);
  assert.equal(report.failureCode, "CHILD_CRASH");
  assert.equal(report.resources.session.state, "EFFECT_UNKNOWN");
  assert.equal(f.calls.filter(row => row.operation === "create").length, 1);
  assert.equal(f.calls.some(row => row.operation === "workload"), false);
  assert.equal(report.overall, "FAIL");
});

test("supervisor HTTP guard forces redirect rejection and rejects cross-origin before transport", async () => {
  let requests = 0;
  const f = fixture({ workload: async options => {
    await assert.rejects(async () => options.fetchImpl("https://other.invalid/"));
    await options.fetchImpl("/v1/synthetic", { redirect: "follow" });
    return { runnerCompleted: true, productGatesPass: true, cleanup: { complete: true } };
  } });
  const report = await supervise({ ...f.options, fetchImpl: async (url, init) => {
    requests += 1;
    assert.equal(url.origin + "/", f.profile.origin);
    assert.equal(init.redirect, "error");
    return new Response(null, { status: 204 });
  } });
  assert.equal(report.overall, "PASS");
  assert.equal(requests, 1);
});

function authorizationFixture() {
  const manifest = { source: { digest: "a".repeat(64) }, native: { sha256: "b".repeat(64) },
    client: { sha256: "c".repeat(64) }, image: { sha256: "d".repeat(64) },
    relaySourceDigest: "e".repeat(64), studentSourceDigest: "f".repeat(64) };
  const now = 1_800_000_000_000;
  const authorization = { schemaVersion: 1, runId: randomUUID(), students: 30, target: CANONICAL_ORIGIN,
    statement: "AUTHORIZE_ONE_PASS_B_PRODUCTION_RUN", operations: ["provision", "enroll", "create", "workload", "close", "revoke", "activation-cleanup"],
    expiresAt: now + 300000, sourceDigest: manifest.source.digest, nativeSha256: manifest.native.sha256,
    clientSha256: manifest.client.sha256, imageSha256: manifest.image.sha256,
    environment: { workerVersion: randomUUID(), deployedStudentBundleSha256: "1".repeat(64),
      workerSourceDigest: manifest.relaySourceDigest, studentSourceDigest: manifest.studentSourceDigest,
      planReviewed: true, usageReviewed: true, bindingsReviewed: true, rollbackReviewed: true,
      maintenanceWindowConfirmed: true, maintenanceWindow: "synthetic unit fixture window" },
    riskAcceptance: { sharedNat: true, localAdmission: true, globalQuota: true, rosterBearer: true, revocationExposure: true } };
  return { manifest, now, authorization };
}

test("production authorization binds scope, expiry, artifact identities and explicit risk decisions", () => {
  const { manifest, now, authorization } = authorizationFixture();
  assert.equal(validateAuthorization(authorization, manifest, now).students, 30);
  for (const patch of [{ students: 31 }, { target: "https://other.invalid/" }, { expiresAt: now },
    { nativeSha256: "0".repeat(64) }, { clientSha256: "0".repeat(64) }, { imageSha256: "0".repeat(64) },
    { sourceDigest: "0".repeat(64) }, { riskAcceptance: {} }, { environment: {} }, { statement: "PLAN_ONLY" }]) {
    assert.throws(() => validateAuthorization({ ...authorization, ...patch }, manifest, now));
  }
});

test("production authorization requires an explicit UUID and preserves its single-run identity", () => {
  const { manifest, now, authorization } = authorizationFixture();
  for (const runId of [undefined, null, 1, false, "", "not-a-uuid", [], {}, "123e4567-e89b-42d3-A456-426614174000"]) {
    const invalid = { ...authorization, runId };
    if (runId === undefined) delete invalid.runId;
    assert.throws(() => validateAuthorization(invalid, manifest, now), /AUTHORIZATION_MISMATCH/);
  }
  assert.equal(validateAuthorization(authorization, manifest, now).runId, authorization.runId);
  assert.equal(validateAuthorization(authorization, manifest, now).runId, authorization.runId);
});

test("missing source subset identities cannot satisfy authorization via undefined equality", () => {
  const { manifest, now, authorization } = authorizationFixture();
  delete manifest.relaySourceDigest;
  delete authorization.environment.workerSourceDigest;
  assert.throws(() => validateAuthorization(authorization, manifest, now));
});

function buildManifestFixture(t) {
  const directory = path.join(artifactRoot, "pass-b-manifest-tests", randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const source = sourceIdentity();
  const manifest = { schemaVersion: 1, taskBase: "7db449392ed741ab1df1b15e3cb67f02c730392f", source,
    relaySourceDigest: sha256(JSON.stringify(source.files.filter(row => row.file.startsWith("apps/relay/src/")))),
    studentSourceDigest: sha256(JSON.stringify(source.files.filter(row => row.file.startsWith("apps/student/") || row.file.startsWith("packages/")))) };
  for (const [kind, name, body] of [["native", "native.exe", Buffer.from("synthetic binary identity")],
    ["client", "client.mjs", Buffer.from("export const synthetic = true;\n")], ["image", "image.png", Buffer.alloc(1024, 11)]]) {
    const filename = path.join(directory, name);
    fs.writeFileSync(filename, body);
    manifest[kind] = { path: filename, sha256: sha256(body), ...(kind === "image" ? { bytes: body.length, mime: "image/png" } : {}) };
  }
  const filename = path.join(directory, "manifest.json");
  const write = () => fs.writeFileSync(filename, JSON.stringify(manifest));
  write();
  return { manifest, filename, write };
}

function executionAuthorizationFixture(t) {
  const f = buildManifestFixture(t);
  const { authorization } = authorizationFixture();
  Object.assign(authorization, { students: 2, expiresAt: Date.now() + 300000, sourceDigest: f.manifest.source.digest,
    nativeSha256: f.manifest.native.sha256, clientSha256: f.manifest.client.sha256, imageSha256: f.manifest.image.sha256 });
  Object.assign(authorization.environment, { workerSourceDigest: f.manifest.relaySourceDigest,
    studentSourceDigest: f.manifest.studentSourceDigest });
  const authorizationPath = path.join(path.dirname(f.filename), "authorization.json");
  const write = () => fs.writeFileSync(authorizationPath, JSON.stringify(authorization));
  write();
  return { ...f, authorization, writeAuthorization: write,
    parsed: parseArguments(["execute-production", "--manifest", f.filename, "--authorization", authorizationPath]) };
}

test("invalid production run IDs stop before adapter, native or workload construction", async t => {
  const f = executionAuthorizationFixture(t);
  let effects = 0;
  const forbidden = () => { effects++; throw new Error("FORBIDDEN_TEST_EFFECT"); };
  for (const runId of [undefined, null]) {
    if (runId === undefined) delete f.authorization.runId;
    else f.authorization.runId = runId;
    f.writeAuthorization();
    await assert.rejects(executeCommand(f.parsed, { createAdapter: forbidden, nativeFactory: forbidden, workload: forbidden }),
      /AUTHORIZATION_MISMATCH/);
  }
  assert.equal(effects, 0);
});

test("reusing a valid authorization is rejected before any second-run effects", async t => {
  const f = executionAuthorizationFixture(t);
  const runDirectory = path.join(artifactRoot, "phase16f-pass-b", f.authorization.runId);
  t.after(() => fs.rmSync(runDirectory, { recursive: true, force: true }));
  const owned = fixture({ effectiveUrl: CANONICAL_ORIGIN });
  const dependencies = { createAdapter: owned.options.createAdapter, nativeFactory: owned.options.nativeFactory,
    workload: owned.options.workload };
  const first = await executeCommand(f.parsed, dependencies);
  assert.equal(first.runId, f.authorization.runId);
  assert.equal(first.overall, "PASS");
  const effects = owned.calls.length;
  await assert.rejects(executeCommand(f.parsed, dependencies), { code: "EEXIST" });
  assert.equal(owned.calls.length, effects);
  assert.equal(owned.calls.filter(row => row.operation === "provision").length, 1);
});

test("build manifest validates exact native, Student bundle and fixture bytes", t => {
  const f = buildManifestFixture(t);
  assert.equal(readBuildManifest(f.filename).source.digest, f.manifest.source.digest);
  for (const kind of ["native", "client", "image"]) {
    const filename = f.manifest[kind].path;
    const original = fs.readFileSync(filename);
    fs.appendFileSync(filename, "changed");
    assert.throws(() => readBuildManifest(f.filename), /FILE_IDENTITY_MISMATCH/);
    fs.writeFileSync(filename, original);
  }
});

test("build manifest rejects altered source records even when digest field was copied", t => {
  const f = buildManifestFixture(t);
  f.manifest.source.files[0].sha256 = "0".repeat(64);
  f.write();
  assert.throws(() => readBuildManifest(f.filename), /SOURCE_IDENTITY_MISMATCH/);
});

test("build manifest rejects module paths escaping controlled ignored target", t => {
  const f = buildManifestFixture(t);
  f.manifest.client.path = path.resolve("apps/student/src/services/studentHttpApi.ts");
  f.manifest.client.sha256 = sha256(fs.readFileSync(f.manifest.client.path));
  f.write();
  assert.throws(() => readBuildManifest(f.filename), /PATH_ESCAPE/);
});

test("build manifest subset hashes are required and source mismatches fail closed", t => {
  const f = buildManifestFixture(t);
  delete f.manifest.studentSourceDigest;
  f.write();
  assert.throws(() => readBuildManifest(f.filename), /SOURCE_IDENTITY_MISMATCH/);
});
