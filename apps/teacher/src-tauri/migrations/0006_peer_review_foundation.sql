-- Feedback records only. No grading columns or mutations of source snapshots.
CREATE TABLE peer_review_activities (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES local_sessions(id) ON DELETE RESTRICT,
    session_question_id TEXT NOT NULL REFERENCES session_questions(id) ON DELETE RESTRICT,
    mode TEXT NOT NULL CHECK (mode IN ('RANDOM_ONE_TO_ONE','STUDENT_SELECT','CROSS_GROUP')),
    state TEXT NOT NULL CHECK (state IN ('DRAFT','OPEN','CLOSED','CANCELLED')),
    session_group_set_id TEXT REFERENCES session_group_sets(id) ON DELETE RESTRICT,
    max_reviews_per_target INTEGER CHECK (max_reviews_per_target IS NULL OR max_reviews_per_target >= 1),
    created_at TEXT NOT NULL,
    opened_at TEXT,
    closed_at TEXT,
    UNIQUE(id, mode),
    UNIQUE(id, session_group_set_id),
    CHECK ((mode = 'CROSS_GROUP' AND session_group_set_id IS NOT NULL) OR
           (mode != 'CROSS_GROUP' AND session_group_set_id IS NULL)),
    CHECK (mode = 'STUDENT_SELECT' OR max_reviews_per_target IS NULL)
);
CREATE INDEX idx_peer_review_activities_session ON peer_review_activities(session_id, created_at, id);

CREATE TABLE peer_review_targets (
    id TEXT PRIMARY KEY NOT NULL,
    activity_id TEXT NOT NULL REFERENCES peer_review_activities(id) ON DELETE RESTRICT,
    submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE RESTRICT,
    participant_id TEXT NOT NULL REFERENCES session_participants(id) ON DELETE RESTRICT,
    UNIQUE(activity_id, id),
    UNIQUE(activity_id, participant_id),
    UNIQUE(activity_id, submission_id)
);
CREATE TABLE peer_review_group_targets (
    id TEXT PRIMARY KEY NOT NULL,
    activity_id TEXT NOT NULL,
    session_group_set_id TEXT NOT NULL,
    session_group_id TEXT NOT NULL,
    UNIQUE(activity_id, id),
    UNIQUE(activity_id, session_group_id),
    FOREIGN KEY(activity_id, session_group_set_id) REFERENCES peer_review_activities(id, session_group_set_id) ON DELETE RESTRICT,
    FOREIGN KEY(session_group_set_id, session_group_id) REFERENCES session_groups(group_set_id, id) ON DELETE RESTRICT
);
CREATE TABLE peer_review_group_target_items (
    activity_id TEXT NOT NULL,
    group_target_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    PRIMARY KEY(group_target_id, target_id),
    UNIQUE(activity_id, target_id),
    FOREIGN KEY(activity_id, group_target_id) REFERENCES peer_review_group_targets(activity_id, id) ON DELETE RESTRICT,
    FOREIGN KEY(activity_id, target_id) REFERENCES peer_review_targets(activity_id, id) ON DELETE RESTRICT
);
CREATE TABLE peer_review_assignments (
    id TEXT PRIMARY KEY NOT NULL,
    activity_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    reviewer_participant_id TEXT REFERENCES session_participants(id) ON DELETE RESTRICT,
    reviewer_session_group_id TEXT,
    session_group_set_id TEXT,
    target_id TEXT,
    target_group_id TEXT,
    slot_index INTEGER NOT NULL CHECK(slot_index >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(activity_id, mode) REFERENCES peer_review_activities(id, mode) ON DELETE RESTRICT,
    FOREIGN KEY(activity_id, target_id) REFERENCES peer_review_targets(activity_id, id) ON DELETE RESTRICT,
    FOREIGN KEY(activity_id, target_group_id) REFERENCES peer_review_group_targets(activity_id, id) ON DELETE RESTRICT,
    FOREIGN KEY(activity_id, session_group_set_id) REFERENCES peer_review_activities(id, session_group_set_id) ON DELETE RESTRICT,
    FOREIGN KEY(session_group_set_id, reviewer_session_group_id) REFERENCES session_groups(group_set_id, id) ON DELETE RESTRICT,
    CHECK ((mode = 'CROSS_GROUP' AND reviewer_participant_id IS NULL AND target_id IS NULL
            AND reviewer_session_group_id IS NOT NULL AND session_group_set_id IS NOT NULL AND target_group_id IS NOT NULL)
        OR (mode IN ('RANDOM_ONE_TO_ONE','STUDENT_SELECT') AND reviewer_participant_id IS NOT NULL AND target_id IS NOT NULL
            AND reviewer_session_group_id IS NULL AND session_group_set_id IS NULL AND target_group_id IS NULL)),
    UNIQUE(activity_id, reviewer_participant_id, slot_index),
    UNIQUE(activity_id, reviewer_session_group_id),
    UNIQUE(activity_id, target_group_id)
);
CREATE UNIQUE INDEX idx_peer_review_random_target ON peer_review_assignments(activity_id, target_id) WHERE mode = 'RANDOM_ONE_TO_ONE';
CREATE INDEX idx_peer_review_claim_capacity ON peer_review_assignments(activity_id, target_id);
CREATE TABLE peer_review_responses (
    id TEXT PRIMARY KEY NOT NULL,
    assignment_id TEXT NOT NULL REFERENCES peer_review_assignments(id) ON DELETE RESTRICT,
    submitted_by_participant_id TEXT NOT NULL REFERENCES session_participants(id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    expected_base_revision INTEGER NOT NULL CHECK(expected_base_revision >= 0),
    body TEXT NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 10000),
    submitted_at TEXT NOT NULL,
    UNIQUE(assignment_id, revision),
    CHECK(revision = expected_base_revision + 1)
);
CREATE INDEX idx_peer_review_response_latest ON peer_review_responses(assignment_id, revision DESC);
