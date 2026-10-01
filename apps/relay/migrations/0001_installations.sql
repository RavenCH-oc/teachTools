CREATE TABLE activation_codes (
  code_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE installations (
  id TEXT PRIMARY KEY,
  credential_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
