import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
const student=fileURLToPath(new URL("../../student/",import.meta.url));
const require=createRequire(path.join(student,"package.json"));
const {build}=await import(pathToFileURL(path.join(path.dirname(require.resolve("vite/package.json")),"dist/node/index.js")).href);
const baseline=process.argv.includes("--baseline");
const canonical="c5285196a08e412732eb2246efd78e3c9644d15a";
const original=baseline?execFileSync("git",["show",canonical+":apps/student/src/services/studentHttpApi.ts"],{cwd:student,encoding:"utf8"}):null;
await build({plugins:baseline?[{name:"canonical-http-policy",enforce:"pre",transform(code,id){if(id.replaceAll("\\","/").endsWith("/src/services/studentHttpApi.ts"))return original;}}]:[],configFile:false,root:student,logLevel:"warn",build:{outDir:path.resolve(student,"../teacher/src-tauri/target/phase16f-client"),
 emptyOutDir:false,lib:{entry:path.join(student,"src/services/studentHttpApi.ts"),formats:["es"],fileName:()=>baseline?"student-http-baseline.mjs":"student-http-client.mjs"},minify:false}});
console.log("Actual Student HTTP client bundled for local synthetic harness; no deployment.");
