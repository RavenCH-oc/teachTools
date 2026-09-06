# Phase 12A — Peer Review Foundation

This phase provides internal Rust domain/application/repository APIs and persistence only. It adds no Teacher UI commands, Student endpoints, WebSocket messages, credentials, grades, rubrics, or statistics integration. Feedback is text-only and is never an authoritative score.

## Source and lifecycle

An activity belongs to one ACTIVE Session and one essay SessionQuestion from that Session. Creation stores DRAFT configuration; OPEN requires the question to be LOCKED or REVEALED. OPEN captures each participant's latest accepted submission **at that transaction**, not a dynamic latest-submission view.

Each target references the immutable `submissions.id` through a restrictive foreign key. Existing submission writes append new rows; they never replace the captured row. Reading a target joins that exact ID to obtain its revision and essay. No second essay copy or synthetic group submission is created. The SessionQuestion already owns its immutable source-question snapshot.

Transitions are DRAFT → OPEN → CLOSED or DRAFT → CANCELLED. Reopening returns a controlled error and never rerandomizes. Session End and stale restart recovery close OPEN activities and cancel DRAFT activities in the existing Session transaction. Assignment, target and response history is retained. Replaying an already accepted response is a read-only success after closure/end; new writes are rejected.

## Random one-to-one

The pool consists of participants with captured essays. At least two are required. Existing `getrandom` provides bounded random sort keys; a cyclic one-position shift produces one outgoing assignment and one incoming review per participant, without self-review or an unbounded retry loop. Assignments are persisted once. Sorting random-key ties by identity still yields a valid cycle. This is a randomized cycle, not a promise of uniform sampling over every possible derangement.

## Student selection

Only participants with a frozen essay are eligible reviewers. The API currently uses slot 1; the schema permits positive slots for future reviewed expansion. One reviewer occupies one target at a time. Self-review and targets from another activity are rejected.

`max_reviews_per_target = None` means unlimited; a positive value is a claim limit and zero is invalid. A claim consumes capacity immediately, even before feedback. Selecting the same target is idempotent. Moving before the first response updates the same assignment atomically; a full destination leaves the original claim intact. Any accepted response permanently locks its target.

Individual target status counts logical assignments, not response revisions: claimed count, submitted count (assignments with at least one response), remaining capacity, and whether any review was received. Cross-group consumers use group targets and their shared assignments instead of interpreting individual claim counts as group feedback counts.

## Cross-group

The DRAFT explicitly pins one immutable `session_group_set_id` belonging to its Session. Later grouping revisions never replace it. Eligible groups have members and at least one captured essay; empty/no-essay groups are excluded and at least two eligible groups are required.

A persisted cycle maps each reviewer group to one different target group. A group target is a bundle of only the captured essays that actually exist for that frozen membership. Missing essays are omitted, never invented. Each reviewer group owns one logical shared assignment. Any member of that frozen reviewer group may append feedback, including a member without an essay; outsiders cannot. Presence and later roster/grouping changes do not change this authorization snapshot.

## Responses and concurrency

Responses are immutable revisions ordered per assignment. A UUIDv7 response ID is the idempotency key. The normalized body is trimmed, nonempty, contains no embedded NUL, and is at most 10,000 Unicode scalar values. Every mode requires `expected_base_revision`, starting at zero. The next revision is base + 1.

An exact retry with the same assignment, submitter, normalized body and base returns its original record. Reusing the key with a different payload fails. A stale base fails with `ReviewRevisionConflict`; it does not overwrite another group member's edit. Latest response is derived from revision order; all older revisions remain available. Assignment status is derived as Assigned or Submitted, not maintained in a duplicate mutable column. There is no assignment-cancellation/release API in this phase.

Mutation operations use connection-per-operation and `BEGIN IMMEDIATE`. Capacity validation and moving the claim share one transaction; revision validation and insertion share one transaction. Concurrent contenders serialize and the loser observes full capacity or a stale revision. OPEN, captured targets, bundles, assignments and state transition commit together or all roll back. No new mutex, shared connection, background thread or async runtime is introduced.

## Migration 0006

Tables: `peer_review_activities`, `peer_review_targets`, `peer_review_group_targets`, `peer_review_group_target_items`, `peer_review_assignments`, `peer_review_responses`.

Foreign keys retain source submissions, participants, SessionQuestions and frozen grouping records with RESTRICT. Composite activity/group-set and activity/target keys prevent cross-owner references. CHECK constraints protect mode/state, positive capacity/slots, principal/target combinations and response revision/body shape. Unique keys enforce target membership, reviewer slots, random target uniqueness, cross-group assignments and per-assignment revisions. Indexes cover Session activity history, capacity and latest response reads.

Cross-table business rules (Session ACTIVE, essay type, same Session, frozen reviewer membership, self-review, capacity and expected base) are enforced by the repository inside the write transaction, not by treating caller input as authoritative. Trusted internal callers must not bypass this API with raw SQL. No generic SQL or filesystem access is exposed through IPC. Raw database errors map to a controlled Storage error.

Migrations 0001–0005 remain unchanged. Tests upgrade fresh and every prior schema version through 0006, preserve prior metadata/checksums, reopen the file and reject checksum tampering. Historical records are not deleted by activity close, Session End or roster removal.

## Internal application API

`PeerReviewService` exposes `create_activity_draft`, `get_activity`, `list_session_activities`, `open_activity`, `close_activity`, `cancel_draft`, `claim_target`, `list_target_statuses`, `list_group_targets`, `list_assignments`, `get_assignment`, `submit_review_revision`, and `list_review_revisions`.

These are Rust library APIs, not transport-safe Student DTOs. Future transport adapters must derive participant identity from authentication and build narrow authorized projections; they must not publish the internal target/assignment models wholesale. No adapter or future UI is implemented here.

## Verification coverage

Repository tests cover 2/5-person cycles, source validation, frozen latest submissions, rollback after a partial OPEN failure, claim/move/capacity rules, concurrent last-slot contention, unlimited capacity, revision idempotency, concurrent group edits, immutable group revision selection, retained history after restart/Session End/roster deletion, and foreign-key restrictions. Statistics snapshots before and after feedback remain identical; essays stay pending with no score or correctness assigned.

This foundation is ready for a separately authorized Phase 12B Teacher setup workflow. It does not constitute Peer Review human UI QA.

## Phase 12B — Teacher activity setup

The ACTIVE Live Quiz surface links to 同儕互評, with the current essay selected when available. The feature page owns temporary form state only; all saved activities, configuration and lifecycle state are loaded from SQLite. App navigation uses the existing dirty-confirmation pattern; switching activities/questions also confirms discarding unsaved inputs. Save reloads authoritative state. A failed save retains inputs unless the backend reports a terminal Session/activity. Refresh/read failures disable editing until authoritative state is available again.

Teacher-only commands are `get_peer_review_setup_context`, `create_peer_review_activity`, `update_peer_review_activity_draft`, `open_peer_review_activity`, `close_peer_review_activity`, and `cancel_peer_review_activity`. The context includes activity detail/list, essay SessionQuestion snapshot summaries, current eligibility counts, fixed target counts, and all finalized GroupSet revisions with per-question group preflight counts. Initial loading is **one IPC**, not a frontend request loop. Each mutation is followed by one context reload. The backend uses a consistent read transaction for the aggregate; it does not return raw essays, responses, student identities, credentials, IPs or scores. TypeScript request/response schemas use the existing validation package and reject unexpected fields.

12A permitted multiple activities for a question. The 12B Teacher adapter now requires at most one DRAFT/OPEN per SessionQuestion, while permitting CLOSED/CANCELLED history. Teacher create/edit perform validation and the uniqueness check under `BEGIN IMMEDIATE`; Teacher OPEN rechecks the policy inside the existing OPEN transaction. Existing duplicate 12A drafts are not deleted or migrated: the Teacher must cancel extras. The internal 12A library semantics remain unchanged and are not directly exposed by Tauri. Future Teacher writers must use this adapter, not bypass it. No migration or partial-index retrofit is needed for this controlled write surface.

DRAFT editing can change question, mode, capacity or GroupSet, but cannot move to another Session. OPEN/CLOSED/CANCELLED configurations are read-only. Random preflight shows the count of participants with accepted essays; assignment happens only on backend OPEN. Student Select exposes positive safe-integer capacity (including 3 or larger) or explicit 不限/None; zero and unsafe JS integers are rejected at the Teacher boundary. The reviewer slot remains 1. Cross Group defaults to the highest finalized revision, allows historical selection, and shows group essay counts without answer contents. At least two eligible participants/groups and a LOCKED/REVEALED essay are required to OPEN. Preflight is advisory; OPEN revalidates and freezes the then-current accepted revisions transactionally.

OPEN confirmation explains fixed answer versions and locked settings. OPEN displays its persisted target count, never the current submission count. CLOSE preserves feedback history; only DRAFT offers CANCEL. Terminal Sessions show read-only records. Saved DRAFTs survive page navigation and repository reopen. **Full application restart retains the records but existing 12A stale-Session recovery ends the previous Session, cancels DRAFTs and closes OPEN activities.** 12B does not revive old Sessions or change this recovery contract; “survive restart” means retained history, not an editable DRAFT after stale recovery.

The UI states: 同儕互評只作為回饋紀錄，不計入正式成績。There is no same-group mode, Student transport/UI, target claiming UI, feedback submission/viewer, completion monitoring, grade integration or results dashboard. Student UI remains deferred to 12C; monitoring/results to 12D. Cosmetic redesign is deferred. Migration files 0001–0006 are unchanged; no 0007 or new direct dependencies are introduced.

### Phase 12B closeout acceptance

User-reported Human QA: PASS (13/13). Functional UI QA: PASS. The accepted checks cover locked/revealed essay setup, Random draft/open/close, Student Select capacity 3 and invalid inputs, draft cancellation, current/historical Cross Group revisions, insufficient-group blocking, frozen GroupSet and essay targets, restart recovery, Session End, and keyboard/dirty-state operation.

Restart semantics are `EXPECTED_RECOVERY_BEHAVIOR`, not a warning or blocker: stale Session recovery ends the Session, changes DRAFT to CANCELLED and OPEN to CLOSED, and retains all Peer Review records. It does not resume an editable draft. Phase 12A and Phase 12B acceptance are complete; Phase 12C/12D remain unimplemented. Starting Phase 12C still requires the baseline's manual push and remote verification.
