# ADR-013: Question Domain and Grading Contract

## Status

Accepted for Phase 4.

## Decision

Questions use a discriminated union for `true_false`, `single_choice`, `multiple_choice`, `fill_blank`, and `essay`. Choice options have stable IDs, multiple choice uses exact-set matching, fill-blank grading is deterministic (`trim`, Unicode NFKC, configurable case sensitivity), and essay answers remain pending manual or peer review.

The TypeScript grading package is reusable for editor previews and future cloud adapters. The Rust grading module consumes the same checked-in JSON vectors and is the authoritative local grading boundary. Neither implementation depends on React, Tauri, SQLite, network services, or Supabase.

Persisted question configuration is version `1`. The existing `0001_initial_local_schema.sql` already contains the required QuestionSet/Question tables and JSON configuration columns, so it remains immutable and no `0002` migration is needed. Points use the existing integer column and must be positive.

Question authoring DTOs contain answer configuration; any future student/public DTO must be a separate projection and must not expose correct answers or accepted answers.

## Consequences

- Zod validates frontend/editor inputs while Rust validates all persisted/application inputs authoritatively.
- Invalid answer structures are structured grading errors, not incorrect scores.
- QuestionSet deletion remains restricted while questions exist and is exposed as a safe conflict error.
- Teacher Question Bank, editor, and answer-safe preview UI are implemented in Phase 5; session answering, assets, and cloud/realtime behavior remain future work.
