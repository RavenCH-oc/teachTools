// Default/import: plan only. Production execution requires a separate explicit
// command and operator authorization bound to this run and these artifact hashes.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { validateProfile, assertNativeTarget, assertContainedPath, verifyFileIdentity, createDeadline,
  guardHttpTarget, guardWebSocketTarget, CANONICAL_ORIGIN, LIMITS, SHA256_PATTERN } from "./pass-b-safety.js";
import { RunLedger } from "./pass-b-ledger.js";
import { artifactRoot, repositoryRoot, sourceIdentity, sha256 } from "./pass-b-build.js";
import { createLoopbackAdapter, createProductionAdapter, wranglerEntry } from "./pass-b-adapters.js";
import { startNative, executeOwned, bounded, RunnerError } from "./pass-b-process.js";
import { runWorkload } from "./pass-b-workload.js";

const operations = ["provision", "enroll", "create", "workload", "close", "revoke", "activation-cleanup"];
const knownFailure = error => ["DEADLINE", "CANCELLED", "CHILD_CRASH"].includes(error?.code) ? error.code : "OPERATION_FAILED";
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;

export function parseArguments(args) {
  const command = args[0] ?? "plan";
  if (!["plan", "loopback-smoke", "execute-production"].includes(command)) throw new RunnerError("UNKNOWN_COMMAND");
  const result = { command, students: 30 };
  const allowed = command === "plan" ? ["--students"] : command === "loopback-smoke" ? ["--students", "--manifest"] : ["--manifest", "--authorization"];
  const seen = new Set();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!allowed.includes(flag) || seen.has(flag) || !value || value.startsWith("--")) throw new RunnerError("INVALID_ARGUMENTS");
    seen.add(flag);
    if (flag === "--students") { if (!/^[1-9][0-9]*$/.test(value)) throw new RunnerError("INVALID_STUDENT_COUNT"); result.students = Number(value); }
    else result[flag.slice(2)] = value;
  }
  if (command !== "plan" && !result.manifest) throw new RunnerError("BUILD_MANIFEST_REQUIRED");
  if (command === "execute-production" && !result.authorization) throw new RunnerError("EXPLICIT_AUTHORIZATION_REQUIRED");
  validateProfile({ students: result.students });
  return result;
}

export function plan(students = 30) {
  const profile = validateProfile({ students });
  return { profile, productionEffects: "NONE", executionAuthorized: false,
    admission: "All participants join/AUTH/sync in LOBBY before media-reader stages",
    productionPrerequisites: "Operator authorization, reviewed source/build identities and current environment/risk decisions required",
    productionExecution: "NOT_EXECUTED", release: "HOLD" };
}

export function validateAuthorization(value, manifest, now = Date.now()) {
  const allowed = ["schemaVersion", "runId", "students", "target", "statement", "operations", "expiresAt", "sourceDigest",
    "nativeSha256", "clientSha256", "imageSha256", "environment", "riskAcceptance"];
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key)) || value.schemaVersion !== 1
    || !Number.isInteger(value.students) || value.students < 1 || value.students > 30
    || value.statement !== "AUTHORIZE_ONE_PASS_B_PRODUCTION_RUN" || value.target !== CANONICAL_ORIGIN
    || JSON.stringify(value.operations) !== JSON.stringify(operations)
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + 60 * 60 * 1000
    || value.sourceDigest !== manifest.source.digest || value.nativeSha256 !== manifest.native.sha256
    || value.clientSha256 !== manifest.client.sha256 || value.imageSha256 !== manifest.image.sha256) throw new RunnerError("AUTHORIZATION_MISMATCH");
  const env = value.environment;
  if (!plain(env) || !/^[a-f0-9-]{36}$/.test(env.workerVersion ?? "") || !SHA256_PATTERN.test(env.deployedStudentBundleSha256 ?? "")
    || !SHA256_PATTERN.test(env.workerSourceDigest ?? "") || !SHA256_PATTERN.test(env.studentSourceDigest ?? "")
    || env.workerSourceDigest !== manifest.relaySourceDigest || env.studentSourceDigest !== manifest.studentSourceDigest
    || !["planReviewed", "usageReviewed", "bindingsReviewed", "rollbackReviewed", "maintenanceWindowConfirmed"].every(key => env[key] === true)
    || typeof env.maintenanceWindow !== "string" || env.maintenanceWindow.length < 5 || env.maintenanceWindow.length > 200
    || !["sharedNat", "localAdmission", "globalQuota", "rosterBearer", "revocationExposure"].every(key => value.riskAcceptance?.[key] === true)) throw new RunnerError("PRODUCTION_PREFLIGHT_INCOMPLETE");
  return validateProfile({ mode: "production", runId: value.runId, students: value.students, origin: value.target });
}

export function readBuildManifest(filename) {
  const resolved = assertContainedPath(artifactRoot, path.resolve(filename), { mustExist: true, kind: "file" });
  const manifest = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const current = sourceIdentity();
  if (manifest.schemaVersion !== 1 || manifest.taskBase !== "7db449392ed741ab1df1b15e3cb67f02c730392f"
    || !plain(manifest.source) || manifest.source.digest !== current.digest
    || JSON.stringify(manifest.source.files) !== JSON.stringify(current.files)
    || manifest.relaySourceDigest !== sha256(JSON.stringify(current.files.filter(row => row.file.startsWith("apps/relay/src/"))))
    || manifest.studentSourceDigest !== sha256(JSON.stringify(current.files.filter(row => row.file.startsWith("apps/student/") || row.file.startsWith("packages/"))))) throw new RunnerError("SOURCE_IDENTITY_MISMATCH");
  for (const key of ["native", "client", "image"]) verifyFileIdentity(artifactRoot, { path: manifest[key]?.path, sha256: manifest[key]?.sha256 });
  if (!manifest.native.path.endsWith(".exe") || !manifest.client.path.endsWith(".mjs")
    || manifest.image.bytes !== fs.statSync(manifest.image.path).size || manifest.image.bytes > 2 * 1024 * 1024
    || manifest.image.bytes < 1024 || manifest.image.mime !== "image/png") throw new RunnerError("ARTIFACT_PROFILE_MISMATCH");
  return manifest;
}

export function persistLedger(filename, snapshot) {
  const next = filename + ".next";
  const fd = fs.openSync(next, "wx");
  try { fs.writeFileSync(fd, JSON.stringify(snapshot, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(next, filename);
}

// Orchestration is dependency-injected for fault tests. This function never
// retries enroll/create; only native trusted IDs can confirm server resources.
export async function supervise({ profile, deadline, ledger, configuration, createAdapter, nativeFactory, workload,
  signal, fetchImpl = globalThis.fetch, webSocket = WebSocket }) {
  const workAbort = new AbortController();
  const abort = () => workAbort.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const workTimer = setTimeout(abort, deadline.remainingMs());
  let adapter, native, configured = false, workloadResult = null, failureCode = null, nativeMetrics = null;
  let adapterPromise, workloadPromise, workloadSettled = true, cleanupStarted = false;
  let emergencyStopRequested = false, lateAdapterCleanup = "NOT_NEEDED";
  let ledgerFailure = null, localTeardownConfirmed = false;
  const requireLedger = () => { if (ledgerFailure) throw ledgerFailure; };
  const writeLedger = (method, ...args) => {
    requireLedger();
    try { return ledger[method](...args); }
    catch {
      // Once an intent/confirmation cannot be recorded, no later remote action
      // is safe. Preserve a fixed failure code without exposing filesystem data.
      ledgerFailure = new RunnerError("LEDGER_UPDATE_FAILED");
      workAbort.abort();
      throw ledgerFailure;
    }
  };
  const request = (name, fields = {}, cleanup = false) => {
    requireLedger();
    if (!native) throw new RunnerError("CHILD_CRASH");
    if (!cleanup && workAbort.signal.aborted) throw new RunnerError("CANCELLED");
    return native.request(name, fields, { timeoutMs: deadline.boundedMs(45000, { cleanup }), signal: cleanup ? undefined : workAbort.signal });
  };
  const confirm = (kind, id) => {
    const row = ledger.snapshot().resources[kind];
    if (["INTENT_RECORDED", "EFFECT_UNKNOWN"].includes(row.state)) writeLedger("confirmCreated", kind, id);
    else if (row.state !== "CONFIRMED_CREATED" || ledger.exactId(kind) !== id) throw new RunnerError("UNEXPECTED_EFFECT_CONFIRMATION");
  };
  const failPending = (kind, error) => {
    if (ledger.snapshot().resources[kind].state === "INTENT_RECORDED") writeLedger("fail", kind, { unknown: true, code: knownFailure(error) });
  };
  const cleanOne = async (kind, action) => {
    const row = ledger.snapshot().resources[kind];
    if (["NOT_EXECUTED", "FAILED"].includes(row.state)) return;
    const id = ledger.exactId(kind);
    if (!id) { if (row.state === "EFFECT_UNKNOWN") writeLedger("cleanupFailed", kind, "NO_EXACT_ID"); return; }
    writeLedger("beginCleanup", kind, id);
    try {
      const result = await bounded(() => { requireLedger(); return action(id); }, deadline.boundedMs(45000, { cleanup: true }), "CLEANUP_DEADLINE");
      if (result?.confirmed !== true) throw new RunnerError("CLEANUP_UNCONFIRMED");
      writeLedger("confirmCleaned", kind, id);
    } catch {
      requireLedger();
      writeLedger("cleanupFailed", kind, "CLEANUP_FAILED", { unknown: true });
    }
  };
  try {
    deadline.assertWork();
    if (workAbort.signal.aborted) throw new RunnerError("CANCELLED");
    writeLedger("begin", "child", profile.runId);
    adapterPromise = Promise.resolve().then(() => createAdapter({ onOwned: owned => { adapter = owned; } }));
    adapterPromise.then(value => {
      adapter = value;
      if (cleanupStarted) {
        lateAdapterCleanup = "REQUESTED_UNCONFIRMED";
        Promise.resolve().then(() => value.dispose()).then(result => {
          lateAdapterCleanup = result?.confirmed === true ? "CONFIRMED" : "FAILED";
        }, () => { lateAdapterCleanup = "FAILED"; });
        // The already-unknown child ledger remains incomplete even if a late
        // best-effort dispose finishes after the report's deadline.
      }
    }, () => {});
    adapter = await bounded(() => adapterPromise, deadline.boundedMs(45000));
    native = nativeFactory(event => {
      if (!["installation", "session"].includes(event.resource)) throw new RunnerError("INVALID_EFFECT_KIND");
      confirm(event.resource, event.id);
    });
    confirm("child", profile.runId);
    writeLedger("begin", "temporaryData", profile.runId);
    const ready = await request("configure", { config: { ...configuration, remainingMs: Math.floor(deadline.remainingMs({ cleanup: true })), cleanupReserveMs: profile.cleanupMs } });
    assertNativeTarget(profile, ready.effectiveUrl);
    if (ready.rawLimit !== LIMITS.rawBytes || ready.wireLimit !== LIMITS.teacherUtf8Bytes) throw new RunnerError("NATIVE_BUDGET_MISMATCH");
    configured = true; confirm("temporaryData", profile.runId);
    const activation = randomBytes(32).toString("base64url");
    const activationHash = sha256(activation);
    writeLedger("begin", "activation", activationHash);
    await bounded(() => adapter.provision(activationHash), deadline.boundedMs(45000));
    confirm("activation", activationHash);
    writeLedger("begin", "credential", profile.runId);
    writeLedger("begin", "installation");
    const enrolled = await request("enroll", { activationCode: activation });
    confirm("installation", enrolled.installationId); confirm("credential", profile.runId);
    writeLedger("begin", "session");
    const session = await request("create");
    confirm("session", session.remoteSessionId);
    await request("ready");
    const safeFetch = (input, init) => {
      requireLedger();
      if (workAbort.signal.aborted) throw new RunnerError("CANCELLED");
      deadline.assertWork();
      return fetchImpl(guardHttpTarget(profile, input), { ...init, redirect: "error" });
    };
    class BoundSocket extends webSocket {
      constructor(url, options) { super(guardWebSocketTarget(profile, url), { ...options, followRedirects: false, maxPayload: 65536 }); }
    }
    workloadSettled = false;
    workloadPromise = Promise.resolve().then(() => workload({ origin: profile.origin, remoteSessionId: session.remoteSessionId, students: profile.students,
      clientModule: configuration.clientModule, clientModuleHash: configuration.clientHash, imageHash: configuration.imageHash,
      control: (name, extra) => request(name, extra), fetchImpl: safeFetch, WebSocketImpl: BoundSocket,
      signal: workAbort.signal, remainingMs: () => deadline.remainingMs() }));
    workloadPromise.then(value => { workloadResult = value; workloadSettled = true; }, () => { workloadSettled = true; });
    workloadResult = await bounded(() => workloadPromise, deadline.boundedMs(LIMITS.wallMs));
    nativeMetrics = await request("metrics");
  } catch (error) { failureCode = ledgerFailure?.code ?? knownFailure(error); }
  finally {
    clearTimeout(workTimer); signal?.removeEventListener("abort", abort); workAbort.abort();
    cleanupStarted = true;
    try {
      if (workloadPromise && !workloadSettled) {
        try { await bounded(() => workloadPromise, deadline.boundedMs(2500, { cleanup: true })); } catch { failureCode ??= "CANCELLED"; }
      }
      for (const kind of ["child", "temporaryData", "activation", "installation", "session", "credential"]) failPending(kind, { code: failureCode });
      writeLedger("stopWork");
      // Workload owns its sockets; native close happens while installation is ACTIVE.
      await cleanOne("session", id => request("close", { remoteSessionId: id }, true));
      await cleanOne("installation", id => adapter.revoke(id));
      await cleanOne("activation", id => adapter.activationCleanup(id));
      let nativeCleanup;
      const nativeCleanupOnce = async () => {
        if (!nativeCleanup) nativeCleanup = request("cleanup", {}, true);
        return nativeCleanup;
      };
      await cleanOne("credential", async () => {
        if (!configured || (await nativeCleanupOnce()).credentialCleaned !== true) throw new RunnerError("CLEANUP_FAILED");
        return { confirmed: true };
      });
      await cleanOne("temporaryData", async () => {
        if ((await nativeCleanupOnce()).temporaryDataCleaned !== true) throw new RunnerError("CLEANUP_FAILED");
        return { confirmed: true };
      });
      await cleanOne("child", async () => {
        if (native) {
          const stopped = await native.stop(deadline.boundedMs(10000, { cleanup: true }));
          if (!stopped.confirmed) throw new RunnerError("CHILD_STOP_UNCONFIRMED");
        }
        if (!adapter && adapterPromise) throw new RunnerError("ADAPTER_START_UNCONFIRMED");
        if (adapter && (await adapter.dispose())?.confirmed !== true) throw new RunnerError("ADAPTER_STOP_UNCONFIRMED");
        localTeardownConfirmed = true;
        return { confirmed: true };
      });
    } catch (error) { failureCode = ledgerFailure?.code ?? knownFailure(error); }
    finally {
      // Local ownership, not a writable ledger, controls this last-resort
      // teardown. In particular, disk/rename failures cannot skip it.
      if (!localTeardownConfirmed && (native || adapter || adapterPromise)) {
        emergencyStopRequested = true;
        if (native) {
          try {
            const waitMs = deadline.boundedMs(10000, { cleanup: true });
            const stopped = await bounded(() => native.stop(waitMs), waitMs, "CHILD_STOP_UNCONFIRMED");
            if (stopped?.confirmed !== true) throw new RunnerError("CHILD_STOP_UNCONFIRMED");
          } catch {
            try { native.terminate(); } catch { failureCode ??= "CHILD_CRASH"; }
          }
        }
        if (adapter) {
          lateAdapterCleanup = "REQUESTED_UNCONFIRMED";
          let disposal;
          try { disposal = Promise.resolve(adapter.dispose()); }
          catch { lateAdapterCleanup = "FAILED"; }
          if (disposal) {
            const settled = disposal.then(result => {
              lateAdapterCleanup = result?.confirmed === true ? "CONFIRMED" : "FAILED";
            }, () => { lateAdapterCleanup = "FAILED"; });
            try { await bounded(() => settled, deadline.boundedMs(10000, { cleanup: true })); }
            catch { /* The request and its failure remain visible without extending the deadline. */ }
          }
        }
      }
    }
  }
  const runnerCompleted = failureCode === null && workloadSettled && workloadResult?.runnerCompleted === true && workloadResult?.cleanup?.complete === true;
  return { ...ledger.publicReport({ runnerCompleted, workloadPassed: workloadResult?.productGatesPass === true }),
    failureCode, elapsedMs: deadline.elapsedMs(), workload: workloadResult, nativeMetrics,
    ledgerPersistence: ledgerFailure ? "FAILED" : "CONFIRMED",
    ...(ledgerFailure ? { overall: "FAIL", cleanupComplete: false, cleanupDisposition: "CLEANUP_INCOMPLETE" } : {}),
    emergencyStopRequested, lateAdapterCleanup,
    syntheticProtocolEvidence: true, mobileRender: "NOT_EXECUTED", installedQA: "NOT_EXECUTED" };
}

export async function executeCommand(parsed, dependencies = {}) {
  if (parsed.command === "plan") return plan(parsed.students);
  // One monotonic clock covers local copying, relay/native setup, provisioning,
  // workload and cleanup. Preparation builds are a separate explicit command.
  const deadline = createDeadline();
  const manifest = readBuildManifest(parsed.manifest);
  let profile, authorization;
  if (parsed.command === "execute-production") {
    const authPath = assertContainedPath(artifactRoot, path.resolve(parsed.authorization), { mustExist: true, kind: "file" });
    authorization = JSON.parse(fs.readFileSync(authPath, "utf8"));
    profile = validateAuthorization(authorization, manifest);
  } else profile = validateProfile({ mode: "loopback", students: parsed.students });
  const runRoot = path.join(artifactRoot, "phase16f-pass-b");
  assertContainedPath(artifactRoot, runRoot); fs.mkdirSync(runRoot, { recursive: true });
  const directory = assertContainedPath(runRoot, path.join(runRoot, profile.runId));
  fs.mkdirSync(directory); // Existing run identity is never reused/overwritten.
  const clientModule = path.join(directory, "student-http-client.mjs"), imagePath = path.join(directory, "image.png");
  fs.copyFileSync(manifest.client.path, clientModule, fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(manifest.image.path, imagePath, fs.constants.COPYFILE_EXCL);
  verifyFileIdentity(runRoot, { path: clientModule, sha256: manifest.client.sha256 });
  verifyFileIdentity(runRoot, { path: imagePath, sha256: manifest.image.sha256 });
  const ledger = new RunLedger(profile.runId, { persist: snapshot => persistLedger(path.join(directory, "operation-ledger.json"), snapshot) });
  const configuration = { runId: profile.runId, mode: profile.mode, origin: profile.origin, students: profile.students,
    teachers: 1, classrooms: 1, runDirectory: directory, imagePath, imageHash: manifest.image.sha256,
    clientModule, clientHash: manifest.client.sha256, nativeHash: manifest.native.sha256 };
  const ownedChildren = new Set();
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort();
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  let report;
  try {
    report = await supervise({ profile, deadline, ledger, configuration, signal: cancellation.signal,
      createAdapter: profile.mode === "loopback" ? createLoopbackAdapter : () => createProductionAdapter({ execute: args =>
        executeOwned(process.execPath, [wranglerEntry(), ...args], { cwd: path.join(repositoryRoot, "apps/relay"),
          timeoutMs: deadline.boundedMs(40000, { cleanup: ledger.snapshot().stopped }), onChild: child => {
            ownedChildren.add(child); child.once("exit", () => ownedChildren.delete(child));
          } }) }),
      nativeFactory: onEffect => startNative(manifest.native.path, profile.origin, onEffect), workload: runWorkload,
      ...dependencies });
  } finally {
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    for (const child of ownedChildren) child.kill();
  }
  const publicReport = { schemaVersion: 1, taskBase: manifest.taskBase, testedHead: manifest.testedHead,
    sourceDigest: manifest.source.digest, runnerSource: manifest.source.files.filter(row => /pass[-_]b|remote_capacity_metrics|remote_control\.rs/.test(row.file)),
    nativeSha256: manifest.native.sha256, studentHttpBundleSha256: manifest.client.sha256, fixtureSha256: manifest.image.sha256,
    toolchain: manifest.toolchain, profile, productionExecution: profile.mode === "production" ? "EXECUTED" : "NOT_EXECUTED",
    deploymentIdentity: authorization ? { workerVersion: authorization.environment.workerVersion,
      workerSourceDigest: authorization.environment.workerSourceDigest, studentSourceDigest: authorization.environment.studentSourceDigest,
      deployedStudentBundleSha256: authorization.environment.deployedStudentBundleSha256, source: "OPERATOR_CONFIRMED" } : "NOT_EXECUTED",
    operatorEnvironmentClaims: profile.mode === "production" ? "Operator-supplied, not independent live verification" : "NOT_APPLICABLE", ...report };
  const reportPath = assertContainedPath(runRoot, path.join(directory, "report.json"));
  fs.writeFileSync(reportPath, JSON.stringify(publicReport, null, 2) + "\n", { flag: "wx" });
  return { runId: profile.runId, overall: report.overall, cleanupDisposition: report.cleanupDisposition,
    reportPath, productionExecution: publicReport.productionExecution, release: "HOLD" };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  Promise.resolve().then(() => executeCommand(parseArguments(process.argv.slice(2)))).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result.overall && result.overall !== "PASS") process.exitCode = 1;
  }).catch(() => { process.stderr.write("PASS_B_STOPPED_BEFORE_COMPLETION\n"); process.exitCode = 1; });
}
