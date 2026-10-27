// This ledger contains only run IDs, exact non-secret resource IDs and states.
// The caller supplies durable persistence; intent is persisted before effects.
import { validateRunId, SHA256_PATTERN, RUN_ID_PATTERN, SafetyError } from "./pass-b-safety.js";

const KINDS = Object.freeze(["activation", "installation", "session", "credential", "child", "temporaryData"]);
const STATES = new Set(["NOT_EXECUTED", "INTENT_RECORDED", "CONFIRMED_CREATED", "FAILED", "EFFECT_UNKNOWN"]);
const CLEANUPS = new Set(["NOT_EXECUTED", "INTENT_RECORDED", "CONFIRMED_CLEANED", "FAILED", "EFFECT_UNKNOWN"]);
const CODES = new Set(["OPERATION_FAILED", "RESPONSE_LOST", "DEADLINE", "CANCELLED", "CHILD_CRASH",
  "INVALID_RESPONSE", "CLEANUP_FAILED", "CLEANUP_DEADLINE", "NO_EXACT_ID", "RECOVERED_PENDING_INTENT"]);
const clone = value => structuredClone(value);
function fail(code) { throw new SafetyError(code); }
function resourceId(kind, id, runId) {
  if (typeof id !== "string") fail("INVALID_RESOURCE_ID");
  const valid = kind === "activation" ? SHA256_PATTERN.test(id)
    : kind === "installation" ? RUN_ID_PATTERN.test(id)
      : kind === "session" ? /^[A-Za-z0-9_-]{32}$/.test(id) : id === runId;
  if (!valid) fail("INVALID_RESOURCE_ID");
  return id;
}
function errorCode(code = "OPERATION_FAILED") {
  if (!CODES.has(code)) fail("INVALID_LEDGER_ERROR_CODE");
  return code;
}

export class RunLedger {
  #state;
  #persist;
  constructor(runId, { persist = () => {} } = {}) {
    validateRunId(runId);
    if (typeof persist !== "function") fail("INVALID_LEDGER_PERSISTENCE");
    this.#persist = persist;
    this.#state = { version: 1, runId, stopped: false, sequence: 0,
      resources: Object.fromEntries(KINDS.map(kind => [kind, { state: "NOT_EXECUTED", cleanup: "NOT_EXECUTED" }])) };
  }
  #row(kind) {
    if (!KINDS.includes(kind)) fail("INVALID_RESOURCE_KIND");
    return this.#state.resources[kind];
  }
  #change(change) {
    const next = clone(this.#state);
    change(next);
    next.sequence += 1;
    // Never expose the mutable state to an adapter/persistence implementation.
    const result = this.#persist(clone(next));
    if (result && typeof result.then === "function") fail("ASYNC_LEDGER_PERSISTENCE_FORBIDDEN");
    this.#state = next;
    return this.snapshot();
  }
  begin(kind, intendedId) {
    const row = this.#row(kind);
    if (this.#state.stopped) fail("RUN_STOPPED");
    if (row.state !== "NOT_EXECUTED") fail("RESOURCE_RETRY_FORBIDDEN");
    if (intendedId !== undefined) resourceId(kind, intendedId, this.#state.runId);
    if (["installation", "session"].includes(kind) && intendedId !== undefined) fail("SERVER_GENERATED_ID_REQUIRED");
    if (kind === "installation" && this.#row("activation").state !== "CONFIRMED_CREATED") fail("ACTIVATION_NOT_CONFIRMED");
    if (kind === "session" && this.#row("installation").state !== "CONFIRMED_CREATED") fail("INSTALLATION_NOT_CONFIRMED");
    return this.#change(next => { next.resources[kind] = { state: "INTENT_RECORDED", cleanup: "NOT_EXECUTED",
      ...(intendedId === undefined ? {} : { intendedId }) }; });
  }
  confirmCreated(kind, id) {
    const row = this.#row(kind);
    resourceId(kind, id, this.#state.runId);
    if (row.state === "CONFIRMED_CREATED" && row.id === id) return this.snapshot();
    if (!["INTENT_RECORDED", "EFFECT_UNKNOWN"].includes(row.state)) fail("NO_PENDING_CREATE");
    if (row.intendedId !== undefined && row.intendedId !== id) fail("RESOURCE_OWNERSHIP_MISMATCH");
    // A correlated, trustworthy late reply can recover an exact ID for cleanup.
    // Keep the prior error code and stopped run; this never resumes workload.
    return this.#change(next => { Object.assign(next.resources[kind], { state: "CONFIRMED_CREATED", id }); });
  }
  fail(kind, { unknown = false, code = "OPERATION_FAILED" } = {}) {
    const row = this.#row(kind);
    if (row.state !== "INTENT_RECORDED") fail("NO_PENDING_CREATE");
    errorCode(code);
    return this.#change(next => {
      Object.assign(next.resources[kind], { state: unknown ? "EFFECT_UNKNOWN" : "FAILED", code });
      next.stopped = true;
    });
  }
  stopWork() { return this.#change(next => { next.stopped = true; }); }
  exactId(kind) {
    const row = this.#row(kind);
    // Only client-selected activation hashes/local run IDs survive a lost reply.
    return row.id ?? row.intendedId ?? null;
  }
  beginCleanup(kind, id) {
    const row = this.#row(kind);
    resourceId(kind, id, this.#state.runId);
    if (this.exactId(kind) !== id) fail("RESOURCE_OWNERSHIP_MISMATCH");
    if (!["CONFIRMED_CREATED", "EFFECT_UNKNOWN", "INTENT_RECORDED"].includes(row.state)) fail("NO_OWNED_RESOURCE");
    if (row.cleanup !== "NOT_EXECUTED") fail("CLEANUP_RETRY_FORBIDDEN");
    if (kind === "installation") {
      const session = this.#row("session");
      if (["INTENT_RECORDED", "CONFIRMED_CREATED"].includes(session.state)
        && ["NOT_EXECUTED", "INTENT_RECORDED"].includes(session.cleanup)) fail("CLOSE_BEFORE_REVOKE_REQUIRED");
    }
    return this.#change(next => { next.stopped = true; next.resources[kind].cleanup = "INTENT_RECORDED"; });
  }
  confirmCleaned(kind, id) {
    const row = this.#row(kind);
    if (row.cleanup !== "INTENT_RECORDED") fail("NO_PENDING_CLEANUP");
    if (this.exactId(kind) !== id) fail("RESOURCE_OWNERSHIP_MISMATCH");
    return this.#change(next => { next.resources[kind].cleanup = "CONFIRMED_CLEANED"; });
  }
  cleanupFailed(kind, code = "CLEANUP_FAILED", { unknown = false } = {}) {
    const row = this.#row(kind);
    errorCode(code);
    if (row.cleanup !== "INTENT_RECORDED"
      && !(code === "NO_EXACT_ID" && row.state === "EFFECT_UNKNOWN" && row.cleanup === "NOT_EXECUTED")) fail("NO_PENDING_CLEANUP");
    return this.#change(next => {
      next.stopped = true;
      Object.assign(next.resources[kind], { cleanup: unknown ? "EFFECT_UNKNOWN" : "FAILED", cleanupCode: code });
    });
  }
  snapshot() { return clone(this.#state); }
  publicReport({ workloadPassed = false, runnerCompleted = false } = {}) {
    const resources = Object.fromEntries(KINDS.map(kind => {
      const { state, cleanup, code, cleanupCode } = this.#row(kind);
      return [kind, { state, cleanup, ...(code ? { code } : {}), ...(cleanupCode ? { cleanupCode } : {}) }];
    }));
    const unresolved = KINDS.filter(kind => {
      const row = this.#row(kind);
      // Unknown server-generated effects cannot be cured by unrelated cleanup.
      return row.state === "INTENT_RECORDED" || (row.state === "EFFECT_UNKNOWN" && !this.exactId(kind))
        || (["CONFIRMED_CREATED", "EFFECT_UNKNOWN"].includes(row.state) && row.cleanup !== "CONFIRMED_CLEANED");
    });
    const cleanupComplete = unresolved.length === 0;
    const operationFailed = KINDS.some(kind => this.#row(kind).code
      || ["FAILED", "EFFECT_UNKNOWN", "INTENT_RECORDED"].includes(this.#row(kind).state));
    return { runId: this.#state.runId, runnerCompleted: runnerCompleted === true,
      workloadPassed: workloadPassed === true, cleanupComplete,
      cleanupDisposition: cleanupComplete ? "CONFIRMED_CLEANED" : "CLEANUP_INCOMPLETE",
      overall: runnerCompleted === true && workloadPassed === true && cleanupComplete && !operationFailed ? "PASS" : "FAIL",
      resources, unresolved };
  }
  static recover(snapshot, { persist = () => {} } = {}) {
    if (!snapshot || snapshot.version !== 1 || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0
      || typeof snapshot.stopped !== "boolean" || Object.keys(snapshot).some(key => !["version", "runId", "stopped", "sequence", "resources"].includes(key))) fail("INVALID_LEDGER_SNAPSHOT");
    const ledger = new RunLedger(snapshot.runId, { persist });
    if (!snapshot.resources || Object.keys(snapshot.resources).sort().join() !== [...KINDS].sort().join()) fail("INVALID_LEDGER_SNAPSHOT");
    for (const kind of KINDS) {
      const row = snapshot.resources[kind];
      if (!row || !STATES.has(row.state) || !CLEANUPS.has(row.cleanup)
        || Object.keys(row).some(key => !["state", "cleanup", "intendedId", "id", "code", "cleanupCode"].includes(key))) fail("INVALID_LEDGER_SNAPSHOT");
      for (const key of ["id", "intendedId"]) if (row[key] !== undefined) resourceId(kind, row[key], snapshot.runId);
      if (row.code) errorCode(row.code);
      if (row.cleanupCode) errorCode(row.cleanupCode);
      if (row.id && row.intendedId && row.id !== row.intendedId) fail("RESOURCE_OWNERSHIP_MISMATCH");
      if (["installation", "session"].includes(kind) && row.intendedId) fail("SERVER_GENERATED_ID_REQUIRED");
      if (row.state === "CONFIRMED_CREATED" && !row.id) fail("INVALID_LEDGER_SNAPSHOT");
    }
    ledger.#state = clone(snapshot);
    ledger.#change(next => {
      next.stopped = true;
      for (const row of Object.values(next.resources)) {
        if (row.state === "INTENT_RECORDED") Object.assign(row, { state: "EFFECT_UNKNOWN", code: "RECOVERED_PENDING_INTENT" });
        if (row.cleanup === "INTENT_RECORDED") Object.assign(row, { cleanup: "EFFECT_UNKNOWN", cleanupCode: "RECOVERED_PENDING_INTENT" });
      }
    });
    return ledger;
  }
}
