use rusqlite::{Connection, TransactionBehavior};
use sha2::{Digest, Sha256};

use crate::error::AppError;

const INITIAL_SCHEMA: &str = include_str!("../../../migrations/0001_initial_local_schema.sql");
const QUESTION_ASSETS_FOUNDATION: &str =
    include_str!("../../../migrations/0002_question_assets_foundation.sql");
const LOCAL_SESSION_LOBBY: &str = include_str!("../../../migrations/0003_local_session_lobby.sql");

struct Migration {
    version: i64,
    id: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        id: "0001_initial_local_schema",
        sql: INITIAL_SCHEMA,
    },
    Migration {
        version: 2,
        id: "0002_question_assets_foundation",
        sql: QUESTION_ASSETS_FOUNDATION,
    },
    Migration {
        version: 3,
        id: "0003_local_session_lobby",
        sql: LOCAL_SESSION_LOBBY,
    },
];

pub fn run(connection: &mut Connection) -> Result<(), AppError> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY NOT NULL,
            migration_id TEXT NOT NULL UNIQUE,
            checksum TEXT NOT NULL,
            applied_at TEXT NOT NULL
        )",
    )?;

    for migration in MIGRATIONS {
        let expected_checksum = checksum(migration.sql);
        let existing = connection
            .query_row(
                "SELECT migration_id, checksum FROM schema_migrations WHERE version = ?1",
                [migration.version],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;

        if let Some((migration_id, actual_checksum)) = existing {
            if migration_id != migration.id || actual_checksum != expected_checksum {
                return Err(AppError::MigrationFailed(format!(
                    "migration {} checksum mismatch",
                    migration.version
                )));
            }
            continue;
        }

        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(migration.sql).map_err(|_| {
            AppError::MigrationFailed(format!("migration {} failed", migration.version))
        })?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, migration_id, checksum, applied_at) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![migration.version, migration.id, expected_checksum, utc_now()],
            )
            .map_err(|_| AppError::MigrationFailed(format!("migration {} metadata failed", migration.version)))?;
        transaction.commit().map_err(|_| {
            AppError::MigrationFailed(format!("migration {} commit failed", migration.version))
        })?;
    }
    Ok(())
}

pub fn verify(connection: &Connection) -> Result<(), AppError> {
    let foreign_keys: i64 = connection.query_row("PRAGMA foreign_keys", [], |row| row.get(0))?;
    if foreign_keys != 1 {
        return Err(AppError::MigrationFailed(
            "foreign key enforcement is disabled".to_owned(),
        ));
    }
    let mut check = connection.prepare("PRAGMA foreign_key_check")?;
    if check.exists([])? {
        return Err(AppError::MigrationFailed(
            "foreign key check failed".to_owned(),
        ));
    }
    for table in [
        "app_meta",
        "classes",
        "students",
        "courses",
        "lessons",
        "question_sets",
        "questions",
        "question_assets",
        "group_presets",
        "local_sessions",
        "session_participants",
    ] {
        let exists: i64 = connection.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |row| row.get(0),
        )?;
        if exists != 1 {
            return Err(AppError::MigrationFailed(format!(
                "required table {table} is missing"
            )));
        }
    }
    for column in ["sha256", "page_reference"] {
        let exists = connection
            .prepare("SELECT name FROM pragma_table_info('question_assets') WHERE name = ?1")?
            .exists([column])?;
        if !exists {
            return Err(AppError::MigrationFailed(format!(
                "question_assets.{column} is missing"
            )));
        }
    }
    Ok(())
}

pub fn current_version(connection: &Connection) -> Result<i64, AppError> {
    Ok(connection.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?)
}

fn checksum(sql: &str) -> String {
    format!("{:x}", Sha256::digest(sql.as_bytes()))
}

fn utc_now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

use rusqlite::OptionalExtension;

#[cfg(test)]
mod tests {
    use super::run;
    use rusqlite::Connection;

    #[test]
    fn migration_is_idempotent_and_records_checksum() {
        let mut connection = Connection::open_in_memory().expect("connection");
        run(&mut connection).expect("first run");
        run(&mut connection).expect("second run");
        assert_eq!(super::current_version(&connection).expect("version"), 3);
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM schema_migrations", [], |row| row
                    .get::<_, i64>(0))
                .expect("count"),
            3
        );
    }

    #[test]
    fn checksum_mismatch_fails_closed() {
        let mut connection = Connection::open_in_memory().expect("connection");
        run(&mut connection).expect("first run");
        connection
            .execute(
                "UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1",
                [],
            )
            .expect("tamper metadata");
        assert!(run(&mut connection).is_err());
    }

    #[test]
    fn upgrades_a_v1_database_to_the_latest_schema() {
        let mut connection = Connection::open_in_memory().expect("connection");
        connection
            .execute_batch(super::INITIAL_SCHEMA)
            .expect("initial schema");
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, migration_id TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
            )
            .expect("migration table");
        connection
            .execute(
                "INSERT INTO schema_migrations(version, migration_id, checksum, applied_at) VALUES (1, '0001_initial_local_schema', ?1, 'now')",
                [super::checksum(super::INITIAL_SCHEMA)],
            )
            .expect("v1 metadata");

        run(&mut connection).expect("upgrade");

        assert_eq!(super::current_version(&connection).expect("version"), 3);
        assert!(connection
            .prepare("SELECT name FROM pragma_table_info('question_assets') WHERE name = 'sha256'")
            .expect("statement")
            .exists([])
            .expect("sha256 column"));
        assert!(connection
            .prepare("SELECT name FROM pragma_table_info('question_assets') WHERE name = 'page_reference'")
            .expect("statement")
            .exists([])
            .expect("page reference column"));
        assert!(connection
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_sessions'"
            )
            .expect("session table query")
            .exists([])
            .expect("session table"));
    }

    #[test]
    fn upgrades_a_v2_database_to_the_local_session_lobby() {
        let mut connection = Connection::open_in_memory().expect("connection");
        connection
            .execute_batch(super::INITIAL_SCHEMA)
            .expect("v1 schema");
        connection
            .execute_batch(super::QUESTION_ASSETS_FOUNDATION)
            .expect("v2 schema");
        connection.execute_batch("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, migration_id TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)").expect("migration table");
        for migration in &super::MIGRATIONS[..2] {
            connection.execute("INSERT INTO schema_migrations(version, migration_id, checksum, applied_at) VALUES (?1, ?2, ?3, 'now')", rusqlite::params![migration.version, migration.id, super::checksum(migration.sql)]).expect("v2 metadata");
        }
        run(&mut connection).expect("upgrade");
        run(&mut connection).expect("reopen no-op");
        assert_eq!(super::current_version(&connection).expect("version"), 3);
        assert!(connection.prepare("SELECT 1 FROM local_sessions").is_ok());
        assert!(connection
            .prepare("SELECT 1 FROM session_participants")
            .is_ok());
    }
}
