# ADR-012: Teacher basic data management boundary

## Status

Accepted for Phase 3.

## Decision

Teacher CRUD UI flows through a typed frontend service (`services/teacherApi.ts`), Tauri commands, `PersistenceService`, and the existing repositories. React components do not know about SQLite, rusqlite, database paths, or raw SQL. IPC requests and responses use dedicated application DTOs.

The Teacher shell owns page navigation and feature-level state with built-in React hooks. Mutations refetch or update the current feature list; no query or global state framework is introduced. Validation is performed in the form for immediate feedback and again in Rust repositories as the authoritative boundary.

Classroom and course deletes preserve Phase 2 foreign-key restrictions. The UI confirms destructive actions and presents safe conflict messages through `AppError` codes. Sessions, question editing, quiz, networking, cloud sync, grouping, grading, and other later workflows remain disabled or out of scope.
