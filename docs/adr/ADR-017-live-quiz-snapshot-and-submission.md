# ADR-017: Live quiz snapshots and submissions

## Decision

Phase 9 copies a validated Question Bank question into an immutable `SessionQuestion`, copies managed media into session-owned storage, and grades typed Student answers in Rust from that snapshot. `source_question_id` and `source_asset_id` are traceability-only nullable foreign keys.

Submissions are immutable revisions keyed by a stable, cryptographically random client-generated UUID. The Student browser uses Web Crypto `randomUUID()` with a UUIDv4 `getRandomValues()` fallback. The server replays an identical stored submission ID even after a lock, rejects a reused ID with a different payload, and creates the next revision in an immediate SQLite transaction. Student grade visibility is fixed to after reveal.

## Consequences

Source edits/deletions cannot alter a running lesson. The browser is not a grading authority, cannot receive hidden/correct data before reveal, and cannot obtain hidden question media, filesystem paths, or credential-bearing URLs. Session assets are retained for future history/archive work; retention cleanup is intentionally deferred.
