# Phase 16F Pass A — audit and bounded local verification

**2026-10-26 update:** [Pass A2 local remediation and measurements](phase16f-pass-a2.md) supersede the four targeted blocker dispositions below. This file preserves the original Pass A evidence and historical status. Phase 16F remains incomplete; production/installed verification and distributed-availability acceptance remain open.

Date: 2026-10-25. Repository: `I:\ChatGPT\teachTools`.
Canonical baseline: `c5285196a08e412732eb2246efd78e3c9644d15a` on `main`; origin/main remains the same. Findings and measurements apply to that baseline **plus the uncommitted Pass A patch**, not to HEAD or the currently deployed Worker.

## Decision

**Pass A: PARTIAL / HOLD. Phase 16F is not complete.** Forty Students is a planning target, not accepted product capacity.

- Security and admission blockers remain even if a bounded local performance sample passes.
- Production capacity, actual Cloudflare usage/cost, mobile Blob/decode/render, final Remote RC, and installed Human QA are not verified by this pass.
- No production deployment/load/D1 write, account-plan change, R2, Range, migration, dependency change, installer build, stage, commit, or push was performed.
- The only production access was the read-only Wrangler deployment metadata query described in the cost audit.

Evidence maps and exact focused commands:

- [Relay security audit](phase16f-relay-audit.md)
- [Native / Student authority audit](phase16f-auth-audit.md)
- [Cost, platform limits, deployment version and release audit](phase16f-cost-and-release.md)

## Findings and bounded fixes

| Finding | Pass A disposition |
| --- | --- |
| Enrollment consume/installation creation was non-atomic | Fixed with the existing D1 batch/conditional write contract; no schema change. |
| Async Worker route rejections escaped the sanitized boundary | Fixed by awaiting routes inside the existing catch boundary. |
| Non-owner close returned 403 but could close owner's sockets | Fixed by rejecting before close side effects. |
| JOIN / HTTP body await allowed stale-generation/pending admission races | Fixed by reading current state and checking bounds after the await. |
| Fifth simultaneous ordinary image received 429 and no automatic Student retry | Measured at baseline. Narrow Remote media GET retry added; comparison below. |
| Four maximum PDF streams disrupt realtime / re-auth | **FAIL_BLOCKER**. Directed after-first-byte probe: 40 ACK timeouts, answered count 0, detail 39.482 s. See corrected C4 evidence below. |
| Public untrusted requests lack sustained admission/rate/cost protection | **FAIL_BLOCKER** for unrestricted public availability. A bounded per-object array is not an Internet-wide rate budget. |
| Forged HTTP participant identity can occupy another participant's quota before Rust authenticates | **FAIL_BLOCKER**, reproduced; no unauthorized data was returned, but availability isolation fails. |
| Invalid roster joins fill the 128-entry/120-second recovery cache | **FAIL_BLOCKER**, reproduced by the existing test. A legitimate join can be refused. |
| Installation revocation does not terminate existing sessions/tickets immediately | Exposure must be accepted or changed: issued ticket up to its remaining 60 seconds; existing Session up to remaining 12 hours under current configuration. |
| Seat/name roster matching and possession bearer authentication | Material admission limitation requiring explicit pilot acceptance; not strong human identity. |
| Final Remote build does not fail closed on missing/wrong compiled URL | **FAIL_BLOCKER** for final RC; minimal wrapper/validation plan is in the release audit. |

Security regression: identical 13 local fixtures before patch **6 PASS / 7 FAIL**, after patch **13 PASS**. Relay security + existing HTTP/lifecycle + Operator tests: **49 PASS**. No response from Rust was replaced with a DO-generated domain ACK.

The media retry changes only Remote `SESSION_ASSET_GET` on HTTP 429 plus the existing bounded JSON `REMOTE_SERVICE_UNAVAILABLE` error. At most 16 retries after the initial attempt, 30-second monotonic retry-admission budget, 250 ms exponential ceiling capped at 2 seconds with 50–100% jitter. Abort cancels waits. It does not replay mutations, successful/partial bodies, auth failures, other status codes, detail GETs or LAN requests. It does not promise a 30-second entire PDF timeout.

Limits remain: 64 KiB envelope, 32 KiB raw chunks, four credits / 128 KiB window, four media streams per Session and one per participant. Native changes outside the fixture are `#[cfg(test)]` diagnostics only. Test-only Mutex/OnceLock protect bounded counters; they do not share a SQLite connection or add production concurrency.

## Isolation and measurement method

- Temporary Classroom database and app-data directory; synthetic roster, true/false/Essay answers and Peer Review activity only.
- Native uses the existing **test-only** Credential Manager target `teacher.Classroom.RemoteInstallation.Phase16CTest`, snapshots/restores only that target. Production target and real app data are untouched.
- Wrangler/D1 use the existing migration in isolated ignored `target/phase16f-wrangler`, local port 8792. No migration file was created or changed.
- Native verifies both configured and **effective** service URL are loopback HTTP before credential/network operations. JS rejects non-loopback/cross-origin requests and redirects.
- Student HTTP code is bundled directly from the current `studentHttpApi.ts`; the harness adds no hidden retry. WSS clients are **protocol synthetic clients**, performing real roster join, Rust AUTH and personalized sync before mutation. They are not browser UI or the complete production Student transport implementation.
- A 29-minute JS hard stop, 30-minute native supervisor, maximum 40 Students, cumulative raw HTTP CHUNK pre-send ceiling 1 GiB (including JSON, conservatively bounding media) and a separate Teacher-to-relay UTF-8 envelope ceiling 2 GiB bound each run. Conservative counters include canceled/retried chunks; they are not TLS/billing bytes. The timers cover the workload, not the preceding build/setup. Child-process Drop kills/waits on failure. Control RPCs have a 45-second limit.
- Report paths are restricted to ignored target output. Fixtures, result JSON and logs are not Git content. No bearer, activation code, installation credential or domain body is written to the report. Native test metrics parse outgoing JSON and add CPU overhead; they are not production instrumentation. Panic does not guarantee asynchronous Session close, and credential-restore I/O errors are not asserted by the existing restore guard; neither is a production-cleanup guarantee.
- Safety preflight tests use injected mock process/stdin/fetch/timers, not production or local D1: **14 PASS**.

Predetermined gates: text ACK p95 ≤2 seconds; ACK under media p95 ≤3 seconds; ordinary 2 MiB image at least 95% ≤30 seconds and all ≤60 seconds; no integrity/auth/ACK/data-loss failure; resources return to baseline. Percentiles use nearest-rank `ceil(p*n)-1`; all timing is monotonic within the reporting process. Small samples are shown raw and do not support a statistically stable p95 claim.

A first setup attempt failed because the synthetic Essay remained LOCKED and occupied the existing one-active-question slot. The fixture now reveals that question before opening the Quiz; no domain rule changed. This invalid setup produced **no valid capacity result**. Harness execution success by itself is not a gate PASS: the final report records explicit gates and exits nonzero on gate failure.

### Environment

Same Windows PC: AMD Ryzen 7 9850X3D, installed RAM 100,299,796,480 bytes; Node v24.19.0, pnpm 9.15.0, rustc/cargo 1.97.1, debug/test native build. Teacher, local Wrangler and all protocol clients share this host and loopback. Native test heartbeat is explicitly 20 seconds for these measurements, matching production; other historical tests retain their test timing. WAN uplink and mobile/browser decoding are **NOT_VERIFIED**.

Synthetic valid PNG: 2,094,909 bytes (approximately 2 MiB), same file/hash reused before and after. Valid PDF: 104,857,600 bytes. SHA-256 and exact image/png / application/pdf MIME are checked on successful full reads. Node streaming/hash throughput does not measure the Student's full-Blob allocation and rendering.

## Local results

### Same-condition policy comparison (five joined clients)

Both policies used the same synthetic file, native binary, security-patched local Worker, simultaneous five Quiz submitters, thresholds and harness. Only the HTTP policy bundle differed: canonical baseline versus current working source. The initial earlier probe was diagnostic; these matched comparison runs supply the before/after evidence.

| Concurrent image readers | Before first / eventual | After first / eventual | Before successful max s | After max s | After media ACK p95 s |
| --- | --- | --- | ---: | ---: | ---: |
| 1 | 1/1 / 1/1 | 1/1 / 1/1 | 0.333 | 0.330 | 0.094 |
| 4 | 4/4 / 4/4 | 4/4 / 4/4 | 1.061 | 1.054 | 1.057 |
| 5 | 4/5 / 4/5 | 4/5 / 5/5 | 1.111 | 1.389 | 1.038 |

Before: fifth read returned 429 in 42.234 ms, with no automatic retry; image gate FAIL_BLOCKER and process exit 101. After: that reader observed [429,200], completed in 1.389 s; comparison gates PASS. No stream/window cap was raised.

### C1 — three single-read samples with 40 authenticated clients present

First measured request is not a guaranteed cold disk/cache sample: import/hash/setup already accessed the file. Small n=3 is raw evidence, not a reliable distribution estimate.

| Sample | Quiz ACK ms | Detail full ms | Image headers ms | First byte ms | Full body ms | SHA-256 / MIME |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 492.550 | 43.226 | 53.462 | 56.227 | 294.643 | PASS / image/png |
| 2 | 21.788 | 24.147 | 54.606 | 55.939 | 315.697 | PASS / image/png |
| 3 | 17.589 | 22.490 | 49.283 | 50.602 | 296.609 | PASS / image/png |

Corresponding native image-request set: auth 5.462–5.899 ms; total authenticated read/hash 37.498–38.303 ms; accumulated CREDIT wait 218.199–238.392 ms. Read-minus-auth is approximately 32 ms, combining asset authorization/DB/file/SHA rather than isolating each component. These request-set ranges are not paired to a fabricated cross-process absolute timestamp.

### C2/C3 — staged ordinary images, all 40 clients send Quiz submissions per level

| Media readers | First success | Eventual success | Image p50 s | p95 s | Max s | Quiz ACK p95 s |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 1 | 1/1 | 1/1 | 0.674 | 0.674 | 0.674 | 0.394 |
| 4 | 4/4 | 4/4 | 0.988 | 1.046 | 1.046 | 1.355 |
| 5 | 4/5 | 5/5 | 1.027 | 1.721 | 1.721 | 1.353 |
| 10 | 4/10 | 10/10 | 2.341 | 3.086 | 3.086 | 1.365 |
| 20 | 4/20 | 20/20 | 3.658 | 5.997 | 6.382 | 0.377 |
| 40 | 4/40 | 40/40 | 6.248 | 11.521 | 11.855 | 0.448 |

Separate all-40 text submission burst: 40/40 accepted; authoritative answered count 40; ACK p50 0.182 s, p95 0.347 s, max 0.366 s. No harness-only retries are counted as Student behavior.

### C4 — original large PDF measurements (ACK coverage corrected below)

**The original C4 ACK bursts were sent 400 ms after request start, before first media bytes. Their low latency does not establish under-stream responsiveness. The later directed four-stream failure supersedes any capacity-PASS interpretation of this table.**

| Case | Full-body seconds | Aggregate raw MiB/s | Quiz ACK p95 seconds | Detail | Integrity / MIME |
| --- | ---: | ---: | ---: | --- | --- |
| One 100 MiB PDF | 13.721 | 7.288 | 0.358 | 3/3 HTTP 200 | SHA-256 PASS / application/pdf |
| Four 100 MiB PDFs | 48.390 / 48.316 / 48.251 / 48.351 | 8.266 | 0.367 | 3/3 HTTP 200 | All SHA-256 PASS / application/pdf |

Single PDF headers/first byte: 1.464 / 1.466 s. Four-PDF aggregate throughput divides 400 MiB by slowest completion, not a per-client throughput claim. This was **local only**, after earlier gates and RAM check passed.

Cancellation occurred after 8,192 client-delivered bytes. Replacement image completed in 0.294 s; permits/waiters returned to zero. Delivered cancellation bytes are an observation, not a hard propagation bound. Local Wrangler emitted “Uncaught Error: Network connection lost.” near intentional cancellations; source already catches pipeTo failure. Platform log count/root-cause attribution and production log charges are not proven by zero client WS errors, so do not claim an error-free relay log.

### C5 — 40-client bounded soak and recovery

600.318 seconds, 39 rounds; 49 successful sparse reads and 9 intentional cancels. A deliberate replacement Teacher connection then native recovery produced two generation transitions; all 40 protocol clients regained AUTH/sync in 2.816 s. Expected offline notifications: 40; unexpected offline: 0; WS errors: 0; domain error arrays empty. Final ping latency p50 0.003 s, p95 14.691 s, max 48.197 s; these span the whole run, not only idle soak. Pending pings at final sample: 0.

Native maximum pending requests 7 (includes detail; not media concurrency); final media/read permits in use = 0/0, CREDIT waiters = 0. Native send-await accumulated 1605.122 ms, max 11.637 ms; this excludes diagnostic pre-send JSON parse and does not measure a kernel send queue. The original harness recorded 27 gates PASS, but its C4 ACK timing was insufficient; this is **not** an overall capacity PASS. The directed C4 failure below is authoritative for release readiness. Missing end-to-end cases are listed below instead of silently labeled PASS.


### Directed C4 follow-up — confirmed FAIL_BLOCKER; load stopped

The whole-run ping tail (p95 14.691 seconds, max 48.197 seconds) exposed the early-ACK coverage gap. Two additional bounded local diagnostic runs were used, not a retry-to-green loop: one PDF after its first byte, then the already-tested four-stream level after **all four** first-byte signals. The second run failed; no further load or architecture tuning followed.

| Directed case | ACK trigger | 40 Quiz results | Detail elapsed | PDF integrity | Decision |
| --- | --- | --- | --- | --- | --- |
| One 100 MiB PDF | First body bytes received | 40/40 accepted; p95 0.398 s | 0.153 s | SHA-256/MIME PASS; 14.326 s | Scoped PASS |
| Four 100 MiB PDFs | All four delivered first body bytes | **0/40 ACKs within 10 s**; every timeout right-censored at 10 s, not measured completion latency; authoritative answered count **0** at probe | **39.482 s** | Four complete files PASS; 48.119–48.243 s | **FAIL_BLOCKER** |

Four-stream Node event-loop delay: p95 8.603 ms, max 10.876 ms. Native read/hash max was approximately 1.56 seconds and send-await max 23.780 ms. These do not explain a single 40-second Node stall or native file-read call; they do not identify the exact remaining delay segment.

The four-stream probe observed 40 unplanned REAUTH_REQUIRED events; native emitted 80 participant_authenticated frames while the synthetic clients had accepted only their initial 40 AUTH results at report time. Only 54 pongs had returned, so their low percentile is subject to outstanding-response/survivorship bias. Local Wrangler repeatedly reported `Can't call WebSocket send() after close()`, at `rejectSocket` → the PENDING_AUTH branch of `webSocketMessage`. No reload/rebuild message appeared in the captured diagnostic Wrangler output. Do not suppress these logs and call the functional issue fixed.

Evidence supports a media-time re-auth/routing failure, not a conclusion that FixedLengthStream or Cloudflare itself is the cause. Correlated generation/re-auth/queue timestamps are still needed to distinguish DO reconstruction, native scheduling and transport output/input gating. The manual protocol clients do not implement the full browser reconnect/submission-resume policy; zero authoritative answers here does not prove previously committed data was lost, but the latency/admission gate plainly failed.

The native presence timeout is 7 seconds. If delay occurs before native heartbeat processing, Teacher roster presence may expire; if it occurs only on pong delivery, native presence may remain valid. This probe did not continuously sample Teacher presence. `unexpectedOffline=0` only counts the explicit transport event, not a full presence/UI guarantee.

Each additional run remained local and below its enforced byte/time cap. Diagnostic raw HTTP CHUNK totals were 104,857,948 and 419,430,748 bytes respectively. These are separate diagnostic workloads, not ordinary-classroom or production cost evidence.

The final harness now waits for first-byte signals in its default C4 path too, checks literal ACK acceptance, and records ERROR envelopes. Mock preflight safety tests still pass. The full matrix was **not** rerun after this test-harness correction; the preserved directed failure remains open. No stream/window cap, presence semantics or runtime scheduling was changed to mask it.

Reproduce only within the documented local isolation using `CLASSROOM_CAPACITY_MODE=stream-probe` or `stream-probe-four`, with separate report paths. Do not run additional load merely to obtain a pass.

### Memory, byte bounds and evidence files

Native process sampled every 10 seconds (67 samples): working set 22.10–422.52 MiB, private bytes maximum 407.79 MiB. Sampling began after startup and can miss a shorter peak; it is not installed-Teacher or DO memory. Native returned to approximately 22 MiB after large transfers. Node protocol-client RSS at soak checkpoints ranged 97.02–99.04 MiB; it streams hashes and does not allocate browser Blobs.

Full-run conservative raw HTTP CHUNK bytes (media plus small JSON): **723,847,590**, below 1 GiB. Teacher→relay UTF-8 pre-send bytes: **971,755,770**, below 2 GiB. Budget stop false. These totals include canceled work and retries, not framing/TLS or complete Cloudflare billable counters. Cost calibration is in the linked cost audit.

Ignored local evidence: `apps/teacher/src-tauri/target/phase16f-results/{compare-baseline.json,compare-current.json,full.json,native-memory.json,source-manifest.json}`. The matched baseline intentionally fails the fifth-reader gate; current probe and full run exit successfully. Raw fixtures and logs are not committed.


The Phase 16E production observations remain separate: 20 MiB PNG 25.647 seconds, 100 MiB PDF 125.041 seconds, mobile 4G approximately 2 MiB image around 10 seconds perceived load. They are not rerun or reclassified as classroom-scale acceptance here.


### Interpretation and unverified recovery cases

Native auth/read/hash time is measured inside the same Rust request; read_total includes auth, so these values must not be summed as independent stages. Header/first-byte/full-body are measured in the Node client. CREDIT wait includes scheduling/relay/emulator time and does not isolate network RTT. Native send await is measured separately; no kernel socket-queue depth or production DO CPU/heap was available. Browser full-Blob construction, decode/paint, rendering and perceived mobile time remain NOT_VERIFIED.

The fixed 128 KiB per-stream credit window gives a conditional window/RTT throughput ceiling, not a measured WAN diagnosis. For the exact approximately 2 MiB fixture, 38 completions in 30 seconds require about 2.53 MiB/s aggregate raw payload; all 40 in 60 seconds require about 1.33 MiB/s. Base64 alone raises Teacher outbound payload requirements by approximately 4/3 before JSON/WS/TLS overhead. Actual uplink, concurrent windows, receiver pacing and CPU must be measured in Pass B; a single-stream Phase 16E benchmark cannot prove aggregate capacity.

The soak deliberately interrupts the Teacher only after media has completed. It verifies protocol clients recover AUTH/sync and resume later reads/pings, not an in-flight generation interruption or real browser reconnect policy. Under-load lock/reveal delivery, lost ACK replay during network loss, silent network loss under sustained media, DO eviction/hibernation fault injection and real browser background throttling remain NOT_VERIFIED end-to-end in this pass. Existing scoped authorization/recovery/cancel tests are listed separately; they are not substituted for these missing load cases.

## Reproducible local-only procedure

Run from the repository root (existing dependencies/toolchain installed):

~~~powershell
node apps/relay/scripts/generate-capacity-media.js
node apps/relay/scripts/build-capacity-client.js --baseline
node apps/relay/scripts/build-capacity-client.js
pnpm --filter @classtools/relay exec wrangler d1 migrations apply INSTALLATIONS --local --persist-to I:/ChatGPT/teachTools/apps/teacher/src-tauri/target/phase16f-wrangler
pnpm --filter @classtools/relay exec wrangler dev --ip 127.0.0.1 --port 8792 --persist-to I:/ChatGPT/teachTools/apps/teacher/src-tauri/target/phase16f-wrangler --show-interactive-dev-session false
~~~

In a separate shell, provide the existing **local-only** operator value from ignored .dev.vars without printing it; never use a production activation code. Set process-local environment:

~~~powershell
$env:CLASSROOM_REMOTE_BASE_URL = 'http://127.0.0.1:8792/'
$env:CLASSROOM_TEST_MEDIA_DIR = 'I:\ChatGPT\teachTools\apps\teacher\src-tauri\target\phase16f-smoke'
$env:CLASSROOM_CAPACITY_STUDENTS = '40'
$env:CLASSROOM_CAPACITY_MODE = 'full'
$env:CLASSROOM_CAPACITY_SOAK_SECONDS = '600'
$env:CLASSROOM_CAPACITY_FOUR_PDFS = '1'
$env:CLASSROOM_CAPACITY_OUTPUT = 'I:\ChatGPT\teachTools\apps\teacher\src-tauri\target\phase16f-results\full.json'
cargo test --manifest-path apps/teacher/src-tauri/Cargo.toml --lib remote_capacity_local_pass_a -- --ignored --nocapture
~~~

For a same-condition policy comparison use `CLASSROOM_CAPACITY_BASELINE=1` (canonical HTTP policy only) or unset it (current policy); Worker security fixes are present in both runs. Set `STUDENTS=5, MODE=probe, SOAK_SECONDS=0` and a separate output filename for the before/after probe. Four-PDF execution requires earlier image gates to pass and enough RAM. Stop escalation on an earlier blocker; do not retry to green. Remove the process environment variables afterward and stop only the owned local Wrangler process. Local temporary DB is dropped and the test credential restored; retained Wrangler state is confined to ignored target for reproducibility.

## Pass B — exact remaining actions and authorization

**Not ready for automatic execution. No Pass B action is authorized in this turn.**

1. Resolve the media-time re-auth/routing failure and three public availability blockers above, or obtain an explicit, narrowly bounded pilot risk decision. Review the source patch and test evidence again. Do not describe a rate-limit design, stronger identity, or R2 as already implemented.
2. Re-read deployment metadata and confirm no real classroom is active, or obtain an approved maintenance window. This pass verified deployment `04dcd005-a19a-4136-a390-ecd38897f706` with Worker version `13424a84-25a3-409d-a0b6-1371f6b270d4`, 100%; recheck at execution time:
   `pnpm --filter @classtools/relay exec wrangler deployments list --json`.
3. Prepare a separately reviewed production-capable bounded harness. **The Pass A harness intentionally rejects production and must not simply have its guard removed.** It still needs a single canonical-origin allowlist, explicit approval/run identity, exactly one synthetic installation/Session, socket/raw/UTF-8/time counters, selected-identity cleanup, and no automatic retry/redeploy. Its implementation/review is a remaining prerequisite, not a completed tool or an invented runnable command.
4. Obtain explicit authorization for deployment of the exact uncommitted patch digest, if runtime fixes are approved. Only then use `pnpm --filter @classtools/relay run deploy` against `https://classroom-relay.ryanaddy1102.workers.dev`, record the returned version, and verify static Student assets match the reviewed source. No binding/schema/dependency change is proposed.
5. Obtain explicit authorization for **one synthetic production enrollment**. The existing Operator command is `pnpm --filter @classtools/relay run activation:create:prod`; it writes one hash/expiry to production D1 and prints the code only after successful insertion. Feed the code only to the isolated test credential path; never record the code. Keep a restricted run manifest of the generated activation hash, installation ID and Remote Session ID so cleanup is exact, not a sweep. These identifiers cannot be known before authorized provisioning; do not invent them.
6. Authorize one bounded production run: ≤1 synthetic class, ≤40 Student sockets + one Teacher; sequential 1/4/5/10/20/40; raw media ≤1 GiB including cancellations/retries; Teacher→relay UTF-8 ≤2 GiB separately enforced; ≤30 minutes; same predetermined thresholds; finite retry only. Start with ordinary media and stop escalation at failure. The initial production authorization does not include four 100 MiB PDFs; that case requires separate explicit approval plus earlier gates and memory checks. App counters are not a Cloudflare billing hard cap.
7. Exact data scope: synthetic roster, answers, Essay, Peer Review, PNG/PDF; no real class/Student/answer content. Final cleanup must close **only the captured synthetic Remote Session**, revoke/delete **only the captured synthetic installation and activation hash** using inspected existing schema/foreign-key order. The run authorization may explicitly cover cleanup of these captured IDs; show and verify the manifest and exact selected-ID SQL before execution. If the granted scope does not include cleanup, obtain additional approval. Do not bulk-revoke ACTIVE installations or touch the production Windows credential. Revocation's existing-session exposure is not immediate cleanup.
8. Abort on non-test errors, auth/privacy/integrity failure, uncontrolled pending/reconnect, quota/cost alarm, byte/time ceiling or threshold failure. Obtain approval for rollback if required:
   `pnpm --filter @classtools/relay exec wrangler rollback 13424a84-25a3-409d-a0b6-1371f6b270d4`.
   Verify version availability and storage compatibility first. Code rollback does **not** restore D1/DO state.
9. Obtain read-only account analytics access if needed to resolve actual plan, CPU/duration/storage/alarm/log charges. Any billing/plan change is a separate decision and authorization.

Do not substitute the older unbounded Phase 16E production smoke runner for these missing safeguards. The exact production run/cleanup commands are deliberately a **prerequisite still to implement and review**, rather than pretending the local-only harness is production-ready.

## Pass C and readiness

The cost/release audit records the missing fail-closed Remote build wrapper, rust-version 1.88 versus locally verified 1.97.1, final RC digest/manifest requirements, and installed Human QA. None was executed here. Preserve NSIS current-user, unsigned, WebView2 bootstrapper and existing data paths; no installer/data reset is needed for this audit.

R2 remains deferred. Local capacity, WAN performance, Cloudflare account usage and mobile memory must inform the decision; adding storage cannot be inferred to solve authorization/admission or the existing full-Blob UI behavior.

## Verification and Git

- Relay security/HTTP/lifecycle/Operator focused tests: 49 PASS; 14 additional harness preflight safety tests PASS.
- Student HTTP/Remote/App focused tests: 47 PASS; Student TypeScript and changed-file ESLint PASS.
- Native shared authority/join/Remote tests: 19 PASS; directly affected remote_http tests: 4 PASS.
- Current-policy five-client comparison PASS; canonical fifth-reader failure preserved. Original full run had insufficient C4 ACK timing; directed single-stream probe PASS, four-stream probe FAIL_BLOCKER. Do not summarize capacity as all PASS.
- Student LAN and Remote frontend builds PASS. No Teacher installer or deployment build was performed.
- Rust fmt/check/clippy (`--lib --tests -- -D warnings`) PASS. Broad historical suites were not rerun.
- Final source manifest digest: `96f650e66950a80550d55f36651e33debb81b08dd0d53132cda6fd6cb2e971aa`. It is SHA-256 of UTF-8 JSON.stringify of sorted `[{file,sha256}]`, exact working-file bytes, 14 changed/new apps source/test/tool files; docs excluded. The ignored manifest lists each file hash. HEAD remains the canonical baseline; this patch is not deployed. The original full-matrix harness digest was `23e0f06c35f1b7630f95ee9242a823d99be565ad409b9ca1448693dd956bb10a`; its manifest is preserved as `source-manifest-full-run.json`. Later diagnostics and the C4 trigger correction changed test tooling only, and are not claimed to have rerun the full matrix.
- Final scope and git diff --check PASS, including untracked-file whitespace inspection; known local secret literal scan found no match. main / HEAD / origin/main remain the canonical baseline. Index is empty; all 18 changed/new files remain unstaged. Generated outputs are ignored. Owned local Wrangler and native test processes have stopped.


Production verification: **NOT EXECUTED — awaiting explicit approval.**
Final RC / installed Human QA: **NOT EXECUTED.**
No stage / commit / push performed.
