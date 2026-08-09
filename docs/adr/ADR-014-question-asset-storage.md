# ADR-014: Local QuestionAsset Storage

## Status

Accepted for Phase 6.

## Decision

Question assets are local-first and belong to exactly one persisted Question. The Teacher application copies a selected file into its own app-data asset root; it never moves, deletes, or persists the source path. Asset IDs are UUIDv7, final filenames are backend-generated `<uuid>.<known-extension>` names in an `assets/<id-prefix>/` shard, and display names are metadata only.

Phase 6 supports PNG, JPEG, WebP, and PDF. Rust validates extension plus magic bytes, enforces a 20 MiB image limit and 100 MiB PDF limit, computes a SHA-256 checksum, and rejects same-question duplicate content. The migration `0002_question_assets_foundation.sql` adds nullable legacy-safe checksum and one-based optional PDF page-reference columns to the already committed QuestionAsset table without changing `0001_initial_local_schema.sql`.

Import writes a same-directory temporary file, verifies copied size and checksum, atomically renames it to the final managed path, then writes metadata. A failed metadata insert removes the managed copy. Deletion stages a managed file in app-local trash, changes database metadata, restores the file on database failure, and finalizes deletion only after success. Startup recovers staged deletes and removes stale import temporary files. Orphan cleanup and integrity checks are available in the Rust asset service.

Teacher media preview is served through Tauri's asset protocol scoped to the managed asset root. The frontend receives only safe asset DTOs and a derived protocol URL for the selected managed asset; it has no generic filesystem copy/delete/read API. Public Question projections omit raw source paths, managed storage paths, checksums, answer configuration, and grading configuration.

## Consequences

- No global media library, many-to-many ownership, OCR, AI extraction, PDF.js, cloud storage, HTTP server, or student media delivery is introduced.
- PDF page references are positive one-based values; Phase 6 does not determine page count or render PDF pages.
- A Question must be saved before it can own imported assets; this avoids draft-media orphan ownership.
- The native dialog plugin has only `dialog:allow-open`; no filesystem plugin capability is used.
