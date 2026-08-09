use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use super::{map_write_error, now_utc};
use crate::error::AppError;
use crate::infrastructure::persistence::database::Database;

#[derive(Debug, Clone, Serialize)]
pub struct QuestionAsset {
    pub id: String,
    pub question_id: String,
    pub asset_type: String,
    pub storage_path: String,
    pub display_name: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub sha256: Option<String>,
    pub position: i64,
    pub page_reference: Option<i64>,
    pub created_at: String,
}

pub struct NewQuestionAsset {
    pub id: String,
    pub question_id: String,
    pub asset_type: String,
    pub storage_path: String,
    pub display_name: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub position: i64,
    pub page_reference: Option<i64>,
}

pub struct QuestionAssetRepository;

impl QuestionAssetRepository {
    pub fn create(database: &Database, input: NewQuestionAsset) -> Result<QuestionAsset, AppError> {
        let id = input.id.clone();
        let connection = database.connection()?;
        connection
            .execute(
                "INSERT INTO question_assets(id, question_id, asset_type, storage_path, display_name, mime_type, size_bytes, sha256, position, page_reference, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![input.id, input.question_id, input.asset_type, input.storage_path, input.display_name, input.mime_type, input.size_bytes, input.sha256, input.position, input.page_reference, now_utc()],
            )
            .map_err(map_write_error)?;
        Self::get_by_id(database, &id)?.ok_or(AppError::Storage)
    }

    pub fn get_by_id(database: &Database, id: &str) -> Result<Option<QuestionAsset>, AppError> {
        let connection = database.connection()?;
        Ok(connection
            .query_row(
                "SELECT id, question_id, asset_type, storage_path, display_name, mime_type, size_bytes, sha256, position, page_reference, created_at FROM question_assets WHERE id = ?1",
                [id],
                row_to_asset,
            )
            .optional()?)
    }

    pub fn list_by_question(
        database: &Database,
        question_id: &str,
    ) -> Result<Vec<QuestionAsset>, AppError> {
        let connection = database.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, question_id, asset_type, storage_path, display_name, mime_type, size_bytes, sha256, position, page_reference, created_at FROM question_assets WHERE question_id = ?1 ORDER BY position, id",
        )?;
        let rows = statement
            .query_map([question_id], row_to_asset)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn list_all(database: &Database) -> Result<Vec<QuestionAsset>, AppError> {
        let connection = database.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, question_id, asset_type, storage_path, display_name, mime_type, size_bytes, sha256, position, page_reference, created_at FROM question_assets ORDER BY question_id, position, id",
        )?;
        let rows = statement
            .query_map([], row_to_asset)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn find_by_question_and_hash(
        database: &Database,
        question_id: &str,
        sha256: &str,
    ) -> Result<Option<QuestionAsset>, AppError> {
        let connection = database.connection()?;
        Ok(connection
            .query_row(
                "SELECT id, question_id, asset_type, storage_path, display_name, mime_type, size_bytes, sha256, position, page_reference, created_at FROM question_assets WHERE question_id = ?1 AND sha256 = ?2",
                params![question_id, sha256],
                row_to_asset,
            )
            .optional()?)
    }

    pub fn delete(database: &Database, id: &str) -> Result<(), AppError> {
        let connection = database.connection()?;
        if connection
            .execute("DELETE FROM question_assets WHERE id = ?1", [id])
            .map_err(map_write_error)?
            == 0
        {
            return Err(AppError::NotFound("question asset".to_owned()));
        }
        Ok(())
    }

    pub fn update_page_reference(
        database: &Database,
        id: &str,
        page_reference: Option<i64>,
    ) -> Result<QuestionAsset, AppError> {
        let connection = database.connection()?;
        if connection
            .execute(
                "UPDATE question_assets SET page_reference = ?1 WHERE id = ?2",
                params![page_reference, id],
            )
            .map_err(map_write_error)?
            == 0
        {
            return Err(AppError::NotFound("question asset".to_owned()));
        }
        Self::get_by_id(database, id)?.ok_or(AppError::Storage)
    }
}

fn row_to_asset(row: &rusqlite::Row<'_>) -> rusqlite::Result<QuestionAsset> {
    Ok(QuestionAsset {
        id: row.get(0)?,
        question_id: row.get(1)?,
        asset_type: row.get(2)?,
        storage_path: row.get(3)?,
        display_name: row.get(4)?,
        mime_type: row.get(5)?,
        size_bytes: row.get(6)?,
        sha256: row.get(7)?,
        position: row.get(8)?,
        page_reference: row.get(9)?,
        created_at: row.get(10)?,
    })
}
