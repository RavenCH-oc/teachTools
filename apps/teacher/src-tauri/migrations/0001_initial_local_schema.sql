CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS classes (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    academic_year TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS students (
    id TEXT PRIMARY KEY NOT NULL,
    class_id TEXT NOT NULL,
    seat_number INTEGER NOT NULL CHECK (seat_number > 0),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (class_id, seat_number),
    FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lessons (
    id TEXT PRIMARY KEY NOT NULL,
    course_id TEXT NOT NULL,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    description TEXT,
    content_metadata TEXT NOT NULL DEFAULT '{}',
    position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS question_sets (
    id TEXT PRIMARY KEY NOT NULL,
    lesson_id TEXT,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY NOT NULL,
    question_set_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('true_false', 'single_choice', 'multiple_choice', 'fill_blank', 'essay')),
    prompt TEXT NOT NULL,
    points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
    position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
    answer_config TEXT NOT NULL DEFAULT '{}',
    grading_config TEXT NOT NULL DEFAULT '{}',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (question_set_id) REFERENCES question_sets(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS question_assets (
    id TEXT PRIMARY KEY NOT NULL,
    question_id TEXT NOT NULL,
    asset_type TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    display_name TEXT,
    mime_type TEXT,
    size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
    position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
    created_at TEXT NOT NULL,
    FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS group_presets (
    id TEXT PRIMARY KEY NOT NULL,
    class_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    configuration TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_students_class_id ON students(class_id);
CREATE INDEX IF NOT EXISTS idx_students_class_seat ON students(class_id, seat_number);
CREATE INDEX IF NOT EXISTS idx_lessons_course_id ON lessons(course_id);
CREATE INDEX IF NOT EXISTS idx_question_sets_lesson_id ON question_sets(lesson_id);
CREATE INDEX IF NOT EXISTS idx_questions_question_set_id ON questions(question_set_id);
CREATE INDEX IF NOT EXISTS idx_question_assets_question_id ON question_assets(question_id);
CREATE INDEX IF NOT EXISTS idx_group_presets_class_id ON group_presets(class_id);
