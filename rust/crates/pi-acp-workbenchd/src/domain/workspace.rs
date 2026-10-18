use super::ids::IdError;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

/// Lexically normalized absolute workspace path. Filesystem canonicalization and
/// authorization belong to the admission boundary, not the pure domain model.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct WorkspacePath(String);

impl WorkspacePath {
    pub fn new(value: impl Into<String>) -> Result<Self, IdError> {
        let value = value.into();
        let path = Path::new(&value);
        if value.len() > 4096
            || value.contains('\0')
            || !path.is_absolute()
            || path
                .components()
                .any(|part| matches!(part, Component::ParentDir))
        {
            return Err(IdError);
        }
        let normalized: PathBuf = path.components().collect();
        Ok(Self(normalized.to_str().ok_or(IdError)?.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl TryFrom<String> for WorkspacePath {
    type Error = IdError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}
impl From<WorkspacePath> for String {
    fn from(value: WorkspacePath) -> Self {
        value.0
    }
}
impl AsRef<Path> for WorkspacePath {
    fn as_ref(&self) -> &Path {
        Path::new(&self.0)
    }
}
