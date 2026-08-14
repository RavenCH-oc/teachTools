use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::error::AppError;

#[derive(Clone)]
pub struct StudentAssetLocation {
    root: PathBuf,
}

#[derive(Clone)]
pub struct StudentAssetProvider {
    root: PathBuf,
    known_assets: Arc<HashSet<String>>,
}

impl StudentAssetLocation {
    #[cfg(test)]
    pub(crate) fn from_root(root: impl AsRef<Path>) -> Self {
        Self {
            root: root.as_ref().to_path_buf(),
        }
    }

    pub fn development_or_bundle(_app: &tauri::AppHandle) -> Result<Self, AppError> {
        #[cfg(debug_assertions)]
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../student/dist");
        #[cfg(not(debug_assertions))]
        let root = _app
            .path()
            .resource_dir()
            .map_err(|error| AppError::Initialization(error.to_string()))?
            .join("student");
        Ok(Self { root })
    }

    pub fn load(&self) -> Result<StudentAssetProvider, AppError> {
        StudentAssetProvider::from_directory(&self.root)
    }
}

impl StudentAssetProvider {
    pub fn from_directory(root: impl AsRef<Path>) -> Result<Self, AppError> {
        let root = root.as_ref().to_path_buf();
        if !root.join("index.html").is_file() {
            return Err(AppError::StudentAssetsUnavailable);
        }
        let mut known_assets = HashSet::new();
        let assets = root.join("assets");
        if assets.is_dir() {
            for entry in fs::read_dir(&assets).map_err(|_| AppError::StudentAssetsUnavailable)? {
                let entry = entry.map_err(|_| AppError::StudentAssetsUnavailable)?;
                if entry
                    .file_type()
                    .map_err(|_| AppError::StudentAssetsUnavailable)?
                    .is_file()
                {
                    if let Some(name) = entry.file_name().to_str() {
                        known_assets.insert(name.to_owned());
                    }
                }
            }
        }
        Ok(Self {
            root,
            known_assets: Arc::new(known_assets),
        })
    }

    pub fn index_html(&self) -> Result<Vec<u8>, AppError> {
        fs::read(self.root.join("index.html")).map_err(|_| AppError::StudentAssetsUnavailable)
    }

    pub fn asset(&self, file_name: &str) -> Result<Option<Vec<u8>>, AppError> {
        if !is_safe_asset_name(file_name) || !self.known_assets.contains(file_name) {
            return Ok(None);
        }
        fs::read(self.root.join("assets").join(file_name))
            .map(Some)
            .map_err(|_| AppError::StudentAssetsUnavailable)
    }
}

fn is_safe_asset_name(value: &str) -> bool {
    !value.is_empty() && !value.contains(['/', '\\']) && !value.contains("..")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_single_file_assets_are_available() {
        let directory = tempfile::tempdir().expect("directory");
        fs::create_dir_all(directory.path().join("assets")).expect("assets");
        fs::write(directory.path().join("index.html"), "<main>student</main>").expect("index");
        fs::write(directory.path().join("assets/app-123.js"), "console.log(1)").expect("asset");
        let provider = StudentAssetProvider::from_directory(directory.path()).expect("provider");
        assert!(provider.asset("app-123.js").expect("asset").is_some());
        assert!(provider.asset("missing.js").expect("missing").is_none());
        assert!(provider.asset("../secret").expect("traversal").is_none());
    }
}
