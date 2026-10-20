//! Immutable operation identity carried with a local session write set. This
//! is transaction metadata, never a replayable event or a frontend command.
use super::{command::DomainCommand, error::DomainError, OperationId};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct RequestFingerprint(pub(crate) String);
impl RequestFingerprint {
    pub fn of(command: &DomainCommand) -> Result<Self, DomainError> {
        let bytes = serde_json::to_vec(command)
            .map_err(|error| DomainError::Persistence(error.to_string()))?;
        Ok(Self(format!("{:x}", Sha256::digest(bytes))))
    }
}
impl TryFrom<String> for RequestFingerprint {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("invalid request fingerprint");
        }
        Ok(Self(value))
    }
}
impl From<RequestFingerprint> for String {
    fn from(value: RequestFingerprint) -> Self {
        value.0
    }
}
#[derive(Clone, Debug)]
pub struct OperationTicket {
    pub(crate) operation: OperationId,
    pub(crate) fingerprint: RequestFingerprint,
    /// Local-only admission has no durable prepare row; its first write seals
    /// the result atomically. Never use this for a possible external effect.
    pub(crate) local: bool,
}
