//! Bounded account settings and indexed usage queries, never full history views.
use super::{session::Harness, SessionId};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}
impl Price {
    pub fn valid(&self) -> bool {
        [self.input, self.output, self.cache_read, self.cache_write]
            .iter()
            .all(|n| n.is_finite() && *n >= 0.0 && *n <= 1_000_000.0)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum ManagementAction {
    Rename {
        title: String,
    },
    Model {
        model: String,
        hidden: bool,
        price: Option<Price>,
    },
    ModelConfig {
        model: String,
        hidden: bool,
        price: Option<Price>,
        multiplier: f64,
        context_window: Option<u64>,
        apply_context: bool,
    },
    Visibility {
        models: Vec<String>,
        hidden: bool,
        reset: bool,
    },
    Naming {
        policy: String,
        model: Option<String>,
    },
    RefreshModels,
    Context {
        model: String,
        context_window: Option<u64>,
    },
}
impl ManagementAction {
    pub fn external(&self) -> bool {
        matches!(
            self,
            Self::RefreshModels
                | Self::Context { .. }
                | Self::ModelConfig {
                    apply_context: true,
                    ..
                }
        )
    }
    pub fn validate(&self) -> bool {
        let model = |s: &str| !s.is_empty() && s.len() <= 300 && !s.chars().any(char::is_control);
        match self {
            Self::Rename { title } => {
                !title.trim().is_empty()
                    && title.chars().count() <= 80
                    && !title.chars().any(char::is_control)
            }
            Self::Model {
                model: m, price, ..
            } => model(m) && price.as_ref().is_none_or(Price::valid),
            Self::ModelConfig {
                model: m,
                price,
                multiplier,
                context_window,
                ..
            } => {
                model(m)
                    && price.as_ref().is_none_or(Price::valid)
                    && multiplier.is_finite()
                    && *multiplier >= 0.0
                    && *multiplier <= 1_000_000.0
                    && context_window.is_none_or(|n| n > 0 && n <= 100_000_000)
            }
            Self::Visibility { models, .. } => {
                !models.is_empty() && models.len() <= 500 && models.iter().all(|s| model(s))
            }
            Self::Naming { policy, model: m } => {
                ["off", "follow", "model"].contains(&policy.as_str())
                    && m.as_ref().is_none_or(|s| model(s))
                    && (policy != "model" || m.is_some())
            }
            Self::Context {
                model: m,
                context_window,
            } => model(m) && context_window.is_none_or(|n| n > 0 && n <= 100_000_000),
            Self::RefreshModels => true,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagementQuery {
    pub group: Option<String>,
    pub from: Option<u64>,
    pub to: Option<u64>,
    pub session: Option<SessionId>,
    pub model: Option<String>,
    pub cursor: Option<String>,
}
impl ManagementQuery {
    pub fn valid(&self) -> bool {
        self.group
            .as_ref()
            .is_none_or(|s| ["model", "day", "week", "month", "session"].contains(&s.as_str()))
            && self.from.unwrap_or(0) <= self.to.unwrap_or(8_640_000_000_000_000)
            && self.to.unwrap_or(0) <= 8_640_000_000_000_000
            && self.model.as_ref().is_none_or(|s| s.len() <= 300)
            && self.cursor.as_ref().is_none_or(|s| s.len() <= 1024)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelSetting {
    pub harness: Harness,
    pub model: String,
    pub hidden: bool,
    pub price: Option<Price>,
    pub default_price: Option<Price>,
    pub context_window: Option<u64>,
    pub default_context_window: Option<u64>,
    pub context_override: Option<u64>,
    pub multiplier: f64,
    pub context_state: Option<String>,
    pub context_error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UsageGroup {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub key: String,
    pub calls: u64,
    pub missing: u64,
    pub cache_missing: u64,
    pub unpriced: u64,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub estimated_usd: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagementData {
    pub models: Vec<ModelSetting>,
    pub naming_policy: String,
    pub title_model: Option<String>,
    pub groups: Vec<UsageGroup>,
    pub totals: Option<UsageGroup>,
    pub next_cursor: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub model: String,
    #[serde(default)]
    pub price: Option<Price>,
    #[serde(default)]
    pub context_window: Option<u64>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProviderModels {
    pub models: Vec<ProviderModel>,
    #[serde(default, rename = "contextAck")]
    pub context_ack: Option<ContextProjection>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TitleUsage {
    pub input: u64,
    pub output: u64,
    #[serde(rename = "cacheRead")]
    pub cache_read: u64,
    #[serde(rename = "cacheWrite")]
    pub cache_write: u64,
    pub model: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TitleResponse {
    pub title: String,
    #[serde(default)]
    pub records: Vec<TitleUsage>,
}

/// SQLite desired-state revision used only for the local Pi profile projection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextProjection {
    pub owner: String,
    pub revision: u64,
}
#[derive(Clone, Debug)]
pub struct ContextIntent {
    pub revision: u64,
    pub model: String,
    pub context_window: Option<u64>,
}
#[derive(Clone, Debug)]
pub struct ContextSnapshot {
    pub revision: u64,
    pub pending: Vec<ContextIntent>,
}
