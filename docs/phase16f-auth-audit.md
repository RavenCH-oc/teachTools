# Phase 16F Pass A — Rust / Student authentication and recovery audit

**2026-10-26 update:** [Pass A2](phase16f-pass-a2.md) records the failed-join cache, provisional quota and re-auth race fixes plus before/after tests. Preserve the remaining bearer/roster identity and production acceptance limitations below.

Audit date: 2026-10-25. Canonical baseline: `c5285196a08e412732eb2246efd78e3c9644d15a`.

This evidence covers native authorization and the Student transport, not the entire release. Worker/DO public admission, deployment, pricing, capacity measurements, and final RC evidence are recorded separately. No production request, D1 write, installation revocation, production credential inspection, GUI operation, or deployment was performed by this audit. All native fixtures used temporary synthetic Classroom databases/assets; the one native control test used a loopback mock and the test-only Credential Manager target.

## Findings and adoption boundaries

| Finding | Severity / status | Evidence and consequence |
| --- | --- | --- |
| Roster identity is not strong identity | Material adoption limitation; acceptance required | `LocalSessionService::join` matches seat and normalized name against the roster. A person who knows the Remote locator and another student's roster identity can attempt to join first and occupy that seat. Session/credential scope checks do not establish that the bearer is the intended human. |
| Stolen bearer is usable by its holder | Material adoption limitation; acceptance required | AUTH and HTTP compare the secret against the participant's stored hash. Browser resume storage contains the bearer by design. Same-origin compromise or access to the browser profile can defeat possession-based identity. No account/OTP mechanism was added. |
| Failed join attempts can exhaust recovery capacity | `FAIL_BLOCKER` for unrestricted public availability at the baseline; coordinated with the relay audit | `RemoteParticipants::join` caches successful **and failed** attempts for 120 seconds, up to 128 entries. The existing `recovery_is_bounded_and_expiry_does_not_create_duplicate_participants` test fills this cache with invalid roster attempts and then receives `REMOTE_SERVICE_UNAVAILABLE` for a valid join. Bounded memory does not by itself protect classroom availability. The relay audit must resolve or explicitly retain this finding; this audit made no runtime change. |
| Media admission has no automatic retry at baseline | Baseline capacity failure; narrowly corrected, integrated capacity remains separately measured | Baseline `studentHttpRead` performs one fetch. `ProtectedImage` and `ProtectedPdf` provide manual retry. The local fix below changes only recognized Remote media saturation recovery. A harness must retain first-attempt failures and report actual post-fix client policy separately. |
| Complete media Blob required before display | Existing implementation limitation | Native reads and hashes a complete `Vec<u8>`; Student consumes the complete Blob before image display/PDF opening. HTTP completion measurements are not perceived mobile rendering measurements. |

A bounded pilot requires controlled URL distribution, a known roster/cohort, Teacher attendance checks, and explicit acceptance of the impersonation/bearer threat model. Those controls reduce exposure but are not strong authentication. The user's Phase 16E acceptance of the observed media delay does not automatically accept these admission risks or prove classroom-scale capacity. Do not silently introduce a new login product to change the scope.

## Evidence map

Paths below are repository-relative. `PASS` means the specified local source/test gate, not production or installed-device acceptance.

| Gate | Source symbols | Existing focused evidence executed in this pass | Status / missing evidence |
| --- | --- | --- | --- |
| Credential target, scope, fail closed | `application/remote_control.rs`: `credential_entry`, `read_installation`, `write_installation`; native keyring store 1.1.0 `Store::new`, `Cred::build_from_specifiers`, `CredPersist` | `remote_create_opens_roster_lobby_without_starting_lan_listener`, with test target restore guard | `PASS` source and isolated native access. Cross-process installed persistence is not rerun here. |
| New joins only in LOBBY | `application/local_session.rs`: `open_session_for_join`, `join`; `repositories/local_session.rs`: `create_participant` | `session_join_and_credential_lifecycle_are_safe`; Remote adapter tests | `PASS`. DB Immediate transaction rechecks LOBBY/serverInstance and unique seat before INSERT. Full concurrent close/read/mutation fault injection remains a separate gate. |
| Lost response and bounded recovery | `application/remote_participant.rs`: `RemoteParticipants::join`, `JoinRecovery`, TTL and count limits | `lost_join_response_recovers_exact_result_without_duplicate_participant`; `invalid_roster_and_changed_logical_attempt_are_rejected`; `recovery_is_bounded_and_expiry_does_not_create_duplicate_participants` | `PASS` correctness: exact same actor Session/attempt/identity recovery; changed identity rejected; expired recovery cannot duplicate the seat. Availability finding above remains separate. |
| AUTH independent of relay claims | `participant_realtime.rs`: `authenticate_sync`; `local_session.rs`: `authenticate`; `remote_participant.rs`: AUTH branch | `shared_remote_auth_requires_exact_participant_session_credential_and_version`; `auth_is_rust_scoped_and_generation_reauth_restores_personalized_sync` | `PASS` native component gate. |
| New generation / reconstruction reauth | `remote_participant.rs`: current-generation checks, `disconnect_all`, AUTH; `studentApi.ts`: `createParticipantTransport` | `same_connection_hibernation_reauth_revalidates_with_rust`; Remote Student tests for reauth, old sockets, mismatched identity, waiting for sync | `PASS` component gate. Real DO restart/network recovery timings are not inferred from mocked tests. |
| No mutations before AUTH and personalized sync | `studentApi.ts`: `authenticated`, `authValidated`, `syncBeforeResume`, send guards; `remote_participant.rs`: REALTIME branch | Remote Student transport and `RemoteApp` tests, including original submissionId retry only after reauth sync | `PASS` component gate. There is no general offline mutation queue. |
| Quiz write guards and pre-reveal privacy | `participant_realtime.rs`: trusted connection identity to `quiz.submit`; existing Quiz repository write guard / Student projection | `shared_remote_quiz_keeps_ack_idempotency_write_guards_and_reveal_privacy` | `PASS`: same submission replay, trusted Session/participant/state and withheld correctness/score until reveal. |
| Grouping / frozen Peer Review authority | `participant_realtime.rs`; `peer_review_student.rs`; repositories `peer_review_student.rs`, frozen assignment/group membership | `shared_remote_grouping_capacity_failed_move_and_reconnect_remain_authoritative`; `shared_remote_peer_review_ack_retry_revision_conflict_and_reauth_keep_state`; cross-group shared authorization/revision tests | `PASS` for executed native component cases; no semantics changed. |
| Independent HTTP authorization | `participant_http.rs`: `ParticipantHttpService::read`; `local_session.rs`: `authenticate` | `shared_http_reads_keep_assignment_revision_cursor_and_participant_authority` | `PASS`: each read checks Session/participant/credential and expected Remote Session; an authenticated WS is not a substitute. |
| Cursor / assignment / feedback privacy | `repositories/peer_review_student.rs`: `PageRequest::bounds`, `authorize_assignment`, `essays`, `own_review`, `feedback_detail` | Same shared HTTP test plus frozen cross-group large detail test | `PASS`: participant-scoped cursor rejected for another participant; unauthorized assignment and feedback rejected; feedback DTO omits reviewer participant identity; frozen exact Essay submission is read. |
| Asset scope / integrity | `live_quiz.rs`: `read_asset_for_session`, `read_asset`, `resolve_session_path` | `lan_authenticated_media_uses_shared_http_boundary_and_preserves_integrity`; existing `hidden_session_assets_are_not_available_until_question_opens` located but not rerun by this audit | `PASS` source gate and LAN integrity case. Asset's question must match Session and be OPEN/LOCKED/REVEALED; bytes must match stored SHA-256. No new real-browser image/PDF render evidence. |
| Strict transport/input boundary | `remote_participant.rs`: envelope parse, `deny_unknown_fields`, version, 64 KiB ceiling; `studentHttpApi.ts`: operation schema | malformed/oversize/unsupported protocol native tests; Student UTF-8 ceiling, forged field/path tests | `PASS` for exercised malformed/oversized inputs. Worker resource admission is a separate gate. |
| Cancel / object URL lifecycle | `studentHttpApi.ts`: signal forwarding and AbortError; `App.tsx`: `ProtectedImage`, `ProtectedPdf` | Student HTTP abort, partial-body, MIME tests; source inspection for UI cleanup | `PASS` service-level cancellation. Image effect aborts/revokes; PDF replacement/unmount aborts, object URLs revoked after use timeout. Browser lifetime/memory and perceived render under load remain `NOT_VERIFIED` in this audit. |
| UI injection | React render path, Student source search | No `dangerouslySetInnerHTML`, `innerHTML`, `eval(` or `new Function` occurrence in Student `.ts/.tsx` | `PASS` scoped source review; not a claim of exhaustive XSS proof or external penetration testing. |
| LAN independence | `remote_control.rs`: Remote create plus auto-open LOBBY; `local_server.rs` separate listener | `remote_create_opens_roster_lobby_without_starting_lan_listener` and shared LAN authenticated media test | `PASS` local seam. No active Session transport switch introduced. Production outage / installed LAN interaction awaits later gates. |

## Actual Windows Credential Manager target and scope

The production service is `Classroom.RemoteInstallation`, user is `teacher`. The application constructs the default `windows-native-keyring-store` store, whose delimiter is a dot; without a target modifier it constructs `{user}.{service}`. Therefore the native generic target is:

- Production: `teacher.Classroom.RemoteInstallation`.
- `cfg(test)`: `teacher.Classroom.RemoteInstallation.Phase16CTest`.

The modifier `persistence = Local` maps to `CRED_PERSIST_LOCAL_MACHINE`, not `Enterprise`. It persists for subsequent logons of the **same Windows user on the same machine**. It does not imply access by all Windows users or roaming to another computer. This interpretation was checked against [Microsoft's CREDENTIALW documentation](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw) on 2026-10-25.

`read_installation` validates the stored UUID and credential shape and returns a controlled store error for malformed/unavailable credentials. There is no file/SQLite/plaintext fallback. The installed dependency source was read only; its FFI `unsafe` and internal `unwrap` are dependency code, not newly introduced project code. The audit did not enumerate/read the production Credential Manager entry.

The executed loopback control test uses `TestInstallationRestore`: it saves/restores a pre-existing **test-only** value or removes only the value created for the test. It never writes the production target. The environment-driven `local_relay_and_windows_credential_lifecycle` smoke was intentionally not invoked: it requires separately isolated relay/enrollment setup, and its existence alone is not new PASS evidence.

## Recovery semantics and remaining fault-injection evidence

| Scenario | Observed local evidence | Result / action and missing measurement |
| --- | --- | --- |
| Student reconnect / old socket late event | Student transport test swaps sockets and sends old event; current socket identity and generation checks ignore it | `PASS` component behavior; no human action in the simulated automatic path. Real network recovery latency not measured here. |
| Teacher offline / REAUTH_REQUIRED while idle | Remote Student tests inject controls without an initiating mutation/poll | `PASS` component behavior: mutation/heartbeat paused, reauth on same socket, resume only after sync. Relay alarm timing is separate. |
| Lost Quiz ACK | Native replay/write-guard test and `RemoteApp` test retry exact prior submissionId after new sync | `PASS` component correctness; no second accepted submission. Real packet loss latency / entire-class workload is not inferred. |
| Same-connection DO reconstruction reauth | Native adapter revalidates AUTH; Student waits for AUTH/sync | `PASS` component check; integrated reconstruction timing / reauth storm counts are separate. |
| Teacher graceful close / silent network loss during media | Source checks only in this audit | `NOT_VERIFIED` fault injection here. Require relay/capacity evidence for immediate close vs deadline behavior, ACK/presence and false-offline counts. |
| Teacher reconnect interrupts HTTP | Existing HTTP control boundary reviewed; no new injection by this audit | `NOT_VERIFIED` here; refer to the capacity/relay run for resource release and non-concatenation across generations. |
| Teacher process restart | `LocalSessionService::initialize` calls `end_stale_sessions`, ending prior CREATED/LOBBY/ACTIVE with `server_restart` | Source confirms **ends old classroom, not resume**. New process with in-flight requests was not injected here (`NOT_VERIFIED`). |
| Close/expiry racing join/read/mutation | LOBBY rechecked inside Immediate transaction; HTTP auth per request and native mutation write guards retained | Source protection confirmed; complete concurrent close/expiry timing coverage `NOT_VERIFIED` here. |

Student reconnect delay progresses through 1s, 2s, then 5s intervals. This is different from GET saturation recovery: at baseline a media GET receives one attempt and a manual reload path; the evidence-supported local change below adds a finite retry only for its existing saturation response. Do not combine those policies in capacity claims. Recovering an already accepted answer by its original idempotency key is not an unrestricted offline mutation queue.

## Evidence-supported local media retry correction

The capacity lane measured the baseline using the actual bundled `studentHttpRead`, independent participants, real Rust services, and local relay protocol. The same synthetic 2 MiB image produced:

| Students requesting simultaneously | Baseline first attempt | Baseline observed completion |
| --- | --- | --- |
| 1 | 1/1 success | 290 ms |
| 4 | 4/4 success | 883-1042 ms |
| 5 | 4/5 success; one HTTP 429 `REMOTE_SERVICE_UNAVAILABLE` at 42 ms | Four successes at 885-1036 ms; rejected Student remains failed without manual retry |

This confirms controlled admission rather than five-person automatic completion. It justified a local change in `apps/student/src/services/studentHttpApi.ts` and focused tests in `studentHttpApi.test.ts`; the transport window and stream quotas remain unchanged.

The new policy is deliberately narrow:

- Only Remote `SESSION_ASSET_GET`, HTTP 429, and JSON `code = REMOTE_SERVICE_UNAVAILABLE` are retryable. Detail GETs and LAN GETs retain their existing single-attempt behavior. No mutation is replayed.
- Error inspection uses a clone with a 1,024-byte accumulated body cap and a 1-second deadline, validates JSON MIME, and does not trust a small declared Content-Length by itself. Malformed, oversized, slow or unknown errors do not trigger retry. Clone cancellation is not awaited because a tee can otherwise wait for its original branch.
- At most 16 retries after the initial request. Backoff ceilings are 250 ms, 500 ms, 1,000 ms, then 2,000 ms; equal jitter selects 50-100% of each ceiling. No new attempt is admitted after a 30-second monotonic budget from the initial request.
- The 30-second limit is a **retry-admission** budget, not a total GET/body timeout. Successful 100 MiB PDF transfer remains subject to the existing stream/timeout contract. No successful partial body is replayed or concatenated.
- AbortSignal cancels error inspection and backoff promptly, prevents new fetches, and is forwarded to each actual fetch. A missing signal is supported. Exhaustion returns the last untouched controlled response to the existing error UI.
- HTTP 401/403/5xx, network failure, different 429 codes, and interrupted successful bodies are not retried. The 4-per-Session / 1-per-participant media limits, 32 KiB chunks and four-credit window are not changed.

Post-fix capacity is measured by the main capacity lane after rebuilding the actual client bundle. The unit-test result below is not a 40-person capacity claim; compare the separate before/after matrix, including first-attempt rejection and eventual completion.

Post-fix focused verification actually executed:

```powershell
pnpm --filter @classtools/student exec vitest run src/services/studentHttpApi.test.ts src/services/remoteStudentApi.test.ts src/RemoteApp.test.tsx
pnpm --filter @classtools/student run typecheck
pnpm --filter @classtools/student exec eslint src/services/studentHttpApi.ts src/services/studentHttpApi.test.ts
```

Results: **47 tests PASS** (27 HTTP, 12 Remote transport, 8 Remote App), TypeScript PASS, focused ESLint PASS. The HTTP suite adds 20 cases for recovery, equal jitter, attempt exhaustion, scheduling deadline, abort with/without pending inspection, no-signal use, authentication/non-media/LAN exclusions, bounded malformed-body handling, and non-replay of successful body interruption. The HTTP file alone was rerun after its final typed fixture correction: **27 PASS**. An initial jitter assertion ignored integer timer rounding and an initial test fixture inferred an optional-undefined header value; both were test issues corrected before the recorded final PASS. No runtime ceiling was loosened to make a test pass.

Across the initial audit and this follow-up there are **66 distinct executed tests** (47 Student + 19 Rust); repeated runs do not add distinct coverage. No new full build or broad suite was run by this audit lane.

## Focused verification actually executed

Commands ran on the baseline implementation before another audit lane added test-only capacity instrumentation. No full historical suite was run. Tests use synthetic fixture data; no true participant/activation/installation secret appears in this report.

From the repository root:

```powershell
pnpm --filter @classtools/student exec vitest run src/services/remoteStudentApi.test.ts src/RemoteApp.test.tsx src/services/studentHttpApi.test.ts
```

Result: **27 tests PASS**, 3 files: Remote transport 12, Remote App 8, HTTP API 7.

From `apps/teacher/src-tauri`:

```powershell
cargo test --lib shared_
cargo test --lib session_join_and_credential_lifecycle_are_safe
cargo test --lib application::remote_participant::tests
cargo test --lib remote_create_opens_roster_lobby_without_starting_lan_listener
```

Results: **10 + 1 + 7 + 1 = 19 Rust tests PASS**, all distinct. The `shared_` filter also matched two existing low-cost grading/statistics tests; its count must not be represented as ten dedicated auth tests.

The ten `shared_` matches were:

1. `grading::tests::shared_vectors_match_rust_grading`
2. `application::statistics::tests::service_is_constructible_without_cache_or_shared_connection`
3. `application::participant_realtime::tests::shared_remote_auth_requires_exact_participant_session_credential_and_version`
4. `infrastructure::persistence::repositories::peer_review::tests::cross_group_frozen_bundles_shared_authorization_and_revision_race`
5. `infrastructure::persistence::repositories::peer_review::tests::student_tests::cross_group_large_detail_pages_use_frozen_membership_and_shared_revision`
6. `application::local_server::tests::peer_review_tests::lan_authenticated_media_uses_shared_http_boundary_and_preserves_integrity`
7. `application::participant_realtime::tests::shared_remote_grouping_capacity_failed_move_and_reconnect_remain_authoritative`
8. `application::participant_realtime::tests::shared_remote_peer_review_ack_retry_revision_conflict_and_reauth_keep_state`
9. `application::participant_realtime::tests::shared_remote_quiz_keeps_ack_idempotency_write_guards_and_reveal_privacy`
10. `application::participant_realtime::tests::shared_http_reads_keep_assignment_revision_cursor_and_participant_authority`

An initial `cargo test --lib participant_realtime_tests` selected **zero tests**. It was corrected to the real module/test-name filter above; the zero-match command is not counted as coverage. Total executed distinct tests in this audit: **46** (27 Student + 19 Rust), not including the zero-match command.

Source searches:

```powershell
rg -n '\bunsafe\b|\.unwrap\(\)' apps/teacher/src-tauri/src --glob '*.rs'
rg -n '\.expect\(' apps/teacher/src-tauri/src --glob '*.rs'
rg -n 'dangerouslySetInnerHTML|innerHTML|eval\(|new Function' apps/student/src --glob '*.ts' --glob '*.tsx'
```

At the audited snapshot there were no project-source `unsafe` or `.unwrap()` matches. `.expect()` occurrences were confined to explicit test/smoke files or `cfg(test)` sections after source classification; no production candidate was found. This is a lexical plus source-boundary audit, not an assertion about transitive dependencies or a formal static proof. This lane changed only the Student saturation retry seam, its focused tests, and this report; no dependencies or schema changes were introduced.
