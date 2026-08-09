# Classroom Codex Instructions

## Scope

This `AGENTS.md` applies to the entire repository unless a more specific nested `AGENTS.md` explicitly overrides part of it.

## Communication Language

* Source code, identifiers, filenames, package names, APIs, schemas, database objects, protocol names, and Git commit messages must use English.
* User-facing application UI text should use Traditional Chinese (`zh-TW`) unless a task explicitly specifies otherwise.
* Final Codex task reports, implementation summaries, warnings, architecture explanations, validation summaries, and questions addressed to the user must use Traditional Chinese (`zh-TW`).
* Established technical terms may remain in English when that is clearer, including terms such as Rust, Tauri, React, TypeScript, SQLite, PostgreSQL, Supabase, WebSocket, QuestionAsset, SessionBackend, UUIDv7, IPC, and API.
* Do not translate source-code identifiers into Chinese merely to satisfy the communication-language rule.

## Technology Contract

Primary technology stack:

* TypeScript
* React
* Vite
* Tauri 2
* Rust
* SQL
* SQLite
* PostgreSQL / Supabase when cloud phases are implemented

Python is not permitted in this project.

Do not introduce:

* Python runtime
* Python scripts
* Python sidecars
* FastAPI
* Flask
* Django
* Python build helpers
* Python PDF/image helpers

Do not introduce Electron, C#, Java, Go, or another application runtime unless an explicit architecture decision and task instruction authorizes it.

## Architecture

Maintain the established Local-first + BYO Supabase architecture.

Frontend components must not directly access:

* SQLite
* rusqlite
* raw SQL
* Supabase tables

Expected dependency direction:

```text
React
→ typed frontend service
→ Tauri IPC / backend contract
→ application service
→ repository/backend
→ SQLite / filesystem / future cloud implementation
```

Do not bypass architectural boundaries for convenience.

## Rust

Rust is used for Tauri/native/local-backend responsibilities.

Requirements:

* Use stable Rust.
* Do not add `unsafe` to project source unless explicitly approved by an ADR and task requirement.
* Do not use `unwrap()` or `expect()` in production paths.
* Test-only `unwrap()` / `expect()` may be used sparingly for test setup/assertions.
* Prefer explicit `Result`-based error handling.
* Do not expose raw `rusqlite`, filesystem, panic, or backtrace errors through IPC.
* Keep Tauri commands thin.
* Keep business logic in application/domain services.
* Do not introduce `Arc<Mutex<Connection>>`, global mutable database state, or similar shared-state shortcuts.
* Preserve SQLite connection-per-operation unless a future reviewed architecture decision changes it.
* Do not introduce async runtimes, background threads, `Mutex`, or `RwLock` unless the phase genuinely requires them and the final report explains why.

## TypeScript / React

* Keep TypeScript strict.
* Do not use `any` as a routine escape hatch.
* Avoid `invoke<any>()`.
* Do not use repeated `as unknown as ...` casts to bypass contracts.
* Runtime boundaries should use established validation schemas.
* Reuse shared domain and validation packages instead of creating duplicate UI-only business contracts.
* Keep `App.tsx` focused on application composition/navigation rather than feature implementation.
* Put substantial features in feature-specific modules.
* Do not add large UI, form, state, query, drag-and-drop, or utility frameworks unless the task clearly requires them.

## SQL / Persistence

* Schema changes must use source-controlled migrations.
* Never edit an already committed migration to change an existing schema.
* Add a new ordered migration instead.
* Preserve migration checksum and fail-closed behavior.
* Keep domain identity based on UUIDs rather than SQLite row IDs.
* Persist canonical timestamps in UTC.
* Keep SQLite foreign keys enabled on every connection.
* Do not introduce ORM auto-sync behavior.

## Filesystem / Assets

* Application-managed files must live under the application-managed data directory.
* Do not persist source absolute paths as canonical asset references.
* Do not expose arbitrary filesystem read/write/delete IPC commands.
* Source files selected by teachers must never be deleted by import operations.
* Public/student projections must not expose local filesystem paths or teacher-only storage metadata.

## Security / Privacy

* Student/client input is never authoritative for grades.
* Do not expose correct answers through student/public DTOs.
* Do not expose credentials, participant tokens, raw SQL errors, filesystem internals, or technical stack traces to clients.
* Do not log secrets or unnecessary student personal data.
* Preserve Row Level Security requirements when Supabase work begins.
* Fail closed when schema/security state is incompatible.

## Dependencies

Before adding a direct dependency:

1. Check whether the existing stack can reasonably solve the problem.
2. Prefer small, mature dependencies.
3. Avoid introducing entire frameworks for narrow tasks.
4. Report every new direct dependency and its purpose in the final task report.

Python dependencies are forbidden.

## Testing

For implementation phases, run the tests relevant to modified areas.

Unless a task explicitly narrows validation, the expected full verification is:

```text
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```

For Rust/Tauri changes:

```text
cargo fmt --check
cargo check
cargo test
cargo clippy --all-targets --all-features -- -D warnings
```

Run runtime smoke tests when the task changes Tauri startup, persistence, filesystem/media behavior, IPC, networking, or other behavior that cannot be validated adequately by unit tests alone.

Never claim a test passed if it was not actually run.

## Git

* Preserve a clean phase-by-phase Git history.
* Do not modify previous baseline commits.
* Do not commit unless the task explicitly instructs you to commit.
* Before finalizing implementation work, run:

```text
git status --short
git diff --check
git diff --stat
```

* Do not track runtime databases, WAL/SHM files, `target/`, `node_modules/`, logs, secrets, temporary smoke fixtures, or other build/runtime artifacts.

## Scope Discipline

Implement only the requested Phase.

Do not opportunistically begin later phases.

Do not add placeholder implementations that falsely imply future functionality is complete.

If a future capability needs an architectural seam, define the seam without implementing the future feature.

## Final Report

Final task reports must be written in Traditional Chinese (`zh-TW`).

Use English technical identifiers where appropriate.

Reports should clearly include:

* status
* baseline
* files/areas changed
* architecture decisions
* dependencies added
* tests and runtime verification actually performed
* Git status
* warnings or architecture concerns
* readiness for the next phase

Do not automatically begin the next Phase after reporting completion.
