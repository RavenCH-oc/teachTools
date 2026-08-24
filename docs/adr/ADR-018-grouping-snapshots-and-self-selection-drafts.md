# ADR-018: Grouping snapshots and self-selection drafts

## Status

Accepted for Phase 11A.

## Decision

Classroom reusable grouping presets、mutable Session grouping drafts 與 finalized Session group sets 是三個不同的 aggregate lifecycle：

```text
GroupPreset → SessionGroupingDraft → immutable SessionGroupSet revision
```

Presets reference long-lived `Student` records. Drafts and formal GroupSets reference Session-scoped `Participant` records. Formal GroupSets use durable UUIDs, retain every revision, and never update membership after finalization. A Session's current GroupSet is its highest finalized revision.

Draft membership moves and capacity checks use an SQLite `BEGIN IMMEDIATE` transaction. Only one `DRAFT` or `OPEN` draft may exist per Session. Session end cancels open mutable drafts without finalizing them, while finalized GroupSets remain retained. Future Student self-selection is Teacher-controlled: students choose only among Teacher-defined groups and cannot create, rename, or delete groups.

## Consequences

Normalized preset, draft, and snapshot tables preserve ownership and uniqueness constraints without opaque membership JSON. Late participants remain unassigned in an existing GroupSet until a Teacher creates and finalizes a new draft. Student grouping transport, UI, random assignment, preset application, statistics, and peer review remain later-phase concerns.
