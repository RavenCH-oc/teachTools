use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::infrastructure::persistence::database::Database;
use crate::infrastructure::persistence::repositories::{
    new_id, NewQuestionAsset, QuestionAsset, QuestionAssetRepository, QuestionRepository,
};

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_PDF_BYTES: u64 = 100 * 1024 * 1024;
const MAX_ASSETS_PER_QUESTION: usize = 10;
const STALE_TEMP_AGE: Duration = Duration::from_secs(60 * 60);
const STALE_DRAFT_AGE: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAssetDto {
    pub id: String,
    pub question_id: String,
    pub asset_type: String,
    pub display_name: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub position: i64,
    pub page_reference: Option<i64>,
    pub created_at: String,
    pub status: AssetStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAssetPreviewDto {
    #[serde(flatten)]
    pub asset: QuestionAssetDto,
    pub asset_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionDraftDto {
    pub id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftQuestionAssetDto {
    pub id: String,
    pub draft_id: String,
    pub asset_type: String,
    pub display_name: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub asset_url: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetStatus {
    Ready,
    Missing,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportQuestionAssetRequest {
    pub question_id: String,
    pub source_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportQuestionDraftAssetRequest {
    pub draft_id: String,
    pub source_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteQuestionDraftAssetRequest {
    pub draft_id: String,
    pub draft_asset_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateQuestionAssetPageReferenceRequest {
    pub page_reference: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MediaKind {
    Png,
    Jpeg,
    Webp,
    Pdf,
}

impl MediaKind {
    fn from_extension(extension: &str) -> Option<Self> {
        match extension {
            "png" => Some(Self::Png),
            "jpg" | "jpeg" => Some(Self::Jpeg),
            "webp" => Some(Self::Webp),
            "pdf" => Some(Self::Pdf),
            _ => None,
        }
    }

    fn asset_type(self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Png | Self::Jpeg | Self::Webp => "image",
        }
    }

    fn mime_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Webp => "image/webp",
            Self::Pdf => "application/pdf",
        }
    }

    fn maximum_size(self) -> u64 {
        match self {
            Self::Pdf => MAX_PDF_BYTES,
            Self::Png | Self::Jpeg | Self::Webp => MAX_IMAGE_BYTES,
        }
    }

    fn signature_matches(self, header: &[u8]) -> bool {
        match self {
            Self::Png => header.starts_with(b"\x89PNG\r\n\x1a\n"),
            Self::Jpeg => header.starts_with(&[0xff, 0xd8, 0xff]),
            Self::Webp => {
                header.len() >= 12 && &header[..4] == b"RIFF" && &header[8..12] == b"WEBP"
            }
            Self::Pdf => header.starts_with(b"%PDF-"),
        }
    }
}

struct SourceProfile {
    kind: MediaKind,
    extension: String,
    display_name: String,
    size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DraftAssetRecord {
    id: String,
    extension: String,
    asset_type: String,
    display_name: String,
    mime_type: String,
    size_bytes: u64,
    sha256: String,
}

struct PromotedDraftAsset {
    record: DraftAssetRecord,
    id: String,
    shard: String,
    temporary_path: PathBuf,
    final_path: PathBuf,
}

pub struct AssetService {
    database: Database,
    assets_root: PathBuf,
    trash_root: PathBuf,
    drafts_root: PathBuf,
}

impl AssetService {
    pub fn initialize(
        database: Database,
        app_data_dir: impl AsRef<Path>,
    ) -> Result<Self, AppError> {
        let assets_root = app_data_dir.as_ref().join("assets");
        let trash_root = assets_root.join(".trash");
        let drafts_root = assets_root.join(".draft");
        fs::create_dir_all(&trash_root).map_err(|_| AppError::Storage)?;
        fs::create_dir_all(&drafts_root).map_err(|_| AppError::Storage)?;
        let service = Self {
            database,
            assets_root,
            trash_root,
            drafts_root,
        };
        service.recover_staged_deletions()?;
        service.cleanup_stale_temp_files(STALE_TEMP_AGE)?;
        service.cleanup_stale_drafts(STALE_DRAFT_AGE)?;
        Ok(service)
    }

    pub fn create_draft(&self) -> Result<QuestionDraftDto, AppError> {
        let id = new_id();
        fs::create_dir(self.draft_directory(&id)?).map_err(|_| AppError::Storage)?;
        Ok(QuestionDraftDto { id })
    }

    pub fn import_draft(
        &self,
        request: ImportQuestionDraftAssetRequest,
    ) -> Result<DraftQuestionAssetDto, AppError> {
        if request.source_path.trim().is_empty() {
            return Err(AppError::Validation(
                "a source file must be selected".to_owned(),
            ));
        }
        let directory = self.draft_directory(&request.draft_id)?;
        if !directory.is_dir() {
            return Err(AppError::NotFound("question draft".to_owned()));
        }
        let records = self.list_draft_records(&request.draft_id)?;
        if records.len() >= MAX_ASSETS_PER_QUESTION {
            return Err(AppError::Conflict(
                "a question can have at most ten assets".to_owned(),
            ));
        }
        let source = Path::new(&request.source_path);
        let profile = source_profile(source)?;
        let source_hash = hash_file(source)?;
        if records.iter().any(|record| record.sha256 == source_hash) {
            return Err(AppError::Conflict(
                "this file is already attached to the draft".to_owned(),
            ));
        }

        let id = new_id();
        let final_path = directory.join(format!("{id}.{}", profile.extension));
        let temporary_path = directory.join(format!("{id}.tmp"));
        let (copied_bytes, copied_hash) = match copy_and_hash(source, &temporary_path) {
            Ok(value) => value,
            Err(error) => {
                remove_file_quietly(&temporary_path);
                return Err(error);
            }
        };
        if copied_bytes != profile.size_bytes || copied_hash != source_hash {
            remove_file_quietly(&temporary_path);
            return Err(AppError::AssetCorrupted);
        }
        if fs::rename(&temporary_path, &final_path).is_err() {
            remove_file_quietly(&temporary_path);
            return Err(AppError::Storage);
        }
        let record = DraftAssetRecord {
            id: id.clone(),
            extension: profile.extension,
            asset_type: profile.kind.asset_type().to_owned(),
            display_name: profile.display_name,
            mime_type: profile.kind.mime_type().to_owned(),
            size_bytes: profile.size_bytes,
            sha256: source_hash,
        };
        if let Err(error) = self.write_draft_record(&request.draft_id, &record) {
            remove_file_quietly(&final_path);
            return Err(error);
        }
        self.draft_dto(&request.draft_id, record)
    }

    pub fn delete_draft_asset(
        &self,
        request: DeleteQuestionDraftAssetRequest,
    ) -> Result<(), AppError> {
        let record = self.draft_record(&request.draft_id, &request.draft_asset_id)?;
        let directory = self.draft_directory(&request.draft_id)?;
        let asset_path = directory.join(format!("{}.{}", record.id, record.extension));
        let record_path = self.draft_record_path(&request.draft_id, &record.id)?;
        if !asset_path.is_file() {
            return Err(AppError::AssetCorrupted);
        }
        let staged_path = directory.join(format!("{}.delete", record.id));
        if staged_path.exists() || fs::rename(&asset_path, &staged_path).is_err() {
            return Err(AppError::Storage);
        }
        if fs::remove_file(&record_path).is_err() {
            let _ = fs::rename(&staged_path, &asset_path);
            return Err(AppError::Storage);
        }
        if fs::remove_file(&staged_path).is_err() {
            let _ = fs::rename(&staged_path, &asset_path);
            let _ = self.write_draft_record(&request.draft_id, &record);
            return Err(AppError::Storage);
        }
        Ok(())
    }

    pub fn discard_draft(&self, draft_id: String) -> Result<(), AppError> {
        let directory = self.draft_directory(&draft_id)?;
        if directory.exists() {
            fs::remove_dir_all(directory).map_err(|_| AppError::Storage)?;
        }
        Ok(())
    }

    pub fn validate_draft(&self, draft_id: &str) -> Result<(), AppError> {
        for record in self.list_draft_records(draft_id)? {
            self.verify_draft_record(draft_id, &record)?;
        }
        Ok(())
    }

    pub fn promote_draft(
        &self,
        question_id: &str,
        draft_id: &str,
    ) -> Result<Vec<QuestionAssetDto>, AppError> {
        if QuestionRepository::get(&self.database, question_id)?.is_none() {
            return Err(AppError::NotFound("question".to_owned()));
        }
        let records = self.list_draft_records(draft_id)?;
        if records.len() > MAX_ASSETS_PER_QUESTION {
            return Err(AppError::Conflict(
                "a question can have at most ten assets".to_owned(),
            ));
        }
        let mut known_hashes = HashSet::new();
        for record in &records {
            self.verify_draft_record(draft_id, record)?;
            if !known_hashes.insert(record.sha256.as_str()) {
                return Err(AppError::Conflict(
                    "this file is already attached to the draft".to_owned(),
                ));
            }
        }

        let mut staged = Vec::new();
        for record in &records {
            let id = new_id();
            let shard = id.get(..2).ok_or(AppError::Storage)?.to_owned();
            let directory = self.assets_root.join(&shard);
            fs::create_dir_all(&directory).map_err(|_| AppError::Storage)?;
            let temporary_path = directory.join(format!("{id}.tmp"));
            let final_path = directory.join(format!("{id}.{}", record.extension));
            let source = self.draft_asset_path(draft_id, record)?;
            match copy_and_hash(&source, &temporary_path) {
                Ok((bytes, hash)) if bytes == record.size_bytes && hash == record.sha256 => {}
                Ok(_) => {
                    remove_file_quietly(&temporary_path);
                    self.remove_promotion_files(&staged);
                    return Err(AppError::AssetCorrupted);
                }
                Err(error) => {
                    remove_file_quietly(&temporary_path);
                    self.remove_promotion_files(&staged);
                    return Err(error);
                }
            }
            staged.push(PromotedDraftAsset {
                record: record.clone(),
                id,
                shard,
                temporary_path,
                final_path,
            });
        }

        let mut created = Vec::new();
        for (position, planned) in staged.iter().enumerate() {
            if fs::rename(&planned.temporary_path, &planned.final_path).is_err() {
                self.remove_promotion_files(&staged);
                return Err(AppError::Storage);
            }
            let asset = QuestionAssetRepository::create(
                &self.database,
                NewQuestionAsset {
                    id: planned.id.clone(),
                    question_id: question_id.to_owned(),
                    asset_type: planned.record.asset_type.clone(),
                    storage_path: format!(
                        "assets/{}/{}.{}",
                        planned.shard, planned.id, planned.record.extension
                    ),
                    display_name: planned.record.display_name.clone(),
                    mime_type: planned.record.mime_type.clone(),
                    size_bytes: i64::try_from(planned.record.size_bytes)
                        .map_err(|_| AppError::FileTooLarge)?,
                    sha256: planned.record.sha256.clone(),
                    position: i64::try_from(position).map_err(|_| AppError::Storage)?,
                    page_reference: None,
                },
            );
            match asset {
                Ok(asset) => created.push(self.dto(asset)),
                Err(error) => {
                    for asset in &created {
                        let _ = QuestionAssetRepository::delete(&self.database, &asset.id);
                    }
                    self.remove_promotion_files(&staged);
                    return Err(error);
                }
            }
        }
        if let Err(error) = self.discard_draft(draft_id.to_owned()) {
            for asset in &created {
                let _ = QuestionAssetRepository::delete(&self.database, &asset.id);
            }
            self.remove_promotion_files(&staged);
            return Err(error);
        }
        Ok(created)
    }

    pub fn import(
        &self,
        request: ImportQuestionAssetRequest,
    ) -> Result<QuestionAssetDto, AppError> {
        if request.source_path.trim().is_empty() {
            return Err(AppError::Validation(
                "a source file must be selected".to_owned(),
            ));
        }
        if QuestionRepository::get(&self.database, &request.question_id)?.is_none() {
            return Err(AppError::NotFound("question".to_owned()));
        }
        let existing =
            QuestionAssetRepository::list_by_question(&self.database, &request.question_id)?;
        if existing.len() >= MAX_ASSETS_PER_QUESTION {
            return Err(AppError::Conflict(
                "a question can have at most ten assets".to_owned(),
            ));
        }

        let source = Path::new(&request.source_path);
        let profile = source_profile(source)?;
        let source_hash = hash_file(source)?;
        if QuestionAssetRepository::find_by_question_and_hash(
            &self.database,
            &request.question_id,
            &source_hash,
        )?
        .is_some()
        {
            return Err(AppError::Conflict(
                "this file is already attached to the question".to_owned(),
            ));
        }

        let id = new_id();
        let shard = id.get(..2).ok_or(AppError::Storage)?;
        let directory = self.assets_root.join(shard);
        fs::create_dir_all(&directory).map_err(|_| AppError::Storage)?;
        let final_path = directory.join(format!("{id}.{}", profile.extension));
        let temporary_path = directory.join(format!("{id}.tmp"));

        let copy_result = copy_and_hash(source, &temporary_path);
        let (copied_bytes, copied_hash) = match copy_result {
            Ok(value) => value,
            Err(error) => {
                remove_file_quietly(&temporary_path);
                return Err(error);
            }
        };
        if copied_bytes != profile.size_bytes || copied_hash != source_hash {
            remove_file_quietly(&temporary_path);
            return Err(AppError::AssetCorrupted);
        }
        if fs::rename(&temporary_path, &final_path).is_err() {
            remove_file_quietly(&temporary_path);
            return Err(AppError::Storage);
        }

        let storage_path = format!("assets/{shard}/{id}.{}", profile.extension);
        let created = QuestionAssetRepository::create(
            &self.database,
            NewQuestionAsset {
                id,
                question_id: request.question_id,
                asset_type: profile.kind.asset_type().to_owned(),
                storage_path,
                display_name: profile.display_name,
                mime_type: profile.kind.mime_type().to_owned(),
                size_bytes: i64::try_from(profile.size_bytes)
                    .map_err(|_| AppError::FileTooLarge)?,
                sha256: source_hash,
                position: i64::try_from(existing.len()).map_err(|_| AppError::Storage)?,
                page_reference: None,
            },
        );
        match created {
            Ok(asset) => Ok(self.dto(asset)),
            Err(error) => {
                remove_file_quietly(&final_path);
                Err(error)
            }
        }
    }

    pub fn list_by_question(&self, question_id: String) -> Result<Vec<QuestionAssetDto>, AppError> {
        if QuestionRepository::get(&self.database, &question_id)?.is_none() {
            return Err(AppError::NotFound("question".to_owned()));
        }
        Ok(
            QuestionAssetRepository::list_by_question(&self.database, &question_id)?
                .into_iter()
                .map(|asset| self.dto(asset))
                .collect(),
        )
    }

    pub fn get_preview(&self, asset_id: String) -> Result<QuestionAssetPreviewDto, AppError> {
        let asset = QuestionAssetRepository::get_by_id(&self.database, &asset_id)?
            .ok_or(AppError::NotFound("question asset".to_owned()))?;
        let path = self.resolve_path(&asset)?;
        verify_file(&path, &asset)?;
        Ok(QuestionAssetPreviewDto {
            asset: self.dto(asset),
            asset_url: asset_protocol_url(&path)?,
        })
    }

    pub fn delete(&self, asset_id: String) -> Result<(), AppError> {
        let asset = QuestionAssetRepository::get_by_id(&self.database, &asset_id)?
            .ok_or(AppError::NotFound("question asset".to_owned()))?;
        let staged = self.stage_for_delete(&asset)?;
        if let Err(error) = QuestionAssetRepository::delete(&self.database, &asset.id) {
            self.restore_staged(&asset, staged.as_deref());
            return Err(error);
        }
        if let Some(path) = staged {
            remove_file_quietly(&path);
        }
        Ok(())
    }

    pub fn update_page_reference(
        &self,
        asset_id: String,
        request: UpdateQuestionAssetPageReferenceRequest,
    ) -> Result<QuestionAssetDto, AppError> {
        let asset = QuestionAssetRepository::get_by_id(&self.database, &asset_id)?
            .ok_or(AppError::NotFound("question asset".to_owned()))?;
        if asset.asset_type != "pdf" {
            return Err(AppError::Validation(
                "only PDF assets can have a page reference".to_owned(),
            ));
        }
        if request.page_reference.is_some_and(|page| page < 1) {
            return Err(AppError::Validation(
                "a PDF page reference must be at least 1".to_owned(),
            ));
        }
        Ok(self.dto(QuestionAssetRepository::update_page_reference(
            &self.database,
            &asset.id,
            request.page_reference,
        )?))
    }

    pub fn delete_question_with_assets(&self, question_id: &str) -> Result<(), AppError> {
        let assets = QuestionAssetRepository::list_by_question(&self.database, question_id)?;
        let mut staged = Vec::new();
        for asset in &assets {
            match self.stage_for_delete(asset) {
                Ok(path) => staged.push((asset, path)),
                Err(error) => {
                    for (staged_asset, staged_path) in &staged {
                        self.restore_staged(staged_asset, staged_path.as_deref());
                    }
                    return Err(error);
                }
            }
        }
        if let Err(error) = QuestionRepository::delete(&self.database, question_id) {
            for (asset, path) in &staged {
                self.restore_staged(asset, path.as_deref());
            }
            return Err(error);
        }
        for (_, path) in staged {
            if let Some(path) = path {
                remove_file_quietly(&path);
            }
        }
        Ok(())
    }

    #[allow(dead_code)]
    pub fn verify_asset(&self, asset_id: &str) -> Result<(), AppError> {
        let asset = QuestionAssetRepository::get_by_id(&self.database, asset_id)?
            .ok_or(AppError::NotFound("question asset".to_owned()))?;
        verify_file(&self.resolve_path(&asset)?, &asset)
    }

    #[allow(dead_code)]
    pub fn cleanup_orphans(&self) -> Result<usize, AppError> {
        let known_paths = QuestionAssetRepository::list_all(&self.database)?
            .into_iter()
            .map(|asset| self.resolve_path(&asset))
            .collect::<Result<HashSet<_>, _>>()?;
        let mut removed = 0;
        for entry in fs::read_dir(&self.assets_root).map_err(|_| AppError::Storage)? {
            let entry = entry.map_err(|_| AppError::Storage)?;
            let path = entry.path();
            if !path.is_dir() || path == self.trash_root {
                continue;
            }
            for file in fs::read_dir(path).map_err(|_| AppError::Storage)? {
                let file = file.map_err(|_| AppError::Storage)?;
                let candidate = file.path();
                if candidate.is_file()
                    && candidate.extension().and_then(|value| value.to_str()) != Some("tmp")
                    && !known_paths.contains(&candidate)
                {
                    fs::remove_file(candidate).map_err(|_| AppError::Storage)?;
                    removed += 1;
                }
            }
        }
        Ok(removed)
    }

    fn dto(&self, asset: QuestionAsset) -> QuestionAssetDto {
        let status = self
            .resolve_path(&asset)
            .ok()
            .filter(|path| path.is_file())
            .map(|_| AssetStatus::Ready)
            .unwrap_or(AssetStatus::Missing);
        QuestionAssetDto {
            id: asset.id,
            question_id: asset.question_id,
            asset_type: asset.asset_type,
            display_name: asset.display_name,
            mime_type: asset.mime_type,
            size_bytes: asset.size_bytes,
            position: asset.position,
            page_reference: asset.page_reference,
            created_at: asset.created_at,
            status,
        }
    }

    fn resolve_path(&self, asset: &QuestionAsset) -> Result<PathBuf, AppError> {
        let relative = Path::new(&asset.storage_path);
        if relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(AppError::AssetCorrupted);
        }
        let app_data_dir = self.assets_root.parent().ok_or(AppError::Storage)?;
        let full_path = app_data_dir.join(relative);
        if !full_path.starts_with(&self.assets_root) {
            return Err(AppError::AssetCorrupted);
        }
        Ok(full_path)
    }

    fn stage_for_delete(&self, asset: &QuestionAsset) -> Result<Option<PathBuf>, AppError> {
        let source = self.resolve_path(asset)?;
        if !source.exists() {
            return Ok(None);
        }
        if !source.is_file() {
            return Err(AppError::AssetCorrupted);
        }
        let staged = self.trash_root.join(format!("{}.delete", asset.id));
        if staged.exists() || fs::rename(&source, &staged).is_err() {
            return Err(AppError::Storage);
        }
        Ok(Some(staged))
    }

    fn restore_staged(&self, asset: &QuestionAsset, staged: Option<&Path>) {
        let Some(staged) = staged else {
            return;
        };
        let Ok(final_path) = self.resolve_path(asset) else {
            return;
        };
        if final_path.exists() {
            remove_file_quietly(staged);
            return;
        }
        let _ = fs::rename(staged, final_path);
    }

    fn recover_staged_deletions(&self) -> Result<(), AppError> {
        for entry in fs::read_dir(&self.trash_root).map_err(|_| AppError::Storage)? {
            let entry = entry.map_err(|_| AppError::Storage)?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("delete") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|value| value.to_str()) else {
                remove_file_quietly(&path);
                continue;
            };
            if let Some(asset) = QuestionAssetRepository::get_by_id(&self.database, id)? {
                let final_path = self.resolve_path(&asset)?;
                if final_path.exists() {
                    remove_file_quietly(&path);
                } else {
                    fs::rename(&path, final_path).map_err(|_| AppError::Storage)?;
                }
            } else {
                remove_file_quietly(&path);
            }
        }
        Ok(())
    }

    fn cleanup_stale_temp_files(&self, minimum_age: Duration) -> Result<(), AppError> {
        let now = SystemTime::now();
        for entry in fs::read_dir(&self.assets_root).map_err(|_| AppError::Storage)? {
            let entry = entry.map_err(|_| AppError::Storage)?;
            let path = entry.path();
            if !path.is_dir() || path == self.trash_root {
                continue;
            }
            for file in fs::read_dir(path).map_err(|_| AppError::Storage)? {
                let file = file.map_err(|_| AppError::Storage)?;
                let candidate = file.path();
                if candidate.extension().and_then(|value| value.to_str()) != Some("tmp") {
                    continue;
                }
                let modified = file.metadata().map_err(|_| AppError::Storage)?.modified();
                if modified
                    .ok()
                    .and_then(|time| now.duration_since(time).ok())
                    .is_some_and(|age| age >= minimum_age)
                {
                    fs::remove_file(candidate).map_err(|_| AppError::Storage)?;
                }
            }
        }
        Ok(())
    }

    fn cleanup_stale_drafts(&self, minimum_age: Duration) -> Result<(), AppError> {
        let now = SystemTime::now();
        for entry in fs::read_dir(&self.drafts_root).map_err(|_| AppError::Storage)? {
            let entry = entry.map_err(|_| AppError::Storage)?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let modified = entry.metadata().map_err(|_| AppError::Storage)?.modified();
            if modified
                .ok()
                .and_then(|time| now.duration_since(time).ok())
                .is_some_and(|age| age >= minimum_age)
            {
                fs::remove_dir_all(path).map_err(|_| AppError::Storage)?;
            }
        }
        Ok(())
    }

    fn draft_directory(&self, draft_id: &str) -> Result<PathBuf, AppError> {
        uuid::Uuid::parse_str(draft_id)
            .map_err(|_| AppError::Validation("question draft ID is invalid".to_owned()))?;
        Ok(self.drafts_root.join(draft_id))
    }

    fn draft_record_path(&self, draft_id: &str, draft_asset_id: &str) -> Result<PathBuf, AppError> {
        uuid::Uuid::parse_str(draft_asset_id)
            .map_err(|_| AppError::Validation("draft asset ID is invalid".to_owned()))?;
        Ok(self
            .draft_directory(draft_id)?
            .join(format!("{draft_asset_id}.json")))
    }

    fn draft_asset_path(
        &self,
        draft_id: &str,
        record: &DraftAssetRecord,
    ) -> Result<PathBuf, AppError> {
        let kind = MediaKind::from_extension(&record.extension).ok_or(AppError::AssetCorrupted)?;
        if kind.asset_type() != record.asset_type || kind.mime_type() != record.mime_type {
            return Err(AppError::AssetCorrupted);
        }
        Ok(self
            .draft_directory(draft_id)?
            .join(format!("{}.{}", record.id, record.extension)))
    }

    fn list_draft_records(&self, draft_id: &str) -> Result<Vec<DraftAssetRecord>, AppError> {
        let directory = self.draft_directory(draft_id)?;
        if !directory.is_dir() {
            return Err(AppError::NotFound("question draft".to_owned()));
        }
        let mut records = Vec::new();
        for entry in fs::read_dir(directory).map_err(|_| AppError::Storage)? {
            let entry = entry.map_err(|_| AppError::Storage)?;
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            let stem = path.file_stem().and_then(|value| value.to_str());
            let Some(id) = stem else {
                return Err(AppError::AssetCorrupted);
            };
            let record = self.draft_record(draft_id, id)?;
            if record.id != id {
                return Err(AppError::AssetCorrupted);
            }
            records.push(record);
        }
        records.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(records)
    }

    fn draft_record(
        &self,
        draft_id: &str,
        draft_asset_id: &str,
    ) -> Result<DraftAssetRecord, AppError> {
        let path = self.draft_record_path(draft_id, draft_asset_id)?;
        let bytes = fs::read(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppError::NotFound("draft asset".to_owned())
            } else {
                AppError::Storage
            }
        })?;
        serde_json::from_slice(&bytes).map_err(|_| AppError::AssetCorrupted)
    }

    fn write_draft_record(
        &self,
        draft_id: &str,
        record: &DraftAssetRecord,
    ) -> Result<(), AppError> {
        let path = self.draft_record_path(draft_id, &record.id)?;
        let bytes = serde_json::to_vec(record).map_err(|_| AppError::Storage)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|_| AppError::Storage)?;
        file.write_all(&bytes).map_err(|_| AppError::Storage)?;
        file.flush().map_err(|_| AppError::Storage)
    }

    fn verify_draft_record(
        &self,
        draft_id: &str,
        record: &DraftAssetRecord,
    ) -> Result<(), AppError> {
        let path = self.draft_asset_path(draft_id, record)?;
        let profile = source_profile(&path).map_err(|error| match error {
            AppError::UnsupportedMediaType | AppError::FileTooLarge => AppError::AssetCorrupted,
            other => other,
        })?;
        if profile.extension != record.extension
            || profile.kind.asset_type() != record.asset_type
            || profile.kind.mime_type() != record.mime_type
            || profile.size_bytes != record.size_bytes
            || hash_file(&path)? != record.sha256
        {
            return Err(AppError::AssetCorrupted);
        }
        Ok(())
    }

    fn draft_dto(
        &self,
        draft_id: &str,
        record: DraftAssetRecord,
    ) -> Result<DraftQuestionAssetDto, AppError> {
        let path = self.draft_asset_path(draft_id, &record)?;
        Ok(DraftQuestionAssetDto {
            id: record.id,
            draft_id: draft_id.to_owned(),
            asset_type: record.asset_type,
            display_name: record.display_name,
            mime_type: record.mime_type,
            size_bytes: i64::try_from(record.size_bytes).map_err(|_| AppError::FileTooLarge)?,
            asset_url: asset_protocol_url(&path)?,
        })
    }

    fn remove_promotion_files(&self, staged: &[PromotedDraftAsset]) {
        for item in staged {
            remove_file_quietly(&item.temporary_path);
            remove_file_quietly(&item.final_path);
        }
    }
}

fn source_profile(source: &Path) -> Result<SourceProfile, AppError> {
    let metadata = fs::metadata(source).map_err(|_| AppError::Storage)?;
    if !metadata.is_file() {
        return Err(AppError::UnsupportedMediaType);
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or(AppError::UnsupportedMediaType)?;
    let kind = MediaKind::from_extension(&extension).ok_or(AppError::UnsupportedMediaType)?;
    validate_size(kind, metadata.len())?;
    let mut file = File::open(source).map_err(|_| AppError::Storage)?;
    let mut header = [0_u8; 16];
    let read = file.read(&mut header).map_err(|_| AppError::Storage)?;
    if !kind.signature_matches(&header[..read]) {
        return Err(AppError::UnsupportedMediaType);
    }
    Ok(SourceProfile {
        kind,
        extension,
        display_name: safe_display_name(source),
        size_bytes: metadata.len(),
    })
}

fn safe_display_name(path: &Path) -> String {
    let raw = path
        .file_name()
        .map(|value| value.to_string_lossy())
        .unwrap_or_default();
    let cleaned = raw
        .chars()
        .filter(|character| !character.is_control() && *character != '/' && *character != '\\')
        .take(200)
        .collect::<String>();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "Imported file".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn validate_size(kind: MediaKind, size_bytes: u64) -> Result<(), AppError> {
    if size_bytes > kind.maximum_size() {
        return Err(AppError::FileTooLarge);
    }
    Ok(())
}

fn hash_file(path: &Path) -> Result<String, AppError> {
    let mut file = File::open(path).map_err(|_| AppError::Storage)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|_| AppError::Storage)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn copy_and_hash(source: &Path, temporary: &Path) -> Result<(u64, String), AppError> {
    let mut input = File::open(source).map_err(|_| AppError::Storage)?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary)
        .map_err(|_| AppError::Storage)?;
    let mut hash = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = input.read(&mut buffer).map_err(|_| AppError::Storage)?;
        if count == 0 {
            break;
        }
        output
            .write_all(&buffer[..count])
            .map_err(|_| AppError::Storage)?;
        hash.update(&buffer[..count]);
        bytes = bytes
            .checked_add(u64::try_from(count).map_err(|_| AppError::Storage)?)
            .ok_or(AppError::FileTooLarge)?;
    }
    output.flush().map_err(|_| AppError::Storage)?;
    Ok((bytes, format!("{:x}", hash.finalize())))
}

fn verify_file(path: &Path, asset: &QuestionAsset) -> Result<(), AppError> {
    let metadata = fs::metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::AssetMissing
        } else {
            AppError::Storage
        }
    })?;
    if !metadata.is_file()
        || metadata.len()
            != u64::try_from(asset.size_bytes).map_err(|_| AppError::AssetCorrupted)?
    {
        return Err(AppError::AssetCorrupted);
    }
    let expected_hash = asset.sha256.as_deref().ok_or(AppError::AssetCorrupted)?;
    if hash_file(path)? != expected_hash {
        return Err(AppError::AssetCorrupted);
    }
    Ok(())
}

fn remove_file_quietly(path: &Path) {
    let _ = fs::remove_file(path);
}

fn asset_protocol_url(path: &Path) -> Result<String, AppError> {
    let value = path.to_str().ok_or(AppError::Storage)?;
    #[cfg(target_os = "windows")]
    let value = value.replace('/', "\\");
    let encoded = value
        .as_bytes()
        .iter()
        .flat_map(|byte| match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => format!("{}", char::from(*byte)).into_bytes(),
            _ => format!("%{byte:02X}").into_bytes(),
        })
        .map(char::from)
        .collect::<String>();
    #[cfg(target_os = "windows")]
    {
        Ok(format!("http://asset.localhost/{encoded}"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(format!("asset://localhost/{encoded}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::persistence::repositories::{
        NewQuestion, NewQuestionSet, Question, QuestionSetRepository,
    };

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfixture";
    const PDF: &[u8] = b"%PDF-1.4\nfixture";

    fn setup() -> (tempfile::TempDir, AssetService, Question) {
        let directory = tempfile::tempdir().expect("directory");
        let database = Database::open(directory.path().join("classroom.sqlite3"));
        database.initialize().expect("database");
        let service = AssetService::initialize(database.clone(), directory.path()).expect("assets");
        let set = QuestionSetRepository::create(
            &database,
            NewQuestionSet {
                lesson_id: None,
                title: "Set".to_owned(),
                description: None,
            },
        )
        .expect("set");
        let question = QuestionRepository::create(
            &database,
            NewQuestion {
                question_set_id: set.id,
                question_type: "essay".to_owned(),
                prompt: "Prompt".to_owned(),
                points: 1,
                position: 0,
                answer_config: serde_json::json!({}),
                grading_config: serde_json::json!({}),
                metadata: serde_json::json!({}),
            },
        )
        .expect("question");
        (directory, service, question)
    }

    fn write_fixture(directory: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = directory.join(name);
        fs::write(&path, bytes).expect("fixture");
        path
    }

    #[test]
    fn imports_image_and_pdf_without_moving_sources_and_rejects_duplicate_hashes() {
        let (directory, service, question) = setup();
        let image = write_fixture(directory.path(), "diagram.png", PNG);
        let pdf = write_fixture(directory.path(), "chapter.pdf", PDF);
        let image_asset = service
            .import(ImportQuestionAssetRequest {
                question_id: question.id.clone(),
                source_path: image.display().to_string(),
            })
            .expect("image import");
        let pdf_asset = service
            .import(ImportQuestionAssetRequest {
                question_id: question.id.clone(),
                source_path: pdf.display().to_string(),
            })
            .expect("pdf import");

        assert!(image.exists());
        assert!(pdf.exists());
        assert_eq!(image_asset.asset_type, "image");
        assert_eq!(pdf_asset.asset_type, "pdf");
        assert!(matches!(
            service.import(ImportQuestionAssetRequest {
                question_id: question.id,
                source_path: image.display().to_string()
            }),
            Err(AppError::Conflict(_))
        ));
        assert!(service
            .get_preview(image_asset.id)
            .expect("preview")
            .asset_url
            .contains("asset"));
    }

    #[test]
    fn imports_and_discards_draft_assets_without_formal_metadata() {
        let (directory, service, question) = setup();
        let image = write_fixture(directory.path(), "diagram.png", PNG);
        let pdf = write_fixture(directory.path(), "chapter.pdf", PDF);
        let draft = service.create_draft().expect("draft");
        let image_asset = service
            .import_draft(ImportQuestionDraftAssetRequest {
                draft_id: draft.id.clone(),
                source_path: image.display().to_string(),
            })
            .expect("draft image");
        let pdf_asset = service
            .import_draft(ImportQuestionDraftAssetRequest {
                draft_id: draft.id.clone(),
                source_path: pdf.display().to_string(),
            })
            .expect("draft pdf");

        assert!(image.exists());
        assert!(pdf.exists());
        assert_eq!(image_asset.asset_type, "image");
        assert_eq!(pdf_asset.asset_type, "pdf");
        assert!(service
            .draft_asset_path(
                &draft.id,
                &service
                    .draft_record(&draft.id, &image_asset.id)
                    .expect("record"),
            )
            .expect("draft path")
            .exists());
        assert!(
            QuestionAssetRepository::list_by_question(&service.database, &question.id)
                .expect("formal assets")
                .is_empty()
        );
        assert!(matches!(
            service.import_draft(ImportQuestionDraftAssetRequest {
                draft_id: draft.id.clone(),
                source_path: image.display().to_string(),
            }),
            Err(AppError::Conflict(_))
        ));

        service.discard_draft(draft.id.clone()).expect("discard");
        assert!(!service
            .draft_directory(&draft.id)
            .expect("draft path")
            .exists());
        assert!(QuestionRepository::get(&service.database, &question.id)
            .expect("question")
            .is_some());
        assert!(
            QuestionAssetRepository::list_by_question(&service.database, &question.id)
                .expect("formal assets")
                .is_empty()
        );
    }

    #[test]
    fn keeps_draft_and_removes_final_files_when_promotion_metadata_fails() {
        let (directory, service, question) = setup();
        let image = write_fixture(directory.path(), "diagram.png", PNG);
        let draft = service.create_draft().expect("draft");
        let imported = service
            .import_draft(ImportQuestionDraftAssetRequest {
                draft_id: draft.id.clone(),
                source_path: image.display().to_string(),
            })
            .expect("draft asset");
        let connection = service.database.connection().expect("connection");
        connection
            .execute_batch("CREATE TRIGGER reject_draft_asset_insert BEFORE INSERT ON question_assets BEGIN SELECT RAISE(ABORT, 'reject'); END;")
            .expect("trigger");

        assert!(service.promote_draft(&question.id, &draft.id).is_err());
        assert!(
            QuestionAssetRepository::list_by_question(&service.database, &question.id)
                .expect("formal assets")
                .is_empty()
        );
        assert!(service
            .draft_asset_path(
                &draft.id,
                &service
                    .draft_record(&draft.id, &imported.id)
                    .expect("record"),
            )
            .expect("draft path")
            .exists());
        let formal_file_count = fs::read_dir(&service.assets_root)
            .expect("assets root")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name() != ".draft" && entry.file_name() != ".trash")
            .filter_map(|entry| fs::read_dir(entry.path()).ok())
            .flat_map(|entries| entries.filter_map(Result::ok))
            .filter(|entry| entry.path().is_file())
            .count();
        assert_eq!(formal_file_count, 0);
    }

    #[test]
    fn rejects_invalid_signatures_unsupported_types_and_size_limits() {
        let (directory, service, question) = setup();
        let renamed = write_fixture(directory.path(), "not-image.png", b"not an image");
        let fake_pdf = write_fixture(directory.path(), "not-a-pdf.pdf", b"plain text");
        let svg = write_fixture(directory.path(), "active.svg", b"<svg/>");
        assert!(matches!(
            service.import(ImportQuestionAssetRequest {
                question_id: question.id.clone(),
                source_path: renamed.display().to_string()
            }),
            Err(AppError::UnsupportedMediaType)
        ));
        assert!(matches!(
            service.import(ImportQuestionAssetRequest {
                question_id: question.id.clone(),
                source_path: fake_pdf.display().to_string()
            }),
            Err(AppError::UnsupportedMediaType)
        ));
        assert!(matches!(
            service.import(ImportQuestionAssetRequest {
                question_id: question.id.clone(),
                source_path: svg.display().to_string()
            }),
            Err(AppError::UnsupportedMediaType)
        ));
        assert!(matches!(
            validate_size(MediaKind::Png, MAX_IMAGE_BYTES + 1),
            Err(AppError::FileTooLarge)
        ));
    }

    #[test]
    fn deletes_assets_cleans_question_assets_and_handles_missing_files() {
        let (directory, service, question) = setup();
        let image = write_fixture(directory.path(), "diagram.png", PNG);
        let pdf = write_fixture(directory.path(), "chapter.pdf", PDF);
        let image_asset = service
            .import(ImportQuestionAssetRequest {
                question_id: question.id.clone(),
                source_path: image.display().to_string(),
            })
            .expect("image import");
        let pdf_asset = service
            .import(ImportQuestionAssetRequest {
                question_id: question.id.clone(),
                source_path: pdf.display().to_string(),
            })
            .expect("pdf import");
        let stored_image = service
            .resolve_path(
                &QuestionAssetRepository::get_by_id(&service.database, &image_asset.id)
                    .expect("asset")
                    .expect("present"),
            )
            .expect("path");
        fs::remove_file(&stored_image).expect("remove for missing check");
        assert!(matches!(
            service.get_preview(image_asset.id.clone()),
            Err(AppError::AssetMissing)
        ));
        service
            .delete(image_asset.id)
            .expect("delete missing metadata");
        let stored_pdf = service
            .resolve_path(
                &QuestionAssetRepository::get_by_id(&service.database, &pdf_asset.id)
                    .expect("asset")
                    .expect("present"),
            )
            .expect("path");
        service
            .delete_question_with_assets(&question.id)
            .expect("question delete");
        assert!(!stored_pdf.exists());
        assert!(
            QuestionAssetRepository::list_by_question(&service.database, &question.id)
                .expect("assets")
                .is_empty()
        );
    }

    #[test]
    fn detects_and_cleans_orphans_and_stale_temporary_files() {
        let (directory, service, _) = setup();
        let shard = service.assets_root.join("aa");
        fs::create_dir_all(&shard).expect("shard");
        let orphan = shard.join("orphan.png");
        let temporary = shard.join("import.tmp");
        fs::write(&orphan, PNG).expect("orphan");
        fs::write(&temporary, PNG).expect("temporary");
        assert_eq!(service.cleanup_orphans().expect("cleanup"), 1);
        service
            .cleanup_stale_temp_files(Duration::ZERO)
            .expect("temp cleanup");
        let draft = service.create_draft().expect("draft");
        service
            .cleanup_stale_drafts(Duration::ZERO)
            .expect("draft cleanup");
        assert!(!orphan.exists());
        assert!(!temporary.exists());
        assert!(!service
            .draft_directory(&draft.id)
            .expect("draft path")
            .exists());
        assert!(directory.path().exists());
    }

    #[test]
    fn compensates_for_database_insert_and_delete_failures() {
        let (directory, service, question) = setup();
        let image = write_fixture(directory.path(), "diagram.png", PNG);
        let connection = service.database.connection().expect("connection");
        connection
            .execute_batch("CREATE TRIGGER reject_asset_insert BEFORE INSERT ON question_assets BEGIN SELECT RAISE(ABORT, 'reject'); END;")
            .expect("insert trigger");
        assert!(service
            .import(ImportQuestionAssetRequest {
                question_id: question.id.clone(),
                source_path: image.display().to_string()
            })
            .is_err());
        assert!(
            QuestionAssetRepository::list_by_question(&service.database, &question.id)
                .expect("assets")
                .is_empty()
        );
        let copied_files = fs::read_dir(&service.assets_root)
            .expect("assets root")
            .flat_map(|entry| entry.expect("entry").path().read_dir().expect("shard"))
            .count();
        assert_eq!(copied_files, 0);
        connection
            .execute_batch("DROP TRIGGER reject_asset_insert")
            .expect("drop trigger");
        let asset = service
            .import(ImportQuestionAssetRequest {
                question_id: question.id,
                source_path: image.display().to_string(),
            })
            .expect("import");
        let stored = service
            .resolve_path(
                &QuestionAssetRepository::get_by_id(&service.database, &asset.id)
                    .expect("lookup")
                    .expect("asset"),
            )
            .expect("path");
        connection
            .execute_batch("CREATE TRIGGER reject_asset_delete BEFORE DELETE ON question_assets BEGIN SELECT RAISE(ABORT, 'reject'); END;")
            .expect("delete trigger");
        assert!(service.delete(asset.id.clone()).is_err());
        assert!(stored.exists());
        service.get_preview(asset.id).expect("restored preview");
    }
}
