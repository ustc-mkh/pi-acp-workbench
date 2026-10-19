//! Native branch identities and the bounded proof retained across remote fork.
use super::{error::DomainError, ids::*};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(test)]
#[path = "fork_oracle.rs"]
pub(crate) mod oracle;
#[cfg(test)]
pub(crate) use oracle::prepare;
macro_rules! digest {
    ($name:ident) => {
        #[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);
        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, DomainError> {
                let value = value.into();
                if value.len() != 64
                    || !value
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                {
                    return Err(DomainError::Protocol("invalid SHA-256 digest".into()));
                }
                Ok(Self(value))
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
        impl TryFrom<String> for $name {
            type Error = DomainError;
            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::new(value)
            }
        }
        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }
    };
}
digest!(PrefixHash);
digest!(ContentHash);
impl ContentHash {
    pub fn of(text: &str) -> Self {
        Self(format!("{:x}", Sha256::digest(text.as_bytes())))
    }
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ForkRole {
    User,
    Agent,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ForkTarget {
    pub entry: ProviderEntryId,
    pub prefix: PrefixHash,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ForkCandidate {
    pub target: ForkTarget,
    pub role: ForkRole,
    pub text: ContentHash,
    pub safe: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ForkRequest {
    pub entry: EntryId,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ForkOrigin {
    pub session: SessionId,
    pub entry: EntryId,
    pub target: ForkTarget,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ForkScope {
    pub session: SessionId,
    pub native: ProviderSessionId,
    pub harness: super::Harness,
    pub cwd: super::WorkspacePath,
}
/// No transcript or provider message body can be retained in an adoption plan.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ForkPlan {
    pub scope: ForkScope,
    pub revision: super::query::SafeInteger,
    pub entry_seq: super::query::SafeInteger,
    pub target: ForkTarget,
    pub new_session_id: SessionId,
    pub origin: ForkOrigin,
}
