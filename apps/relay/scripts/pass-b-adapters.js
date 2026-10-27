// Explicitly constructed adapters. Importing this module performs no I/O or effects.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const relay = path.join(root, "apps/relay");
const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function d1Statement(operation, id, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(now + 600000)) throw new Error("INVALID_D1_CLOCK");
  if (operation === "provision" && hashPattern.test(id)) return {
    sql: "INSERT INTO activation_codes(code_hash, expires_at, consumed_at) VALUES ('" + id + "', " + (now + 600000) + ", NULL)", expectedChanges: 1,
  };
  if (operation === "activationCleanup" && hashPattern.test(id)) return {
    sql: "DELETE FROM activation_codes WHERE code_hash = '" + id + "'", expectedChanges: null,
  };
  if (operation === "revoke" && idPattern.test(id)) return {
    sql: "UPDATE installations SET status = 'REVOKED', revoked_at = " + now + " WHERE id = '" + id + "' AND status = 'ACTIVE'", expectedChanges: 1,
  };
  throw new Error("INVALID_EXACT_D1_OPERATION");
}

export function createProductionAdapter({ execute, now = Date.now } = {}) {
  if (typeof execute !== "function") throw new Error("EXPLICIT_D1_EXECUTOR_REQUIRED");
  async function operation(kind, id) {
    const statement = d1Statement(kind, id, now());
    // Only non-secret hash/ID is in argv. Raw activation/installation credentials never are.
    const result = await execute(["d1", "execute", "INSTALLATIONS", "--remote", "--json", "--config",
      path.join(relay, "wrangler.jsonc"), "--command", statement.sql]);
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch { throw new Error("D1_EFFECT_UNCONFIRMED"); }
    if (result.code !== 0 || result.signal || !Array.isArray(parsed) || parsed.length !== 1 || parsed[0]?.success !== true
      || !Number.isInteger(parsed[0]?.meta?.changes) || (statement.expectedChanges !== null && parsed[0].meta.changes !== statement.expectedChanges)
      || (kind === "activationCleanup" && ![0, 1].includes(parsed[0].meta.changes))) throw new Error("D1_EFFECT_UNCONFIRMED");
    return { confirmed: true, disposition: kind === "revoke" ? "REVOKED_ROW_RETAINED" : kind === "activationCleanup" ? "ABSENT" : "INSERTED" };
  }
  return { provision: id => operation("provision", id), revoke: id => operation("revoke", id),
    activationCleanup: id => operation("activationCleanup", id), dispose: async () => ({ confirmed: true }) };
}

export function wranglerEntry() {
  const require = createRequire(path.join(relay, "package.json"));
  return path.join(path.dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
}

export async function createLoopbackAdapter({ onOwned = () => {} } = {}) {
  const require = createRequire(path.join(relay, "package.json"));
  const wrangler = path.dirname(require.resolve("wrangler/package.json"));
  const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = require(require.resolve("miniflare", { paths: [wrangler] }));
  const modules = ["worker.js", "http_relay.js", "contract.js", "lifecycle.js", "admission.js"].map(name => ({
    type: "ESModule", path: path.join(relay, "src", name), contents: fs.readFileSync(path.join(relay, "src", name), "utf8"),
  }));
  const mf = new Miniflare(convertV4MiniflareOptions({ modules, compatibilityDate: "2026-09-24", host: "127.0.0.1", port: 0,
    cf: false, log: new Log(LogLevel.NONE), unsafeDirectSockets: [{ host: "127.0.0.1", port: 8794, proxy: false }],
    outboundService: () => new Response("Outbound disabled", { status: 403 }),
    d1Databases: { INSTALLATIONS: randomUUID() }, d1Persist: false, durableObjectsPersist: false,
    durableObjects: { CLASSROOM_SESSION: { className: "ClassroomSession", useSQLite: true } },
    bindings: { CONNECT_TICKET_TTL_SECONDS: "60", RELAY_MAX_LIFETIME_SECONDS: "43200" },
    serviceBindings: { ASSETS: () => new Response("Local synthetic protocol verification", { headers: { "content-type": "text/plain" } }) },
  }));
  let disposal;
  const dispose = () => {
    disposal ??= mf.dispose().then(() => ({ confirmed: true }));
    return disposal;
  };
  // Publish the owned local teardown handle before awaiting readiness/schema.
  // A failed or slow startup can therefore still be stopped by the supervisor.
  onOwned({ dispose });
  try {
    const db = await mf.getD1Database("INSTALLATIONS");
    const schema = fs.readFileSync(path.join(relay, "migrations/0001_installations.sql"), "utf8");
    for (const statement of schema.split(";").filter(value => value.trim())) await db.prepare(statement).run();
    const effective = await mf.unsafeGetDirectURL();
    if (effective.href !== "http://127.0.0.1:8794/") throw new Error("LOOPBACK_TARGET_MISMATCH");
    async function operation(kind, id) {
      const statement = d1Statement(kind, id);
      const result = await db.prepare(statement.sql).run();
      if (!result.success || (statement.expectedChanges !== null && result.meta.changes !== statement.expectedChanges)) throw new Error("LOCAL_D1_UNCONFIRMED");
      return { confirmed: true };
    }
    return { provision: id => operation("provision", id), revoke: id => operation("revoke", id),
      activationCleanup: id => operation("activationCleanup", id), dispose };
  } catch { await dispose(); throw new Error("LOOPBACK_SETUP_FAILED"); }
}
