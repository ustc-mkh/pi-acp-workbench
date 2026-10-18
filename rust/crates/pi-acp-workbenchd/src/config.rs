use crate::domain::error::DomainError;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf};

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub workers: WorkersConfig,
    pub sessions: SessionsConfig,
    pub telegram: Option<TelegramConfig>,
    pub storage: StorageConfig,
    pub limits: LimitsConfig,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkersConfig {
    #[serde(default)]
    pub pi: Option<WorkerConfig>,
    #[serde(default)]
    pub codex: Option<WorkerConfig>,
    #[serde(default)]
    pub claude: Option<WorkerConfig>,
}
impl WorkersConfig {
    pub fn get(&self, harness: &crate::domain::Harness) -> Option<&WorkerConfig> {
        match harness {
            crate::domain::Harness::Pi => self.pi.as_ref(),
            crate::domain::Harness::Codex => self.codex.as_ref(),
            crate::domain::Harness::Claude => self.claude.as_ref(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionsConfig {
    #[serde(default = "default_mailbox")]
    pub mailbox: usize,
    #[serde(default = "default_workers")]
    pub max_workers: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TelegramConfig {
    pub bot_token_env: String,
    pub workspace: crate::domain::WorkspacePath,
    pub allowed_chat_ids: Vec<crate::telegram::types::ChatId>,
    #[serde(default)]
    pub allowed_user_ids: Vec<crate::telegram::types::UserId>,
    #[serde(default = "default_bot_api")]
    pub api_base: String,
    #[serde(default = "default_mailbox")]
    pub inbox_capacity: usize,
}
fn default_bot_api() -> String {
    "https://api.telegram.org/".into()
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StorageConfig {
    pub root: PathBuf,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LimitsConfig {
    #[serde(default = "default_interactions")]
    pub pending_interactions: usize,
}
fn default_mailbox() -> usize {
    128
}
fn default_workers() -> usize {
    16
}
fn default_interactions() -> usize {
    32
}
impl Config {
    pub fn validate(&self) -> Result<(), DomainError> {
        let launches: Vec<_> = [&self.workers.pi, &self.workers.codex, &self.workers.claude]
            .into_iter()
            .flatten()
            .collect();
        if launches.is_empty()
            || launches.iter().any(|launch| {
                launch.command.trim().is_empty()
                    || launch.command.contains('\0')
                    || launch.args.iter().any(|arg| arg.contains('\0'))
                    || launch.env.iter().any(|(key, value)| {
                        key.is_empty() || key.contains(['=', '\0']) || value.contains('\0')
                    })
            })
        {
            return Err(DomainError::Persistence(
                "invalid or empty per-harness worker configuration".into(),
            ));
        }
        if !(1..=1024).contains(&self.sessions.mailbox)
            || !(1..=1024).contains(&self.sessions.max_workers)
            || !(1..=32).contains(&self.limits.pending_interactions)
        {
            return Err(DomainError::Persistence("invalid runtime limits".into()));
        }
        if let Some(telegram) = &self.telegram {
            let valid_env = !telegram.bot_token_env.is_empty()
                && telegram
                    .bot_token_env
                    .bytes()
                    .enumerate()
                    .all(|(index, byte)| {
                        byte == b'_'
                            || byte.is_ascii_alphabetic()
                            || (index > 0 && byte.is_ascii_digit())
                    });
            if !valid_env
                || telegram.allowed_chat_ids.is_empty()
                || !(1..=1024).contains(&telegram.inbox_capacity)
                || !telegram.workspace.as_ref().is_dir()
            {
                return Err(DomainError::Persistence(
                    "invalid Telegram configuration".into(),
                ));
            }
            crate::telegram::api::BotClient::new(&telegram.api_base, "configuration-validation")
                .map_err(|_| DomainError::Persistence("invalid Telegram API endpoint".into()))?;
        }
        Ok(())
    }
}
