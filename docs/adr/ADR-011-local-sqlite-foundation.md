# ADR-011: Local SQLite foundation

## Status

Accepted for Phase 2.

## Decision

The Teacher desktop application owns a local SQLite database at the Tauri app-data directory (`classroom.sqlite3`). SQLite is compiled with rusqlite's `bundled` feature so the desktop build does not depend on a machine-installed SQLite runtime.

Each repository operation opens a short-lived connection through `Database::connection()`. Transactions are created and committed by the repository that owns the unit of work. The application does not keep a process-wide `Arc<Mutex<Connection>>`; this keeps synchronous rusqlite work isolated and leaves a later async boundary explicit.

Connections enable foreign keys, use a five-second busy timeout, and use WAL journaling with `synchronous=NORMAL`. Timestamps are canonical UTC RFC3339 strings and domain IDs are UUIDv7 values generated in Rust.

## Migration policy

SQL migrations are source-controlled under `apps/teacher/src-tauri/migrations/`. Every migration is applied in an immediate transaction and recorded in `schema_migrations` with a stable ID, SHA-256 checksum, and UTC application time. A checksum mismatch or failed migration aborts startup; a later startup reopens the database and performs a no-op for already verified migrations.

The Phase 2 schema is deliberately explicit SQL. No ORM, HTTP server, cloud SDK, or synchronization behavior is introduced.
