-- SQLite requires a table rebuild to extend the Phase 8 session-state CHECK.
-- The migration runner temporarily disables foreign-key enforcement around this
-- transaction and verifies it again before opening the application database.
CREATE TABLE local_sessions_phase9 (
    id TEXT PRIMARY KEY NOT NULL,
    classroom_id TEXT NOT NULL,
    server_instance_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('CREATED', 'LOBBY', 'ACTIVE', 'ENDED')),
    join_mode TEXT NOT NULL CHECK (join_mode IN ('roster_match')),
    join_code TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    lobby_opened_at TEXT,
    ended_at TEXT,
    ended_reason TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (classroom_id) REFERENCES classes(id) ON DELETE RESTRICT
);

INSERT INTO local_sessions_phase9
SELECT id, classroom_id, server_instance_id, state, join_mode, join_code,
       created_at, lobby_opened_at, ended_at, ended_reason, updated_at
FROM local_sessions;

DROP TABLE local_sessions;
ALTER TABLE local_sessions_phase9 RENAME TO local_sessions;

CREATE UNIQUE INDEX idx_local_sessions_single_active
    ON local_sessions ((1))
    WHERE state IN ('CREATED', 'LOBBY', 'ACTIVE');
CREATE INDEX idx_local_sessions_join_code ON local_sessions(join_code);

CREATE TABLE session_questions (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    source_question_id TEXT,
    question_type TEXT NOT NULL CHECK (question_type IN ('true_false', 'single_choice', 'multiple_choice', 'fill_blank', 'essay')),
    prompt TEXT NOT NULL CHECK (length(trim(prompt)) > 0),
    points INTEGER NOT NULL CHECK (points > 0),
    position INTEGER NOT NULL CHECK (position >= 0),
    answer_config TEXT NOT NULL,
    grading_config TEXT NOT NULL,
    metadata TEXT NOT NULL,
    config_version INTEGER NOT NULL CHECK (config_version = 1),
    state TEXT NOT NULL CHECK (state IN ('HIDDEN', 'OPEN', 'LOCKED', 'REVEALED')),
    created_at TEXT NOT NULL,
    opened_at TEXT,
    locked_at TEXT,
    revealed_at TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES local_sessions(id) ON DELETE RESTRICT,
    FOREIGN KEY (source_question_id) REFERENCES questions(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX idx_session_questions_one_active
    ON session_questions (session_id)
    WHERE state IN ('OPEN', 'LOCKED');
CREATE INDEX idx_session_questions_session_position
    ON session_questions(session_id, position, id);

CREATE TABLE session_question_assets (
    id TEXT PRIMARY KEY NOT NULL,
    session_question_id TEXT NOT NULL,
    source_asset_id TEXT,
    asset_type TEXT NOT NULL CHECK (asset_type IN ('image', 'pdf')),
    storage_path TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    sha256 TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    page_reference INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_question_id) REFERENCES session_questions(id) ON DELETE RESTRICT,
    FOREIGN KEY (source_asset_id) REFERENCES question_assets(id) ON DELETE SET NULL
);

CREATE INDEX idx_session_question_assets_question_position
    ON session_question_assets(session_question_id, position, id);

CREATE TABLE submissions (
    id TEXT PRIMARY KEY NOT NULL,
    session_question_id TEXT NOT NULL,
    participant_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    answer_json TEXT NOT NULL,
    grading_status TEXT NOT NULL CHECK (grading_status IN ('graded', 'pending')),
    is_correct INTEGER CHECK (is_correct IN (0, 1)),
    score INTEGER,
    max_score INTEGER NOT NULL CHECK (max_score > 0),
    submitted_at TEXT NOT NULL,
    FOREIGN KEY (session_question_id) REFERENCES session_questions(id) ON DELETE RESTRICT,
    FOREIGN KEY (participant_id) REFERENCES session_participants(id) ON DELETE RESTRICT,
    UNIQUE(session_question_id, participant_id, revision)
);

CREATE INDEX idx_submissions_latest
    ON submissions(session_question_id, participant_id, revision DESC);
