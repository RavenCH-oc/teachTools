// Local-only direct workerd server for isolating Wrangler's development proxy.
// Never load wrangler deployment configuration or expose a non-loopback listener.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const mandatoryModules = ["worker.js", "http_relay.js", "contract.js", "lifecycle.js"];
const allowedModules = [...mandatoryModules, "admission.js"];
const inside = (parent, child) => child !== parent && !path.relative(parent, child).startsWith(".." + path.sep)
  && path.relative(parent, child) !== ".." && !path.isAbsolute(path.relative(parent, child));

export function serverConfig(args, io = {}) {
  const root = io.root ?? repoRoot;
  const canonical = io.canonical ?? fs.realpathSync;
  const exists = io.exists ?? fs.existsSync;
  const read = io.read ?? (file => fs.readFileSync(file, "utf8"));
  if (args.length !== 0 && !(args.length === 2 && args[0] === "--snapshot")) {
    throw new Error("Only an optional local --snapshot directory is accepted");
  }
  const target = canonical(path.join(root, "apps/teacher/src-tauri/target"));
  const directory = canonical(args.length ? path.resolve(root, args[1]) : path.join(root, "apps/relay/src"));
  if (args.length && !inside(target, directory)) throw new Error("Snapshot must stay inside ignored target");
  const names = [...mandatoryModules];
  if (exists(path.join(directory, "admission.js"))) names.push("admission.js");
  const modules = names.map(name => {
    const modulePath = canonical(path.join(directory, name));
    if (!inside(directory, modulePath)) throw new Error("Module must stay inside its selected source directory");
    const contents = read(modulePath);
    for (const match of contents.matchAll(/from\s+["'](\.\/[^"']+)["']/g)) {
      if (!names.includes(match[1].slice(2))) throw new Error("Snapshot must contain every allowlisted relay module");
    }
    if (!allowedModules.includes(name)) throw new Error("Unexpected local relay module");
    return { type: "ESModule", path: modulePath, contents };
  });
  const source = modules.map(module => ({ file: path.basename(module.path), sha256: createHash("sha256").update(module.contents).digest("hex") }))
    .sort((a, b) => a.file.localeCompare(b.file));
  return { root, modules, sourceDigest: createHash("sha256").update(JSON.stringify(source)).digest("hex"),
    host: "127.0.0.1", port: 8793, hardStopMs: 30 * 60 * 1000 };
}

export function localOperator(text) {
  const line = text.split(/\r?\n/).find(value => /^\s*OPERATOR_TOKEN\s*=/.test(value));
  if (!line) throw new Error("Local operator binding is required");
  let value = line.slice(line.indexOf("=") + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  if (!value || /[\s#]/.test(value)) throw new Error("Invalid local operator binding");
  return value;
}

export async function startServer(args) {
  const config = serverConfig(args);
  const operator = localOperator(fs.readFileSync(path.join(config.root, "apps/relay/.dev.vars"), "utf8"));
  const require = createRequire(new URL("../package.json", import.meta.url));
  const wranglerDirectory = path.dirname(require.resolve("wrangler/package.json"));
  const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = require(require.resolve("miniflare", { paths: [wranglerDirectory] }));
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: config.modules, compatibilityDate: "2026-09-24",
    host: config.host, port: 0, cf: false, log: new Log(LogLevel.NONE),
    unsafeDirectSockets: [{ host: config.host, port: config.port, proxy: false }],
    outboundService: () => new Response("Local harness outbound requests are disabled", { status: 403 }),
    d1Databases: { INSTALLATIONS: randomUUID() }, d1Persist: false, durableObjectsPersist: false,
    durableObjects: { CLASSROOM_SESSION: { className: "ClassroomSession", useSQLite: true } },
    bindings: { OPERATOR_TOKEN: operator, CONNECT_TICKET_TTL_SECONDS: "60", RELAY_MAX_LIFETIME_SECONDS: "43200" },
    serviceBindings: { ASSETS: () => new Response("<!doctype html><title>Local synthetic harness</title>",
      { headers: { "content-type": "text/html" } }) },
  }));
  let timer; let closing = false;
  const shutdown = async code => {
    if (closing) return;
    closing = true; clearTimeout(timer);
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    await mf.dispose(); process.exitCode = code;
  };
  const interrupt = () => { void shutdown(0); };
  try {
    const db = await mf.getD1Database("INSTALLATIONS");
    const schema = fs.readFileSync(path.join(config.root, "apps/relay/migrations/0001_installations.sql"), "utf8");
    for (const statement of schema.split(";").filter(value => value.trim())) await db.prepare(statement).run();
    const origin = await mf.unsafeGetDirectURL();
    if (origin.protocol !== "http:" || origin.hostname !== config.host || origin.port !== String(config.port)) {
      throw new Error("Direct listener escaped the loopback boundary");
    }
    process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
    timer = setTimeout(() => { void shutdown(2); }, config.hardStopMs);
    process.stdout.write(JSON.stringify({ ready: origin.origin, transport: "direct-workerd", bindings: "local-ephemeral",
      sourceDigest: config.sourceDigest }) + "\n");
    return { shutdown };
  } catch {
    await shutdown(1); throw new Error("Local capacity server failed to start");
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  startServer(process.argv.slice(2)).catch(() => {
    process.stderr.write("LOCAL_CAPACITY_SERVER_START_FAILED\n"); process.exitCode = 1;
  });
}
