# Phase 16F Pass A2 — bounded public admission evidence

This is the admission and local-harness safety evidence slice for the uncommitted Pass A2 patch. It does not establish globally distributed denial-of-service protection, production capacity, or Phase 16F completion. The canonical Git baseline remains c5285196a08e412732eb2246efd78e3c9644d15a; existing Pass A edits are preserved. No production request, deployment, D1 write, billing change, new dependency, or migration is required by this work.

Source line references below describe the current uncommitted files. Symbols remain the reference if later local edits move a line.

## Causal finding and minimal dispatch change

Before A2, the Worker validated request shape and delegated to D1 or a Session DO, but had no cumulative admission guard. The DO bounded simultaneously pending joins/sockets, rather than repeated public attempts over time. Thus repeated invalid activation attempts still reached D1, and syntactically valid guessed Session IDs still caused DO lookups. Those lookups did not become authorized Sessions or create usable metadata, but their dispatch cost was unbounded across repeated requests.

The A2 changes are in [PublicAdmission](../apps/relay/src/admission.js#L38), [Worker fetch](../apps/relay/src/worker.js#L288), and [SessionAdmission](../apps/relay/src/admission.js#L97). The actual dispatch boundary is:

~~~javascript
release = publicAdmission.acquire(request);
if (!release) return error("REMOTE_SERVICE_UNAVAILABLE", 429);
// Existing route and authorization handlers remain authoritative.
// finally:
release?.();

// Each DO instance has its own public-work admission buckets.
if (!this.admission.allow(path))
  return error("REMOTE_SERVICE_UNAVAILABLE", 429);
~~~

The Worker permit is held until the route produces its response headers, not for the entire media response body. Existing HTTP stream/read/participant limits remain separate. Already authenticated WS messages, presence pings, Teacher heartbeat, realtime ACKs and Teacher ticket processing are not routed through the DO public-work buckets. This is not a substitute for Rust authorization.

## Numeric bounds

The checked-in [rules](../apps/relay/src/admission.js#L3) are token buckets. Refill values are tokens per second, not rolling-window claims. Global means one live Worker isolate, not all Cloudflare locations or the account.

| Public route class | Per-IP burst | Per-IP refill/s | Isolate burst | Isolate refill/s |
| --- | ---: | ---: | ---: | ---: |
| Enrollment | 8 | 0.1 | 32 | 0.2 |
| Operator | 16 | 1 | 32 | 2 |
| Teacher control | 80 | 4 | 256 | 16 |
| Bootstrap | 160 | 16 | 512 | 64 |
| Join | 80 | 4 | 256 | 16 |
| Student socket upgrade | 128 | 8 | 512 | 32 |
| Allowlisted HTTP | 256 | 64 | 1024 | 256 |
| Other /v1/ requests | 32 | 2 | 128 | 8 |

The DO has independent per-instance buckets for join (80 burst, 4/s), Student socket upgrade (128, 8/s), and HTTP read (256, 64/s). It does not trust a claimed participant identity as a rate-limit key.

Additional [memory and outstanding-work bounds](../apps/relay/src/admission.js#L13):

- Maximum 1,024 IP records, each containing only the fixed set of route buckets and counters.
- Maximum 128 pending public requests per isolate and 64 per IP.
- Only Cloudflare's trusted CF-Connecting-IP header is used at the public edge. There is no X-Forwarded-For or participant-header fallback. Missing/invalid platform metadata shares a conservative unknown bucket. The local listener is trusted test infrastructure, not an Internet edge that authenticates this header.
- The map never evicts an active entry merely to admit another key. Full-map sweeps occur at most once per 10 seconds; only entries idle at least 10 minutes with no pending request are removed. Every route bucket fully refills within that interval.
- [Global denial precedes any new IP allocation](../apps/relay/src/admission.js#L53). A globally denied request cannot fill the map with fresh keys. Tokens are consumed only after both global and per-IP checks pass; release is idempotent.
- Static asset traffic is outside these API admission buckets. The guard does not remove Worker invocations, CDN traffic, or all possible service costs.

These are bounded local defenses. A sustained admitted attack can still incur cost; a rate bound is not a total spending cap.

## Before/after dispatch evidence

The focused tests execute actual Worker route code under a deterministic host/clock shim with local D1/DO test doubles. They do not send requests to production or claim account-wide Cloudflare rate-limit enforcement. Existing Miniflare security tests separately exercise the compatible Worker module in local workerd.

| Fixed-time synthetic case | Before A2 admission integration | After |
| --- | --- | --- |
| 20 invalid activation submissions | 20 D1 batches | 8 D1 batches; 12 HTTP 429 |
| 200 valid-looking unknown Session IDs | 200 DO lookups | 160 lookups; 40 HTTP 429 |
| 100 unauthenticated valid-shape joins | 100 DO lookups | 80 lookups; 20 HTTP 429 |
| 160 unauthenticated socket upgrades | 160 DO lookups | 128 lookups; 32 HTTP 429 |
| 200 malformed Session IDs | 200 HTTP 400; 0 DO lookups | 160 HTTP 400, 40 HTTP 429; 0 lookups |
| 100 direct DO joins on the test instance | No rate admission rejection | 20 HTTP 429, no retained pending join |

The six integration regression cases failed before Worker integration, then passed. The initial eight helper tests passed independently. See [dispatch regression cases](../apps/relay/src/admission.test.js#L111).

The [same-NAT test](../apps/relay/src/admission.test.js#L14) admits 80 join attempts, 120 socket upgrades and 240 HTTP requests at a fixed time from one address, with completed-response release between requests. Other tests hold pending requests to verify the separate 64/128 concurrency bounds. These are admission-policy tests, not evidence that a classroom of phones has been accepted at this capacity. Actual simultaneous-classroom measurements belong in the main A2 report.

### Review-found IP-record poisoning regression

The first helper implementation created a new IP record before checking the isolate budget. A reviewer identified that rejected new addresses could fill the 1,024-record map. A narrowly scoped fix moved global pending/token checks ahead of allocation; it did not increase any limit or refill rate.

| Deterministic regression | Before correction | After correction |
| --- | ---: | ---: |
| Exhaust join global tokens using 256 addresses, then reject 1,344 new addresses | Map grew from 256 to 1024 | Map remains 256 |
| Hold global 128 pending requests across 2 IPs, then reject 100 new IPs | Map grew from 2 to 102 | Map remains 2 |

Both tests failed before the correction and passed afterward. They also verify that an independently available route/IP can still be admitted. [Regression source](../apps/relay/src/admission.test.js#L185).

## Slow control-body retention

The original [bodyJson](../apps/relay/src/worker.js#L64) had a 4 KiB byte ceiling but could await reader.read() forever. Its oversized-body path also awaited reader.cancel(), whose underlying source could fail to settle. A finite pending-request limit alone would allow these bodies to hold every admission slot indefinitely.

The fix preserves the 4 KiB ceiling and adds a new 5-second public-body read deadline. It does not lengthen AUTH, join, HTTP relay, ACK, presence or Teacher-liveness timeouts. A deadline or observed streamed-body overflow requests nonblocking cancellation. bodyJson returns null and each route retains its existing validation/default behavior; the measured rejection below is the enrollment route. An authenticated Operator activation request retains its existing default-TTL behavior. A finally block clears the deadline timer and releases the reader.

[Two regression tests](../apps/relay/src/admission.test.js#L163) use synthetic streams, including a cancellation promise that never settles:

| Case | Before | Final after run |
| --- | --- | --- |
| Body supplies no bytes | No response by 5,500 ms observer bound | HTTP 403 at 5,002.2 ms; no D1 call |
| Body supplies 4,097 bytes; cancellation never settles | No response by 500 ms observer bound | HTTP 403 at 2.43 ms; no D1 call |

Before values are right-censored observation bounds, not eventual completion times. Each after case requests cancellation once. The public error remains sanitized; no body, activation value, or credential is written to logs.

## Local direct-workerd diagnostic server safety

[capacity-local-server.js](../apps/relay/scripts/capacity-local-server.js#L15) exists to compare the actual HTTP/WS network path without Wrangler's development ProxyWorker. It uses the existing Miniflare dependency bundled with Wrangler, not an added dependency or an echo implementation.

- [Fixed listener](../apps/relay/scripts/capacity-local-server.js#L40): HTTP 127.0.0.1:8793 only. The optional --snapshot argument must resolve under the repository's ignored target directory. Host/port/remote/extra arguments are rejected.
- The snapshot directory and every module are checked with realpath. Modules must remain inside the selected directory and the allowlisted import set. A frozen pre-admission snapshot can contain the four original modules without a fabricated admission module.
- [Runtime options](../apps/relay/scripts/capacity-local-server.js#L59): unsafeDirectSockets targets the actual user Worker with proxy:false. The Miniflare control socket uses a separate ephemeral loopback port. No dispatchFetch call substitutes for workload HTTP/WS traffic.
- cf:false disables Cloudflare metadata fetching; the Worker outbound fetch service rejects requests. The script does not load deployment configuration or environment management credentials.
- INSTALLATIONS receives a new random local D1 identifier; D1 and DO persistence are disabled. The existing schema is applied only to this ephemeral local database. No migration file is changed.
- Only the local ignored .dev.vars OPERATOR_TOKEN binding is read, retained in memory and never printed. ASSETS is a synthetic page, so this harness makes no browser/GUI/static-production-build claim.
- [Shutdown](../apps/relay/scripts/capacity-local-server.js#L71): SIGINT/SIGTERM dispose Miniflare. A 30-minute timer disposes it with a nonzero exit status. The ready line reports only loopback origin, local binding status, transport and sourceDigest.

Six [preflight safety tests](../apps/relay/scripts/capacity-local-server.test.js) passed without starting a listener, D1, subprocess or real secret read. Actual direct-network diagnostic runs are reported separately by the parent task.

## Existing native/client safety review

The A2 server does not loosen the existing workload guards:

- [Native preflight](../apps/teacher/src-tauri/src/application/remote_capacity_smoke.rs#L77) accepts only HTTP loopback and 1–40 clients, rejects supplied activation-code environment input, then verifies the effective RemoteControlService URL before credential or network operations.
- [Temporary app data and DB](../apps/teacher/src-tauri/src/application/remote_capacity_smoke.rs#L97) receive only synthetic roster/questions/answers. The test-specific Credential Manager service is selected by cfg(test), separate from the production service ([definition](../apps/teacher/src-tauri/src/application/remote_control.rs#L25)).
- [Native HTTP redirects](../apps/teacher/src-tauri/src/application/remote_control.rs#L123) are disabled. The [Node client preflight](../apps/relay/scripts/capacity-local.js#L13) independently rejects non-loopback origins, cross-origin fetches and redirects, checks the count/output bounds, and installs a 29-minute stop.
- The native workload has a 30-minute deadline and kills/waits its owned child on drop. The raw HTTP_CHUNK reservation ceiling remains 1 GiB and Teacher WS UTF-8 ceiling 2 GiB, checked before send ([counter](../apps/teacher/src-tauri/src/application/remote_capacity_metrics.rs#L145)). Reserved bytes may include a rejected final frame; they are conservative send-budget counters, not Cloudflare billable usage.
- Envelope size, stream/window caps, Student ping cadence and existing retry limits are unchanged by this admission work.

Limits of these local tools remain explicit: Credential Manager restore I/O errors are ignored in the existing RAII cleanup; a panic does not guarantee asynchronous Session close. The selected media directory is trusted operator input rather than a hostile-input containment API; each run must use the generated synthetic fixtures and retain their hashes. Node output confinement is lexical, while the new snapshot loader also uses realpath. These are not a production provisioning/cleanup runner or a general filesystem sandbox.

## Manifest requirements and verification

HEAD alone cannot identify an uncommitted experiment. The final A2 source/harness manifest must include exact bytes of all changed and new source/test/tool files, including admission.js, admission.test.js, worker.js, phase16f-security.test.js, both direct-server files, the native diagnostics and capacity-local.js. Preserve the pre-A2 snapshot manifest rather than replacing its identity.

For each measured run, retain its actual frozen relay module digest, actual Student HTTP bundle hash, native test binary/build identity, synthetic fixture hashes and toolchain versions. A current-source manifest must not retroactively identify a run using an older snapshot. The direct server's sourceDigest covers its sorted relay module filename/SHA-256 records only; it is not the whole repository/harness digest and must be labeled separately.

Verification actually performed for this slice:

- Initial admission regression: 8 PASS / 6 FAIL before integration, then 14 PASS.
- Slow-body/cancel regression: 2 FAIL before, then 2 PASS.
- Rejected-IP map poisoning: 2 FAIL before ordering correction, then 2 PASS.
- Final combined admission/security command: 18 admission + 13 security = **31 PASS**.
- Direct-server preflight: **6 PASS**; Node syntax check PASS.
- Scoped git diff --check PASS; informational LF/CRLF warning only.

No claim is made that these local results establish production readiness. Worker isolate replacement, multiple PoPs and DO reconstruction reset in-memory counters. Shared-NAT abuse can consume a group's budget; accepted attempts across changing addresses can still fill the bounded map and temporarily deny new addresses. These residual distributed-availability/cost risks need explicit Pass B planning and pilot acceptance, not a silent assertion of global protection. No durable rate-limit service, WAF/billing change, R2 or new authentication product was introduced.
