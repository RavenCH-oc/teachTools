ALTER TABLE question_assets ADD COLUMN sha256 TEXT;
ALTER TABLE question_assets ADD COLUMN page_reference INTEGER CHECK (page_reference IS NULL OR page_reference >= 1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_question_assets_question_sha256
    ON question_assets(question_id, sha256)
    WHERE sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_question_assets_question_position
    ON question_assets(question_id, position, id);
