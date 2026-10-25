# Remote HTTP detail and media relay (Phase 16E)

## Read allowlist and authority

All public operations are GET /v1/sessions/{remoteSessionId}/http/{operation}.
Authorization uses Bearer participant credentials, x-classroom-session and
x-classroom-participant headers. Credentials never appear in paths, queries,
logs, socket attachments, KV, DO SQLite or D1. Join retains its separate 16D POST.

| Operation | Typed arguments | Existing LAN path |
| --- | --- | --- |
| PEER_REVIEW_ACTIVITIES_LIST | page(limit, cursor) | /api/v1/peer-review/activities |
| PEER_REVIEW_ACTIVITY_GET | activityId | /api/v1/peer-review/activities/{id} |
| PEER_REVIEW_CANDIDATES_LIST | activityId, page | /api/v1/peer-review/candidates/{id} |
| PEER_REVIEW_ESSAYS_LIST | assignmentId, page | /api/v1/peer-review/essays/{id} |
| PEER_REVIEW_FEEDBACK_LIST | optional activityId, page | /api/v1/peer-review/feedback |
| PEER_REVIEW_FEEDBACK_GET | assignmentId | /api/v1/peer-review/feedback/{id} |
| PEER_REVIEW_OWN_REVIEW_GET | assignmentId | /api/v1/peer-review/own-review/{id} |
| SESSION_ASSET_GET | assetId | /api/v1/session-assets/{id} |

Essay detail returns an assignment's exact frozen submission revisions.
Feedback detail also uses assignmentId. IDs are UUIDs, limit is 1..100, cursor is
opaque base64url of at most 1024 characters. Unknown/duplicate query fields fail.
No raw path, URL, query string, filesystem path or arbitrary method enters Rust.

Student high-level APIs delegate once to studentHttpRead for Local or Remote.
Worker validates public shape; DO supplies a request UUID and current generation.
ParticipantHttpService is shared by LAN handlers and the Remote native actor.
Every read independently calls LocalSessionService.authenticate. Remote also
checks the expected local Session; a valid Student socket never grants HTTP access.
Existing Rust Peer Review and LiveQuiz services retain participant/Session scope,
assignment access, frozen GroupSet/Cross Group membership, cursor scope, exact
revision, feedback anonymity, hidden-asset access, file identity, MIME and integrity.
No domain semantics, persistence or grading change is involved.

## Remote Protocol v1 HTTP_RELAY

Envelope: v=1, type=HTTP_RELAY, id=request UUID, payload=typed subtype.
Every complete UTF-8 envelope remains at most 64 KiB.

| payload.op | Direction | Fields besides generation |
| --- | --- | --- |
| HTTP_REQUEST | DO to Teacher | identity(sessionId, participantId, credential), request(operation, arguments) |
| HTTP_RESPONSE_START | Teacher to DO | status, contentType, contentLength |
| HTTP_RESPONSE_CHUNK | Teacher to DO | zero-based sequence, one standard-base64 data chunk |
| HTTP_RESPONSE_END | Teacher to DO | chunks, bytes |
| HTTP_CREDIT | DO to Teacher | credits |
| HTTP_CANCEL | DO to Teacher | none |
| HTTP_ERROR | Teacher to DO | code |

Status: 200/400/401/404/500. Content type: application/json, application/pdf,
image/png, image/jpeg or image/webp. No arbitrary headers are forwarded.
Worker supplies security headers. Domain failures are sanitized JSON. Native
transport errors are REQUEST_TIMEOUT, REMOTE_SERVICE_UNAVAILABLE or RESPONSE_INVALID.
The frontend renders controlled zh-TW errors without raw transport/stack details.

## Bounds and flow control

| Resource | Default |
| --- | --- |
| Session pending HTTP requests | 64 |
| Participant pending requests | 4 |
| Session media ownership | 4 |
| Participant media stream | 1 |
| Native concurrently preparing reads | 8 |
| Raw chunk | 32 KiB |
| Credit window | 4 chunks / 128 KiB |
| JSON/detail response ceiling | 16 MiB |
| Media response ceiling | 100 MiB |
| Detail total timeout | 15 seconds |
| Media total timeout | 600 seconds |
| Media idle timeout | 20 seconds |

The detail deadline accommodates bounded SQLite reads. Media's longer deadline
supports large PDFs over slower upstreams; idle timeout bounds a stalled consumer.
Existing supported image/PDF import sizes remain 20/100 MiB. Saturation returns
retryable controlled failure; no request is queued for later Teacher availability.

Native uses the existing complete validated Vec<u8>, without rewriting persistence.
Only one chunk is base64 encoded at a time. Teacher sends no more than issued
credits. DO holds at most a four-chunk queue; the output pipe has bounded runtime
buffering. END must match contiguous sequence, announced length and received bytes.

Output uses Cloudflare FixedLengthStream, ensuring an interrupted/truncated body
cannot silently succeed. Manually setting Content-Length on an arbitrary stream
is insufficient; see https://developers.cloudflare.com/workers/runtime-apis/response/.

## Cancellation, generation and reconstruction

Browser cancellation/navigation removes correlation and sends best-effort CANCEL.
Timeout, Teacher disconnect and generation replacement do likewise. Native removes
the request and stops further encoding/chunks. Already executing SQLite/file
integrity reads cannot safely be preempted; their ownership permits remain held
until completion. Shared read/media permits span reconnect actors, bounding rapid
cancel/reconnect churn. Existing Tokio blocking work and a bounded completion
channel keep file/DB preparation from blocking heartbeat/realtime. No new runtime,
thread framework or shared SQLite connection is introduced.

Every request binds to one generation. Replacement fails the old stream, ignores
stale chunks and allows a fresh safe GET; responses never combine generations.
Correlations, bodies and chunks are transient. A reconstructed DO cannot recover
an active HTTP stream; late frames receive CANCEL. The interrupted response fails.
There is no durable pending queue, offline HTTP queue or resumable transfer.

Current images/PDF fetch a complete authenticated Blob and display an object URL.
PDF opens that Blob in the browser viewer. Range is neither required nor supported.
Images/PDF abort on unmount/replacement. Human QA acceptance and remaining
performance/capacity limits are recorded in the closeout below. Technical
verification does not claim a Codex GUI walkthrough.

## Reproducible synthetic smoke

Run node apps/relay/src/generate-http-benchmark.js from the repository root.
It writes only ignored Teacher target/phase16e-smoke files: a valid 2048x2555
noise PNG (20,936,368 bytes), and a valid 100 MiB PDF (104,857,600 bytes).
The PDF contains a small visible page and an unused stream, exercising file size
without manufacturing expensive page content. No giant binary fixture is tracked.

With local Wrangler running, set CLASSROOM_REMOTE_BASE_URL,
CLASSROOM_TEST_OPERATOR_TOKEN and CLASSROOM_TEST_MEDIA_DIR only in the test process.
From apps/teacher/src-tauri run:
cargo test --lib remote_http_native_smoke_benchmark -- --ignored --nocapture

This opt-in smoke uses an isolated temporary application database and the existing
test-only Windows Credential Manager namespace; it restores any prior test credential.
It exercises all seven detail operations, independent auth, exact image/PDF hashes,
cancel and generation interruption. Output contains only byte counts, timing and
categories, never credentials, Student identity, Essay/feedback text or media.

Production uses the same synthetic fixture with an ephemeral activation code
provisioned through authenticated Wrangler/D1 access. No R2, cloud media/domain
storage, Classroom/D1 schema migration, Range, installer, new dependency or 16F work.

## Verification snapshot (2026-10-02)

Baseline: main at 8a04fa7fe9a972e9a92b95e5571dc9c42ef1f0c0, matching origin/main.
This snapshot records verification before the Phase 16E closeout.

| Focused verification | Result |
| --- | --- |
| HTTP relay / lifecycle | 19 passed |
| Existing Remote join/auth/generation integration | 6 passed |
| Shared backend-contract | 14 passed |
| Student HTTP/API/Remote UI | 29 passed |
| Peer Review panel | 16 passed |
| Existing image/PDF UI | 3 passed |
| Rust HTTP/shared authorization/native adapter and LAN reads | 9 passed |
| Opt-in native local smoke | 1 passed |
| Opt-in native production smoke | 1 passed |
| Student/backend-contract TypeScript and lint, Teacher TypeScript | Passed |
| Student LAN and Remote production builds | Passed |
| cargo check --lib, fmt --check, clippy --lib --tests -D warnings | Passed |
| Worker bundle dry-run, git diff --check | Passed |

LAN regression covers one existing Peer Review detail path and authenticated image
HTTP (exact bytes/MIME, missing credentials and inaccessible asset). Native local
smoke covers all seven detail operations, wrong credential/Session/assignment,
unknown operation/asset/API path, image/PDF, cancellation and generation replacement.
The allowlist also rejects JavaScript inherited object keys.

Latest local measurement uses localhost Wrangler plus the real native outbound
Teacher WebSocket actor, an isolated temporary database and synthetic assets:

| Media | Bytes | Seconds | MiB/s | Integrity |
| --- | ---: | ---: | ---: | --- |
| PNG, approximately 20 MiB | 20,936,368 | 2.706 | 7.378 | Exact SHA-256 and MIME passed |
| PDF, 100 MiB | 104,857,600 | 12.836 | 7.791 | Exact SHA-256 and MIME passed |

No transfer timeout or unexpected relay error occurred in this final local run.
Cancel after 28,672 delivered bytes released the slot and allowed replacement media.
Generation interruption after 458,752 delivered bytes failed the old response;
a safe GET through the replacement generation passed. These byte counts are
observations, not a bound on cancellation propagation latency.

An earlier equivalent native local run observed a 127,131,648-byte peak working set
(about 121.24 MiB) for the synthetic test process with one 100 MiB transfer. This is
not an installed Teacher or four-stream memory measurement. Existing full-file Vec
allocation remains; four concurrent 100 MiB reads can retain roughly 400 MiB plus
application and bounded transport overhead. DO cost and full-classroom concurrency
have not been benchmarked.

Student browser behavior is covered by focused API and Blob/object-URL UI tests.
At this technical verification snapshot, actual browser/device usability still
awaited Human QA. The later user acceptance is recorded below; Codex did not
perform Computer Use or a GUI walkthrough.

After explicit user deployment approval and passing local verification, the relay
was deployed to https://classroom-relay.ryanaddy1102.workers.dev. Worker version:
13424a84-25a3-409d-a0b6-1371f6b270d4. The pnpm deploy built-in intercepted the original
command before any deployment; pnpm --filter @classtools/relay run deploy then
executed the existing wrangler deploy script successfully.

Production used the same isolated native test and synthetic assets, through real
HTTPS and the authoritative Teacher outbound WSS. All seven detail operations,
independent credential/Session/assignment checks, unknown routes, exact image/PDF
bytes and MIME, cancellation, and Teacher-generation interruption/reconnect passed.
The synthetic Remote Session was closed, the previous test Credential Manager entry
was restored, and the temporary activation-code hash was removed from D1. Only
normal transport installation/lifecycle metadata was created; no Classroom domain
data or media was persisted in Cloudflare.

| Production media | Bytes | Seconds | MiB/s | Integrity / MIME |
| --- | ---: | ---: | ---: | --- |
| PNG, approximately 20 MiB | 20,936,368 | 25.647 | 0.779 | Exact SHA-256, image/png passed |
| PDF, 100 MiB | 104,857,600 | 125.041 | 0.800 | Exact SHA-256, application/pdf passed |

Neither completed transfer timed out or produced an unexpected relay error.
Dropping the first media response after 8,192 delivered bytes released its slot
and permitted replacement media. Replacing Teacher generation interrupted the
old response after 1,216,192 delivered bytes with a stream error; reconnect and
safe GET retry passed. These byte counts include already delivered/buffered data
and are not cancellation or generation-propagation limits. Expected unauthorized
requests returned 401/404 and unknown operations/API paths returned structured
400/404 errors. No interrupted transfer silently completed as valid content.

During this serial production run, sampled native test-process PeakWorkingSet64
was 133,767,168 bytes (about 127.57 MiB). The process had exited before a final
peak sample, so this is an observed peak-counter value, not a guaranteed final
maximum. It does not measure an installed Teacher or concurrent full-classroom use.

The technical benchmark passed both size limits within the selected deadlines
with exact integrity and bounded native transport overhead. It does not establish
classroom-scale performance acceptance. The closeout decision and required
performance/capacity follow-up are recorded below.

No R2, Range, migration, dependency or Phase 16F change has been introduced.
No new Worker deployment or push is part of this closeout.

## Closeout acceptance (2026-10-25)

Phase 16E implementation, production synthetic verification and user-performed
Human QA A-H are PASS. The Operator Activation Code CLI is included; its 17 focused
tests previously passed without contacting production D1. The existing production
Worker version remains 13424a84-25a3-409d-a0b6-1371f6b270d4.

OBSERVED_PERFORMANCE_LIMITATION

| Observation | Result |
| --- | --- |
| Student mobile 4G, approximately 2 MiB image | Approximately 10 seconds perceived load time |
| Production synthetic PNG, approximately 20 MiB | 25.647 seconds; integrity/MIME PASS |
| Production synthetic PDF, 100 MiB | 125.041 seconds; integrity/MIME PASS |
| Current media concurrency | 4 streams per Session; 1 stream per participant |

The user temporarily accepts the current 100 MiB PDF loading performance and
accepts the existing Teacher streaming architecture for Phase 16E closeout. The
observed mobile image latency remains a known limitation, not a completed
classroom-scale performance acceptance. The mobile observation is perceived
loading time, distinct from the synthetic transfer benchmark.

Phase 16F must verify multiple Students accessing media simultaneously, end-to-end
performance and capacity, and Cloudflare cost. R2 remains deferred; reconsider it
only using the resulting capacity/performance evidence. Recording this follow-up
does not begin Phase 16F implementation or change current transport limits.

Closeout changes only this necessary documentation. Runtime source is unchanged
since the accepted verification; previous tests/builds and Human QA are retained
as evidence without rerunning broad suites. No R2, Range, Classroom/D1 migration,
new dependency or cloud domain-data persistence is introduced.
