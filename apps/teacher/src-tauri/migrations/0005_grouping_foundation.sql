CREATE TABLE group_preset_groups (
    id TEXT PRIMARY KEY NOT NULL,
    preset_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    position INTEGER NOT NULL CHECK (position >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (preset_id, id),
    UNIQUE (preset_id, name),
    UNIQUE (preset_id, position),
    FOREIGN KEY (preset_id) REFERENCES group_presets(id) ON DELETE CASCADE
);

CREATE TABLE group_preset_members (
    id TEXT PRIMARY KEY NOT NULL,
    preset_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (preset_id, student_id),
    FOREIGN KEY (preset_id, group_id) REFERENCES group_preset_groups(preset_id, id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
);

CREATE INDEX idx_group_preset_groups_preset_position
    ON group_preset_groups(preset_id, position, id);
CREATE INDEX idx_group_preset_members_group
    ON group_preset_members(preset_id, group_id, student_id);

CREATE TABLE session_grouping_drafts (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('DRAFT', 'OPEN', 'FINALIZED', 'CANCELLED')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES local_sessions(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_session_grouping_one_active_draft
    ON session_grouping_drafts(session_id)
    WHERE state IN ('DRAFT', 'OPEN');
CREATE INDEX idx_session_grouping_drafts_session
    ON session_grouping_drafts(session_id, state, updated_at DESC);

CREATE TABLE session_grouping_draft_groups (
    id TEXT PRIMARY KEY NOT NULL,
    draft_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    position INTEGER NOT NULL CHECK (position >= 0),
    capacity INTEGER CHECK (capacity IS NULL OR capacity >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (draft_id, id),
    UNIQUE (draft_id, name),
    UNIQUE (draft_id, position),
    FOREIGN KEY (draft_id) REFERENCES session_grouping_drafts(id) ON DELETE CASCADE
);

CREATE TABLE session_grouping_draft_members (
    id TEXT PRIMARY KEY NOT NULL,
    draft_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    participant_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (draft_id, participant_id),
    FOREIGN KEY (draft_id, group_id) REFERENCES session_grouping_draft_groups(draft_id, id) ON DELETE CASCADE,
    FOREIGN KEY (participant_id) REFERENCES session_participants(id) ON DELETE CASCADE
);

CREATE INDEX idx_session_grouping_draft_members_group
    ON session_grouping_draft_members(draft_id, group_id, participant_id);

CREATE TABLE session_group_sets (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    UNIQUE (session_id, revision),
    FOREIGN KEY (session_id) REFERENCES local_sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_session_group_sets_session_revision
    ON session_group_sets(session_id, revision DESC);

CREATE TABLE session_groups (
    id TEXT PRIMARY KEY NOT NULL,
    group_set_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    position INTEGER NOT NULL CHECK (position >= 0),
    created_at TEXT NOT NULL,
    UNIQUE (group_set_id, id),
    UNIQUE (group_set_id, name),
    UNIQUE (group_set_id, position),
    FOREIGN KEY (group_set_id) REFERENCES session_group_sets(id) ON DELETE CASCADE
);

CREATE TABLE session_group_members (
    id TEXT PRIMARY KEY NOT NULL,
    group_set_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    participant_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (group_set_id, participant_id),
    FOREIGN KEY (group_set_id, group_id) REFERENCES session_groups(group_set_id, id) ON DELETE CASCADE,
    FOREIGN KEY (participant_id) REFERENCES session_participants(id) ON DELETE CASCADE
);

CREATE INDEX idx_session_group_members_group
    ON session_group_members(group_set_id, group_id, participant_id);
