use crate::domain::{
    ids::{DeliveryId, IdError},
    interaction::InteractionAnswer,
    InteractionId, SessionId,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fmt, str::FromStr};
macro_rules! number_id {
    ($name:ident, $valid:expr) => {
        #[derive(
            Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize, Deserialize,
        )]
        #[serde(try_from = "i64", into = "i64")]
        pub struct $name(i64);
        impl $name {
            pub fn new(value: i64) -> Result<Self, IdError> {
                if ($valid)(value) {
                    Ok(Self(value))
                } else {
                    Err(IdError)
                }
            }
            pub fn get(self) -> i64 {
                self.0
            }
        }
        impl TryFrom<i64> for $name {
            type Error = IdError;
            fn try_from(value: i64) -> Result<Self, IdError> {
                Self::new(value)
            }
        }
        impl From<$name> for i64 {
            fn from(value: $name) -> i64 {
                value.0
            }
        }
    };
}
number_id!(ChatId, |value: i64| value != 0);
number_id!(TopicId, |value: i64| value > 0);
number_id!(UserId, |value: i64| value > 0);
number_id!(MessageId, |value: i64| value > 0);
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct TopicKey {
    pub chat: ChatId,
    pub thread: Option<TopicId>,
}
impl TopicKey {
    pub(crate) fn from_delivery(
        chat: i64,
        thread: i64,
    ) -> Result<Self, crate::domain::error::DomainError> {
        Ok(Self {
            chat: ChatId::new(chat)?,
            thread: if thread == 0 {
                None
            } else {
                Some(TopicId::new(thread)?)
            },
        })
    }
    pub(crate) fn delivery_target(
        &self,
        bot_id: i64,
        cwd: crate::domain::WorkspacePath,
    ) -> crate::domain::transition::DeliveryTarget {
        crate::domain::transition::DeliveryTarget::Telegram {
            bot_id,
            chat: self.chat.get(),
            thread: self.thread.map_or(0, |thread| thread.get()),
            cwd,
        }
    }
}
impl fmt::Display for TopicKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:", self.chat.get())?;
        match self.thread {
            Some(thread) => write!(f, "{}", thread.get()),
            None => f.write_str("root"),
        }
    }
}
impl FromStr for TopicKey {
    type Err = IdError;
    fn from_str(value: &str) -> Result<Self, IdError> {
        let (chat, thread) = value.split_once(':').ok_or(IdError)?;
        let topic = Self {
            chat: ChatId::new(chat.parse().map_err(|_| IdError)?)?,
            thread: if thread == "root" {
                None
            } else {
                Some(TopicId::new(thread.parse().map_err(|_| IdError)?)?)
            },
        };
        if topic.to_string() != value {
            return Err(IdError);
        }
        Ok(topic)
    }
}
impl TryFrom<String> for TopicKey {
    type Error = IdError;
    fn try_from(value: String) -> Result<Self, IdError> {
        value.parse()
    }
}
impl From<TopicKey> for String {
    fn from(value: TopicKey) -> String {
        value.to_string()
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
pub struct UpdateId(u64);
impl UpdateId {
    pub fn new(value: u64) -> Result<Self, IdError> {
        if value < u64::MAX {
            Ok(Self(value))
        } else {
            Err(IdError)
        }
    }
    pub fn get(self) -> u64 {
        self.0
    }
}
impl TryFrom<u64> for UpdateId {
    type Error = IdError;
    fn try_from(value: u64) -> Result<Self, IdError> {
        Self::new(value)
    }
}
impl From<UpdateId> for u64 {
    fn from(value: UpdateId) -> u64 {
        value.0
    }
}
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct CallbackKey(String);
impl CallbackKey {
    pub fn for_option(event: &DeliveryId, option: usize) -> Self {
        Self(format!("{:x}", Sha256::digest(format!("{event}:{option}"))))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl TryFrom<String> for CallbackKey {
    type Error = IdError;
    fn try_from(value: String) -> Result<Self, IdError> {
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(IdError);
        }
        Ok(Self(value))
    }
}
impl From<CallbackKey> for String {
    fn from(value: CallbackKey) -> String {
        value.0
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CallbackBinding {
    pub topic: TopicKey,
    pub action: CallbackAction,
    pub expires_at: u64,
    pub used_by: Option<UpdateId>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub enum CallbackAction {
    Answer {
        session: SessionId,
        answer: InteractionAnswer,
    },
    Control {
        command: super::command::ControlCommand,
        expected_binding: Option<SessionId>,
    },
}
/// Topic-scoped delivery policy, independent of the currently bound session.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TopicPreferences {
    pub notifications: bool,
    pub silent: bool,
}
impl Default for TopicPreferences {
    fn default() -> Self {
        Self {
            notifications: true,
            silent: false,
        }
    }
}
/// Absolute assignments are replay-safe; never persist a toggle operation.
#[derive(Clone, Copy, Debug)]
pub enum TopicPreference {
    Notifications(Option<bool>),
    Silent(Option<bool>),
}

#[derive(Clone, Debug)]
pub struct IncomingUpdate {
    pub id: UpdateId,
    pub topic: TopicKey,
    pub sender: UserId,
    pub from_bot: bool,
    pub forum: bool,
    pub content: IncomingContent,
}
#[derive(Clone, Debug)]
pub enum IncomingContent {
    Text(String),
    Callback { key: CallbackKey, query: String },
    Unsupported,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InteractionBinding {
    pub session: SessionId,
    pub interaction: InteractionId,
}
