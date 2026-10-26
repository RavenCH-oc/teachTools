import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { serverConfig, localOperator } from "./capacity-local-server.js";

// No Miniflare, listener, process, real secret, D1 or file write is started here.
const root = path.resolve("synthetic-repo");
const target = path.join(root, "apps/teacher/src-tauri/target");
const io = overrides => ({ root, canonical: value => path.resolve(value), exists: () => true,
  read: () => "export const synthetic = true;", ...overrides });

test("direct server preflight has fixed loopback port and bounded lifetime", () => {
  const config = serverConfig([], io());
  assert.equal(config.host, "127.0.0.1"); assert.equal(config.port, 8793);
  assert.equal(config.hardStopMs, 1800000); assert.equal(config.modules.length, 5);
  assert.match(config.sourceDigest, /^[a-f0-9]{64}$/);
});

test("direct server rejects bind, port, production and extra arguments", () => {
  for (const args of [["--host", "0.0.0.0"], ["--port", "443"], ["https://production.invalid"], ["--snapshot"], ["--snapshot", target, "--remote"]]) {
    assert.throws(() => serverConfig(args, io()), /Only an optional local/);
  }
});

test("snapshot must be a strict descendant of ignored target", () => {
  for (const directory of [root, target, target + "-sibling", path.join(target, "..", "escape")]) {
    assert.throws(() => serverConfig(["--snapshot", directory], io()), /Snapshot must stay inside ignored target/);
  }
  assert.equal(serverConfig(["--snapshot", path.join(target, "frozen")], io()).modules.length, 5);
});

test("snapshot realpath and individual module realpaths cannot escape", () => {
  const snapshot = path.join(target, "frozen");
  assert.throws(() => serverConfig(["--snapshot", snapshot], io({ canonical: value => value === snapshot ? root : path.resolve(value) })), /Snapshot must stay/);
  assert.throws(() => serverConfig(["--snapshot", snapshot], io({ canonical: value => value.endsWith("worker.js") ? path.join(root, "worker.js") : path.resolve(value) })), /Module must stay/);
});

test("frozen module set must be self contained and cannot import a sibling file", () => {
  assert.throws(() => serverConfig([], io({ read: () => 'import { x } from "./other.js";' })), /Snapshot must contain/);
  assert.throws(() => serverConfig([], io({ read: () => 'import { x } from "./../worker.js";' })), /Snapshot must contain/);
  const config = serverConfig([], io({ exists: () => false, read: () => "export const beforeAdmission = true;" }));
  assert.equal(config.modules.length, 4);
});

test("local operator parser reads only its exact binding and never reads management credentials", () => {
  assert.equal(localOperator('IGNORED=synthetic\nOPERATOR_TOKEN="local-synthetic-only"\nOTHER=unused'), "local-synthetic-only");
  for (const value of ["CLOUDFLARE_API_TOKEN=unused", "OPERATOR_TOKEN=", "OPERATOR_TOKEN=two words"]) {
    assert.throws(() => localOperator(value), /operator binding/);
  }
});
