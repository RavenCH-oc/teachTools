CREATE TABLE local_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    classroom_id TEXT NOT NULL,
    server_instance_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('CREATED', 'LOBBY', 'ENDED')),
    join_mode TEXT NOT NULL CHECK (join_mode IN ('roster_match')),
    join_code TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    lobby_opened_at TEXT,
    ended_at TEXT,
    ended_reason TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (classroom_id) REFERENCES classes(id) ON DELETE RESTRICT
);

CREATE TABLE session_participants (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    student_id TEXT,
    seat_number INTEGER NOT NULL CHECK (seat_number > 0),
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
    credential_hash TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_authenticated_at TEXT,
    UNIQUE (session_id, seat_number),
    FOREIGN KEY (session_id) REFERENCES local_sessions(id) ON DELETE RESTRICT,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX idx_local_sessions_single_active
    ON local_sessions ((1))
    WHERE state IN ('CREATED', 'LOBBY');

CREATE INDEX idx_local_sessions_join_code ON local_sessions(join_code);
CREATE INDEX idx_session_participants_session_joined
    ON session_participants(session_id, joined_at, id);
CREATE UNIQUE INDEX idx_session_participants_session_student
    ON session_participants(session_id, student_id)
    WHERE student_id IS NOT NULL;
