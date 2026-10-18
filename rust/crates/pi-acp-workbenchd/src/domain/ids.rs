use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};
use uuid::Uuid;

macro_rules! id {
    ($name:ident) => {
        id!($name, |value: &str| value.chars().all(|c| c
            .is_ascii_alphanumeric()
            || matches!(c, '-' | '_' | '.')));
    };
    ($name:ident, $valid:expr) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);
        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, IdError> {
                let value = value.into();
                if value.is_empty()
                    || matches!(value.as_str(), "." | "..")
                    || value.len() > 200
                    || !($valid)(&value)
                {
                    return Err(IdError);
                }
                Ok(Self(value))
            }
            pub fn generate() -> Self {
                Self(Uuid::new_v4().to_string())
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
        impl TryFrom<String> for $name {
            type Error = IdError;
            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::new(value)
            }
        }
        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }
        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
        impl FromStr for $name {
            type Err = IdError;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Self::new(s)
            }
        }
    };
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct IdError;
impl fmt::Display for IdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("invalid identifier")
    }
}
impl std::error::Error for IdError {}
id!(SessionId);
id!(TurnId);
id!(InteractionId);
id!(EntryId);
id!(ImageId);
id!(ContentId);
id!(NoticeId);
id!(DeliveryId);
id!(OperationId);
id!(TerminalId, |value: &str| value.trim() == value
    && !value.chars().any(char::is_control));
id!(ToolCallId, |value: &str| value.trim() == value
    && !value.chars().any(char::is_control));
// Opaque stream grouping metadata, NOT a native history entry or timestamp.
// Pi currently emits random UUIDs here; never use this ID as a fork target.
id!(ProviderMessageId, |value: &str| value.trim() == value
    && !value.chars().any(char::is_control));
id!(ProviderEntryId, |value: &str| value.trim() == value
    && !value.chars().any(char::is_control));
id!(ProviderSessionId, |value: &str| value.trim() == value
    && !value.chars().any(char::is_control));
// Catalogue values may be provider-qualified (for example anthropic/model).
// Unlike filesystem-backed IDs, they are never used to construct paths.
id!(ModelId, |value: &str| value.trim() == value
    && !value.chars().any(char::is_control));
id!(ModeId, |value: &str| value.trim() == value
    && !value.chars().any(char::is_control));
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Prompt(String);
impl TryFrom<String> for Prompt {
    type Error = IdError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}
impl From<Prompt> for String {
    fn from(value: Prompt) -> Self {
        value.0
    }
}
impl Prompt {
    pub fn new(s: impl Into<String>) -> Result<Self, IdError> {
        let s = s.into();
        if s.trim().is_empty() || s.chars().count() > 100_000 {
            Err(IdError)
        } else {
            Ok(Self(s))
        }
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
