# ADR-018: Grouping snapshots and self-selection drafts

## Status

Accepted for Phase 11A; integration validated through Phase 11E.

## Decision

Classroom reusable grouping presets、mutable Session grouping drafts 與 finalized Session group sets 是三個不同的 aggregate lifecycle：

```text
GroupPreset → SessionGroupingDraft → immutable SessionGroupSet revision
```

Presets reference long-lived `Student` records. Drafts and formal GroupSets reference Session-scoped `Participant` records. Formal GroupSets use durable UUIDs, retain every revision, and never update membership after finalization. A Session's current GroupSet is its highest finalized revision.

Draft membership moves and capacity checks use an SQLite `BEGIN IMMEDIATE` transaction. Only one `DRAFT` or `OPEN` draft may exist per Session. Session end cancels open mutable drafts without finalizing them, while finalized GroupSets remain retained. Student self-selection is Teacher-controlled: students choose only among Teacher-defined groups and cannot create, rename, delete, reorder, or change capacity. Teacher override and Student selection share the same atomic move and capacity semantics.

## Consequences

Normalized preset, draft, and snapshot tables preserve ownership and uniqueness constraints without opaque membership JSON. Presets are creation sources only: mutation or deletion cannot change a Session draft or finalized revision. Roster identity maps to a Session solely through exact `Student.id → session_participants.student_id → participant_id`; historical grouping remains Participant-based if the roster Student is later removed.

Late participants remain unassigned in an existing GroupSet until a Teacher clones/creates and finalizes a new draft. Offline presence never mutates grouping. Session End and stale restart recovery cancel mutable drafts while retaining formal revisions. OPEN delivery uses the existing authenticated ParticipantTransport and returns only the current safe projection; FINALIZED delivery returns only the Student's own formal group. The optional grouping field preserves local protocol version 1 because server and Student bundle ship together and all prior required fields remain unchanged.

Teacher preset/session UI, Student self-selection/delivery, random/manual creation, and revision workflows are implemented through Phase 11E. Statistics and Peer Review remain separate future concerns; a future Peer Review assignment may reference the durable `sessionGroupSetId` without changing this lifecycle. Functional integration is prioritized; cosmetic grouping polish and drag/drop are deferred.
