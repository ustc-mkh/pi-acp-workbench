//! Typed provider extension boundary. Never infer private methods from a
//! provider name: the peer must explicitly negotiate the supported version.
use super::dto::NativeSessionId;
use crate::domain::{error::DomainError, ids::ProviderSessionId};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ProviderMetadata {
    #[serde(
        default,
        rename = "pi-workbench",
        skip_serializing_if = "Option::is_none"
    )]
    pub pi_workbench: Option<PiWorkbenchCapabilities>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiWorkbenchCapabilities {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub inspect: bool,
    #[serde(default)]
    pub native_fork: bool,
}
pub(super) fn deserialize_metadata<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<ProviderMetadata, D::Error> {
    Option::<ProviderMetadata>::deserialize(deserializer).map(Option::unwrap_or_default)
}
impl ProviderMetadata {
    pub fn is_empty(&self) -> bool {
        self.pi_workbench.is_none()
    }
    pub fn supports_inspection(&self) -> bool {
        self.pi_workbench
            .as_ref()
            .is_some_and(|cap| cap.version == 1 && cap.inspect)
    }
    pub fn supports_native_fork(&self) -> bool {
        self.pi_workbench
            .as_ref()
            .is_some_and(|cap| cap.version == 1 && cap.inspect && cap.native_fork)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectRequest {
    pub session_id: NativeSessionId,
    pub cursor: u64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectResponse {
    #[serde(default)]
    pub fork_points: Vec<NativeForkPoint>,
    #[serde(default)]
    pub context_window: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeForkPoint {
    pub entry_id: crate::domain::ids::ProviderEntryId,
    pub hash: NativePointHash,
    pub role: NativeRole,
    pub key: String,
    pub safe: bool,
}
/// Pi intentionally reports an empty hash for unsafe intermediate points.
/// It is not a usable target and must never cross into the domain as a prefix.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub enum NativePointHash {
    Unavailable,
    Prefix(crate::domain::fork::PrefixHash),
}
impl TryFrom<String> for NativePointHash {
    type Error = DomainError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.is_empty() {
            Ok(Self::Unavailable)
        } else {
            crate::domain::fork::PrefixHash::new(value).map(Self::Prefix)
        }
    }
}
impl From<NativePointHash> for String {
    fn from(value: NativePointHash) -> Self {
        match value {
            NativePointHash::Unavailable => String::new(),
            NativePointHash::Prefix(hash) => hash.into(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub enum NativeRole {
    User,
    Assistant,
}
impl TryFrom<String> for NativeRole {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "user" => Ok(Self::User),
            "assistant" => Ok(Self::Assistant),
            _ => Err("invalid native fork role"),
        }
    }
}
impl From<NativeRole> for String {
    fn from(role: NativeRole) -> Self {
        match role {
            NativeRole::User => "user",
            NativeRole::Assistant => "assistant",
        }
        .into()
    }
}
impl InspectResponse {
    pub fn candidates(self) -> Result<Vec<crate::domain::fork::ForkCandidate>, DomainError> {
        use crate::domain::fork::{ContentHash, ForkCandidate, ForkRole, ForkTarget};
        if self.fork_points.len() > 16384 {
            return Err(DomainError::Protocol("too many native fork points".into()));
        }
        let mut seen = std::collections::BTreeSet::new();
        self.fork_points
            .into_iter()
            .map(|point| {
                if !seen.insert(point.entry_id.clone()) {
                    return Err(DomainError::Protocol("duplicate native fork point".into()));
                }
                let (role, prefix) = match point.role {
                    NativeRole::User => (ForkRole::User, "user:"),
                    NativeRole::Assistant => (ForkRole::Agent, "assistant:"),
                };
                let text_hash = point
                    .key
                    .strip_prefix(prefix)
                    .ok_or_else(|| DomainError::Protocol("native fork key role mismatch".into()))?;
                let text = ContentHash::new(text_hash)?;
                let prefix = match point.hash {
                    NativePointHash::Prefix(hash) => hash,
                    NativePointHash::Unavailable if !point.safe => return Ok(None),
                    NativePointHash::Unavailable => {
                        return Err(DomainError::Protocol(
                            "safe native fork point has no prefix hash".into(),
                        ))
                    }
                };
                Ok(Some(ForkCandidate {
                    target: ForkTarget {
                        entry: point.entry_id,
                        prefix,
                    },
                    role,
                    text,
                    safe: point.safe,
                }))
            })
            .collect::<Result<Vec<_>, _>>()
            .map(|points| points.into_iter().flatten().collect())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkRequest {
    pub session_id: NativeSessionId,
    pub entry_id: crate::domain::ids::ProviderEntryId,
    pub hash: crate::domain::fork::PrefixHash,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkResponse {
    pub session_id: NativeSessionId,
}
impl ForkResponse {
    pub fn independent(self, source: &NativeSessionId) -> Result<ProviderSessionId, DomainError> {
        if &self.session_id == source {
            return Err(DomainError::Protocol(
                "native fork did not return an independent session".into(),
            ));
        }
        ProviderSessionId::new(self.session_id.as_str()).map_err(DomainError::from)
    }
}
