import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const relayDirectory = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const lifetimeMs = 10 * 60 * 1000;
const failureMessage = "無法確認 production D1 寫入成功，未輸出 activation code。請檢查 Wrangler 登入、D1 權限與連線，或參考 README 的手動方式。\n";

function executeWrangler(args) {
  const entry = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: relayDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });
}

// Tests must supply an executor; importing this module never invokes Wrangler.
export function runActivationCreate({ execute, args = [], now = Date.now,
  stdout = text => process.stdout.write(text), stderr = text => process.stderr.write(text) } = {}) {
  if (args.length) {
    stderr("用法：pnpm --filter @classtools/relay run activation:create:prod（不接受額外參數）。\n");
    return 1;
  }
  try {
    if (typeof execute !== "function") throw new Error("Executor required");
    const code = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(code, "utf8").digest("hex");
    const expires = now() + lifetimeMs;
    if (!Number.isSafeInteger(expires) || expires < lifetimeMs) throw new Error("Invalid clock");
    const sql = "INSERT INTO activation_codes(code_hash, expires_at, consumed_at) VALUES ('" + hash + "', " + expires + ", NULL)";
    const result = execute(["d1", "execute", "INSTALLATIONS", "--remote", "--json",
      "--config", join(relayDirectory, "wrangler.jsonc"), "--command", sql]);
    if (result.error || result.signal || result.status !== 0) throw new Error("Wrangler failed");
    const response = JSON.parse(result.stdout);
    if (!Array.isArray(response) || response.length !== 1 || response[0]?.success !== true
      || response[0]?.meta?.changes !== 1) throw new Error("D1 insert not confirmed");
    stdout(code + "\n");
    return 0;
  } catch {
    // Never echo child output, SQL or exceptions: only the hash reaches Wrangler.
    stderr(failureMessage);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runActivationCreate({ execute: executeWrangler, args: process.argv.slice(2) });
}
