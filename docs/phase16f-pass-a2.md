# Phase 16F Pass A2 — local remediation and evidence

Date: 2026-10-26 (Asia/Taipei). Repository: I:\ChatGPT\teachTools.
Canonical baseline: c5285196a08e412732eb2246efd78e3c9644d15a on main; origin/main unchanged.

## Decision and scope

**The four requested Pass A2 items are locally remediated and the focused verification passed. Phase 16F remains INCOMPLETE.** Forty Students remains a planning/test target, not accepted product capacity. The existing uncommitted Pass A patch was preserved; no reset, stage, commit, push, production deployment/load/D1 write, billing change, final installer, new dependency, migration, R2 or Range work occurred.

The original Pass A report remains historical evidence. This report supersedes its four targeted blocker dispositions only. Distributed public availability/cost, WAN/mobile behavior, final Remote build gating, final RC and installed Human QA still require decisions/verification.

## Causal chain and actual changes

### Continuous media scheduling

The immediate pull -> CREDIT -> CHUNK feedback loop repeatedly replenished media in the same delivery chain. A local workerd component experiment held four responses open without continuously flowing chunks: AUTH, realtime and detail still worked. When four responses continuously flowed, Student upgrade/control work was delayed until media completion. All four first-byte reads were synchronized before any reader was allowed to drain; the failure was not a sequential-reader test artifact.

The single-variable candidate that removed full-pipe waitUntil did not fix either the flowing component or the real four-PDF workload. It was discarded; production code keeps waitUntil and FixedLengthStream. This is important because documentation alone is not causal evidence. The current [DurableObjectState documentation](https://developers.cloudflare.com/durable-objects/api/state/#waituntil) describes eviction behavior; it does not establish that this application's long pipe was the fault.

The accepted change in [HttpRelay.credit](../apps/relay/src/http_relay.js) accumulates replenishment credits and flushes them through one zero-delay task. Initial four credits are unchanged. Each queued entry is bounded to four credits; queued plus outstanding credits cannot exceed four. Cancel/END/generation failure removes its queued credits and clears the last timer. This gives other events an opportunity to run between credit windows; it does not enlarge a window, concurrency limit, envelope or timeout. No native scheduler, presence semantics or new background runtime was introduced.

Component evidence, four 8 MiB streams with a synthetic Teacher (component isolation only, not Classroom authority/capacity acceptance):

| Case | Before | After fair CREDIT |
| --- | --- | --- |
| Four held bodies | PASS | PASS |
| Four continuously flowing bodies | Student upgrade exceeded the unchanged 1,500 ms observer deadline | Upgrade ~12 ms; AUTH ~63 ms; pong ~95 ms; detail ~128 ms after all first bytes |
| Media completion relative to trigger | Control blocked until completion | All control checks finished while all media remained outstanding; bodies completed ~1.93–1.95 s later |
| Remove only pipe waitUntil | Still FAIL | Not merged |

The real Rust/40-client direct-network experiment also failed before the change, so Wrangler's development proxy is not the sole cause. Wrangler adds material local overhead and its failure included reconstruction; those observations are not extrapolated to production platform behavior.

### Re-auth race after reconstruction

The failed Wrangler trace showed the old DO finishing the four PDFs, followed by a new OPEN DO at the same generation with 40 Student sockets. Constructor invalidation sent REAUTH_REQUIRED, while old realtime frames were already in flight. The old handler closed UNAUTHENTICATED/PENDING_AUTH sockets for those frames; later Rust AUTH results could not restore the closed sockets.

[lifecycle.js](../apps/relay/src/lifecycle.js) now retains only a routing marker, reauthPending, for sockets that were previously authenticated. During the original five-second re-auth deadline, [Worker.webSocketMessage](../apps/relay/src/worker.js) drops schema-valid old REALTIME frames on these sockets. It never forwards, acknowledges, queues or replays them. A matching current-generation Rust AUTH result is still required and clears the marker. Fresh unverified sockets, expired deadlines, stale generations and malformed/oversized frames still fail closed. This is not persisted bearer authority and does not disable re-auth.

Before constructor-race regressions: 0/2 PASS. After: ping/submit/PENDING_AUTH/matching Rust response and negative controls pass. Existing Student tests confirm pending submissions resume with the original submissionId only after AUTH plus session_sync; no new offline mutation queue was added. Terminal rejection was also made idempotent when the peer is already closed: before 1/2 PASS, after both cases PASS. That error-path fix prevents repeated uncaught send-after-close errors; it is not the media fix.

### Identity quota isolation

Both DO and Rust previously used the unverified claimed participant ID as the per-participant quota key. One forged media request could reserve the victim's only bucket before authentication. The minimal change uses an ephemeral SHA-256 of the canonical array [sessionId, participantId, presentedCredential] for provisional quota ownership, in [http_relay.js](../apps/relay/src/http_relay.js) and [remote_http.rs](../apps/teacher/src-tauri/src/application/remote_http.rs). The Worker computes it before re-reading current metadata/generation; no async admission race is introduced.

The hash is not authorization and is not stored in attachments, KV, D1, logs or URLs. Rust still authenticates each read before domain/asset access. Current credentials have no rotation path producing two simultaneously valid bearer values for one participant. Same valid owner still gets one media stream; forged rotating owners remain subject to the four-stream global cap. Deliberate competition for global quota remains a bounded availability risk, not a claim of Internet-wide DoS resistance.

Before: three relay regressions failed; a real temporary-DB Rust regression rejected the legitimate victim behind a forged claim. After: independent victim admission succeeds; forged credential gets 401 before asset lookup, valid credential reaches the missing synthetic asset's 404, duplicate valid media remains rejected, rotating invalid credentials cannot exceed global four and all permits return.

### Failed join cache and public admission

[RemoteParticipants::join](../apps/teacher/src-tauri/src/application/remote_participant.rs) previously let 128 failed attempts occupy the complete 120-second recovery cache. At capacity it now evicts only the oldest failed result. Successful credential recovery is never evicted by failure traffic; all-success capacity remains fail closed. Cache size/TTL and Rust LOBBY/identity rules are unchanged.

Before: 128 invalid joins blocked the subsequent valid join (new regression failed). After: valid join succeeds; another 128 invalid attempts do not evict its exact successful result, ACTIVE recovery remains possible, mismatched identity remains rejected, participant count remains one. All nine focused participant tests pass.

[Admission evidence](phase16f-a2-security-evidence.md) contains the exact route limits and before/after counts. Worker isolate/IP and DO instance buckets now bound expensive public dispatch; global denial precedes new IP-record allocation. Control bodies keep the 4 KiB ceiling and gain a five-second read deadline with nonblocking cancellation. This deadline bounds previously indefinite public work; no existing timeout was extended.

| Fixed-time public case | Before expensive dispatch | After |
| --- | ---: | --- |
| 20 invalid activations | 20 D1 batches | 8 batches; 12 HTTP 429 |
| 200 valid-looking unknown Session IDs | 200 DO lookups | 160 lookups; 40 HTTP 429 |
| 100 joins | 100 DO lookups | 80 lookups; 20 HTTP 429 |
| 160 unauthenticated socket upgrades | 160 DO lookups | 128 lookups; 32 HTTP 429 |
| Enrollment slow body / stalled cancel | No response within 5,500 / 500 ms observer bounds | ~5,002 / 2.43 ms controlled rejection; D1 untouched |

These guards are in-memory, not global persistent quotas. Restarts, multiple PoPs and DO reconstruction reset counters; shared-NAT abuse and admitted distributed attempts can still deny service or incur cost. Same-NAT legitimate burst tests pass. A reviewer-found denied-IP map poisoning case was fixed before final verification; rejected new addresses no longer allocate records.

## Real local workload results

Same Windows PC/hardware/toolchain and generated fixtures as Pass A; native debug/test binary. Node protocol synthetic clients use real Rust roster join/AUTH/domain services and the actual bundled Student HTTP policy. This is not physical phones, browser Blob/decode/render, installed Teacher or WAN evidence. The direct server uses actual loopback HTTP/WS network sockets to workerd, not dispatchFetch. All four PDFs are 104,857,600 bytes each; the PNG is 2,094,909 bytes. All complete reads verify exact SHA-256 and MIME.

Predetermined gates remain ACK p95 <=2 s (text), <=3 s (media), ordinary images >=95% by 30 s/all by 60 s. Percentiles are nearest-rank; small samples are not SLA evidence. Timeout values below are right-censored at 10 s, not measured eventual ACK latency.

| Four-PDF / 40-client path | Before | After |
| --- | --- | --- |
| Direct workerd ACK | 0/40 before 10 s; authoritative answers 40 eventually | 40/40; p50 219.910 / p95 375.768 / max 393.854 ms |
| Direct detail | 8,624.425 ms | 52.685 ms |
| Direct PDFs | 19.985–20.087 s; all integrity/MIME PASS | 27.704–27.795 s; all PASS |
| Direct aggregate raw throughput | ~19.91 MiB/s | ~14.39 MiB/s |
| Direct ping p95/max | 17.680 /18.560 s | 0.315 /0.966 s |
| Original Wrangler ACK | 0/40 before 10 s; two trace runs reproduced failure | 40/40; p50 306.577 /p95 465.483 /max 483.513 ms |
| Wrangler detail | 41.223 s in first A2 trace | 166.011 ms |
| Wrangler PDFs | 49.437–49.601 s in first A2 trace; all PASS | 55.981–56.102 s; all PASS |
| Wrangler aggregate raw throughput | ~8.06 MiB/s | ~7.13 MiB/s |
| Wrangler re-auth/offline | 40 unplanned re-auth events | 0 unplanned re-auth; 0 offline; 0 WS errors |

The scheduling fix trades some peak bulk throughput for timely control. Do not describe it as a WAN/media speed improvement. The two before traces differed in whether Rust eventually accepted answers (40 versus 0); both failed the same ACK/admission gate. This is not evidence that previously committed answers were lost.

Under the after four-stream workload, lock/reveal began while all four PDFs were active. Direct lock/reveal reached 40 clients in 442.699/521.090 ms; Wrangler in 639.915/857.930 ms. Native Teacher presence was 40/40 in 29 direct and 57 Wrangler samples. Wrangler ping p95/max were 512.353/1548.848 ms. Teacher CONTROL heartbeat stayed at ~20-second cadence; measured ping-to-pong pairs were 3.765/11.034/37.561/14.484 ms within that native process. The ~60-second liveness deadline was not changed.

General image regression, 40 real authenticated protocol clients, actual bounded Student GET retry:

| Concurrent readers | First success | Eventual success | Max full-body seconds | Concurrent ACK p95 ms |
| --- | --- | --- | ---: | ---: |
| 1 | 1/1 | 1/1 | 0.776 | 354.259 |
| 4 | 4/4 | 4/4 | 1.461 | 355.630 |
| 5 | 4/5 | 5/5 | 1.825 | 350.256 |
| 10 | 4/10 | 10/10 | 4.141 | 352.670 |
| 20 | 4/20 | 20/20 | 7.073 | 372.735 |
| 40 | 4/40 | 40/40 | 12.739 | 438.310 |

All 18 image-mode gates passed, including separate text ACK/authoritative count and released resources. No hidden harness retry or concurrency increase was used.

In-flight recovery/cancel: after PDF first bytes, intentional Teacher replacement caused generation 1 -> 2 -> 3 (the middle replacement immediately closes, then native reconnects). The old response failed as INTERRUPTED after 262,144 delivered bytes and was never stitched across generations. All 40 clients regained AUTH/sync in 2.774 s; new Quiz ACK p95 was 402.737 ms and authoritative answers 40. A later cancel observed 8,192 client bytes; the replacement PNG completed in 484.738 ms with correct hash/MIME. Final online 40, readers/media/credit waiters 0; no unexpected offline or WS error. This verifies protocol-client recovery, with actual browser pending-submission behavior covered separately by focused tests.

Four-stream native memory sampled every 2 s (30 samples): working set 20.879–423.219 MiB, private peak 409.020 MiB, last sample 23.488 MiB. Shorter peaks can be missed. This is native test-process RAM, not DO billing memory or browser Blob memory. Full-file native Vec behavior is retained.

Each workload stayed below the unchanged 1 GiB raw HTTP_CHUNK and 2 GiB Teacher UTF-8 hard caps. Wrangler four PDFs reserved 419,430,748 raw bytes and 562,014,508 Teacher UTF-8 bytes; image regression 173,878,491/233,283,068; recovery 4,714,106/6,799,791. Raw counters conservatively include small JSON and canceled/retried chunks. Resources returned to zero and owned listeners/processes were stopped.

## Verification actually performed

- Final Relay and local-harness focused command: **90 PASS** (18 admission, 13 security, 15 HTTP, 6 lifecycle, 4 quota, 12 re-auth/terminal rejection, 2 scheduling, 14 workload preflight, 6 direct-server preflight).
- Native focused: 9 participant/cache + 6 HTTP/quota + 3 Remote control = **18 PASS**.
- Existing Student Remote transport/App recovery tests: **20 PASS**; no Student runtime change in A2.
- Rust fmt/check/clippy PASS; Node syntax PASS; final git diff --check PASS. Broad historical suites, production builds and final installer were not rerun.
- One legacy native integration invocation initially stopped at service.configured() because no local URL was supplied (2 PASS/1 fixture failure, before credential/network work). It was rerun against the ephemeral loopback server with the existing test-target backup/restore guard and all 3 passed. This was not hidden as an initial clean run.
- Final terminal-reject handling and legacy-test cleanup guard were added after the capacity workloads. Their focused regressions passed; the full capacity workload was not rerun for those isolated error-path/test-cleanup changes. Exact workload/final manifests distinguish the sources.

## Actual diff and manifests

Review artifacts are in ignored apps/teacher/src-tauri/target/phase16f-a2-trace/:

- security-scheduling.patch: actual six-file logical diff from the saved uncommitted Pass A state (unchanged files use canonical HEAD). Line endings are normalized for review only; it is not merely the full HEAD-to-working-tree Pass A+A2 diff. SHA-256: **1d6997ab52fdd4d4d7170ac3aba053793d261b7a088943eb66b00ac50488927b**.
- source-harness-manifest.json: final 27 changed/new apps source/test/tool files, baseline, relay variants and report hashes. Final source digest: **374d69fdb0ebabca7be318d401a371ddb8c5c3091675360a48e24bf195b7e4e3**.
- workload-source-manifest.json: preceding workload source identity **c5f49db836098af7c9620df80e830b4d811bc3c1e3d60c86cf35b9ebfa245907**, with actual native binary, bundled Student HTTP and fixture hashes. Unchanged sources are identified by canonical baseline. Do not substitute the final manifest retroactively for that workload.
- Frozen trace Worker direct-before module digest: **a73ad112a4bbf0d74f6978cc565980c1db0840cc704cd9f19554d4e35a9f7483**. Direct-after module digest at run: **6bc5f95c6ca6e352ec86d64ccdc42a6740248b86cdcb6669b93374eca19e6b9a** (before later admission ordering/terminal error handling). Final relay-only digest: **44dc168969f3c990e777ec87f09c245528471e730cdcf6b7cb2bdb88d5dbc23f**.
- Reports: before-four.json, before-four-2.json, no-pipe-wait.json, direct-before.json, direct-after.json, wrangler-after-four.json, a2-images.json, a2-recovery.json, after-native-memory.json. Before failures and rejected diagnostic candidate are preserved.
- Pre-A2 18-file snapshot remains target/phase16f-a2-before/, manifest digest 31a21a1f9f7072afdb21a9660a0f766be2d87bb82a552ce37319bf1a7fee1177.

Digest algorithm: SHA-256 of UTF-8 JSON.stringify of sorted [{file,sha256}] using exact file bytes; source manifests exclude documentation. Relay-only digests cover module basenames, not the whole source/harness. Reports and fixtures contain synthetic measurements only; no raw bearer/activation/installation values are included.

Local reproduction uses the original Wrangler loopback procedure in the historical report, or node apps/relay/scripts/capacity-local-server.js for direct workerd 127.0.0.1:8793. Use the existing local operator binding without printing it, generated synthetic media, STUDENTS=40, SOAK_SECONDS=0, and MODE=stream-probe-four /a2-images /a2-recovery with separate ignored OUTPUT paths. The native command is cargo test --manifest-path apps/teacher/src-tauri/Cargo.toml --lib remote_capacity_local_pass_a -- --ignored --nocapture. Never point these tools at production or remove their target guards. Snapshot loading is confined to ignored target. The synthetic ASSETS fallback is not browser/GUI evidence.

## Cost and next gate

The [cost model](phase16f-cost-and-release.md) remains a model, not an account bill. A2 does not alter prices, plans, bindings or paid resources. Batched outbound CREDIT is not an incoming DO billable message; the four-PDF payload still uses 12,800 incoming Teacher CHUNK frames. The fair scheduling tradeoff can change active duration/CPU, which must be measured in authorized production. Actual plan, DO CPU/duration, storage/alarm/log costs remain UNKNOWN. Local native memory is not DO memory billing.

Pass B is not authorized by these local passes. Before any action, review the final patch/digest, explicitly accept or improve the documented distributed-admission risks, confirm no real class/maintenance window, and prepare/review the still-missing production-safe bounded provisioning/run/exact-ID cleanup tool. Do not bypass the local-only harness guards. The historical report lists the exact conditional deploy/provision/rollback commands, 1 synthetic class/40 Students/1 Teacher, raw <= 1 GiB, Teacher UTF-8 <= 2 GiB, <= 30 min and stop gates. Any deployment, production D1 write/cleanup and production load needs the matching explicit authorization. No production four-maximum-PDF run is implied. Final release URL fail-closed wrapper/RC/installed Human QA remains separate unfinished work; no installer was created.

**Phase 16F COMPLETE: NO. Production verification: NOT EXECUTED. Installed Human QA: NOT EXECUTED. Git: all changes unstaged; no commit/push.**
