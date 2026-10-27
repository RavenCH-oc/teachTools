// Preparation only: builds local test artifacts, never starts the runner or a relay.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID, randomFillSync } from "node:crypto";
import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertContainedPath } from "./pass-b-safety.js";

export const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const artifactRoot = path.join(repositoryRoot, "apps/teacher/src-tauri/target");
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const hashFile = file => sha256(fs.readFileSync(file));

export function sourceIdentity(root = repositoryRoot) {
  const names = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--",
    "apps", "packages", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"], { cwd: root, encoding: "utf8" })
    .split("\0").filter(Boolean).filter(name => !name.endsWith(".md")).sort();
  const records = [...new Set(names)].map(file => ({ file, sha256: hashFile(path.join(root, file)) }));
  return { digest: sha256(JSON.stringify(records)), files: records };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, body) {
  const tag = Buffer.from(type), chunk = Buffer.alloc(body.length + 12);
  chunk.writeUInt32BE(body.length); tag.copy(chunk, 4); body.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([tag, body])), body.length + 8); return chunk;
}
export function createImageFixture() {
  const width = 724, height = 723, row = width * 4 + 1;
  const pixels = Buffer.alloc(row * height); randomFillSync(pixels);
  for (let y = 0; y < height; y++) pixels[y * row] = 0;
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels, { level: 0 })), pngChunk("IEND", Buffer.alloc(0))]);
}

export async function buildArtifacts() {
  const before = sourceIdentity();
  const directory = path.join(artifactRoot, "phase16f-pass-b-build", randomUUID());
  assertContainedPath(artifactRoot, directory);
  fs.mkdirSync(directory, { recursive: true });
  const student = path.join(repositoryRoot, "apps/student");
  const require = createRequire(path.join(student, "package.json"));
  const viteEntry = path.join(path.dirname(require.resolve("vite/package.json")), "dist/node/index.js");
  const { build } = await import(pathToFileURL(viteEntry).href);
  await build({ configFile: false, root: student, logLevel: "silent", build: {
    outDir: directory, emptyOutDir: false, minify: false,
    lib: { entry: path.join(student, "src/services/studentHttpApi.ts"), formats: ["es"], fileName: () => "student-http-client.mjs" },
  } });
  const manifestPath = path.join(repositoryRoot, "apps/teacher/src-tauri/Cargo.toml");
  const cargoArgs = ["test", "--manifest-path", manifestPath, "--lib", "--no-run", "--message-format=json"];
  const output = execFileSync("cargo", cargoArgs, { cwd: repositoryRoot, encoding: "utf8", windowsHide: true,
    timeout: 20 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const executables = output.split(/\r?\n/).filter(line => line.startsWith("{")).map(line => JSON.parse(line))
    .filter(row => row.reason === "compiler-artifact" && row.target?.name === "teacher_lib" && row.profile?.test && row.executable)
    .map(row => row.executable);
  if (executables.length !== 1) throw new Error("NATIVE_BUILD_IDENTITY_UNAVAILABLE");
  const nativePath = path.join(directory, "teacher-pass-b-test.exe");
  fs.copyFileSync(executables[0], nativePath);
  const imagePath = path.join(directory, "image.png"); fs.writeFileSync(imagePath, createImageFixture(), { flag: "wx" });
  const identity = sourceIdentity();
  if (identity.digest !== before.digest || JSON.stringify(identity.files) !== JSON.stringify(before.files)) {
    throw new Error("SOURCE_CHANGED_DURING_BUILD");
  }
  const manifest = { schemaVersion: 1, taskBase: "7db449392ed741ab1df1b15e3cb67f02c730392f",
    testedHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim(),
    source: identity, createdAt: new Date().toISOString(),
    relaySourceDigest: sha256(JSON.stringify(identity.files.filter(row => row.file.startsWith("apps/relay/src/")))),
    studentSourceDigest: sha256(JSON.stringify(identity.files.filter(row => row.file.startsWith("apps/student/") || row.file.startsWith("packages/")))),
    native: { path: nativePath, sha256: hashFile(nativePath) },
    client: { path: path.join(directory, "student-http-client.mjs"), sha256: hashFile(path.join(directory, "student-http-client.mjs")) },
    image: { path: imagePath, sha256: hashFile(imagePath), bytes: fs.statSync(imagePath).size, mime: "image/png" },
    toolchain: { node: process.version, cargo: execFileSync("cargo", ["--version"], { encoding: "utf8" }).trim(),
      rustc: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim() },
    nativeBuildCommand: ["cargo", ...cargoArgs], studentBuild: "Vite library build of current studentHttpApi.ts, no policy substitution",
  };
  const outputPath = path.join(directory, "build-manifest.json");
  fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return outputPath;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 2) { process.stderr.write("BUILD_ARGUMENTS_REJECTED\n"); process.exitCode = 1; }
  else buildArtifacts().then(file => process.stdout.write(JSON.stringify({ buildManifest: file, productionActions: "NONE" }) + "\n"))
    .catch(() => { process.stderr.write("PASS_B_ARTIFACT_BUILD_FAILED\n"); process.exitCode = 1; });
}
