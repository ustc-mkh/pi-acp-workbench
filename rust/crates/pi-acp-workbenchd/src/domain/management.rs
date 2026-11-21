//! Bounded account settings and indexed usage queries, never full history views.
use super::{session::Harness, SessionId};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalogue_session: Option<SessionId>,
    pub group: Option<String>,
    pub from: Option<u64>,
    pub to: Option<u64>,
    pub session: Option<SessionId>,
    pub model: Option<String>,
    pub cursor: Option<String>,
}
impl ManagementQuery {
    pub fn valid(&self) -> bool {
        (self.catalogue_session.is_none() || self.group.is_none())
            && self
                .group
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective: Option<EffectiveModel>,
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
#[serde(rename_all = "snake_case")]
pub enum SettingSource {
    User,
    Catalogue,
    Unknown,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EffectiveModel {
    pub price: Option<Price>,
    pub price_source: SettingSource,
    pub context_source: SettingSource,
}
impl ModelSetting {
    pub fn effective_price(&self) -> Option<&Price> {
        self.price.as_ref().or(self.default_price.as_ref())
    }
    pub fn effective_values(&self) -> EffectiveModel {
        use SettingSource::*;
        EffectiveModel {
            price: self.effective_price().cloned(),
            price_source: if self.price.is_some() {
                User
            } else if self.default_price.is_some() {
                Catalogue
            } else {
                Unknown
            },
            context_source: if self.context_override.is_some() {
                User
            } else if self.context_window.is_some() {
                Catalogue
            } else {
                Unknown
            },
        }
    }
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
    #[serde(default)]
    pub candidates: Vec<ProviderModel>,
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

pub(crate) fn model_key(model: &str) -> String {
    model
        .rsplit('/')
        .next()
        .unwrap_or(model)
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '_')
        .flat_map(char::to_lowercase)
        .collect()
}
#[derive(Clone, Copy)]
pub(crate) struct Candidate<'a> {
    pub id: &'a str,
    pub price: Option<&'a Price>,
    pub context: Option<u64>,
}
pub(crate) fn catalogue_defaults<'a>(
    models: impl Iterator<Item = Candidate<'a>>,
) -> HashMap<String, (Option<Price>, Option<u64>)> {
    let mut groups: HashMap<String, Vec<Candidate>> = HashMap::new();
    for model in models {
        groups.entry(model_key(model.id)).or_default().push(model);
    }
    groups
        .into_iter()
        .map(|(key, mut candidates)| {
            let priority = |m: &Candidate| {
                [
                    "openai",
                    "anthropic",
                    "google",
                    "mistral",
                    "xai",
                    "deepseek",
                    "openai-codex",
                    "groq",
                ]
                .iter()
                .position(|p| *p == m.id.split('/').next().unwrap_or(""))
                .unwrap_or(100)
            };
            candidates.sort_by_key(|m| (priority(m), m.id));
            let price = candidates
                .iter()
                .filter(|m| priority(m) < 100)
                .find_map(|m| m.price)
                .or_else(|| {
                    candidates.iter().find_map(|m| {
                        m.price.filter(|p| {
                            [p.input, p.output, p.cache_read, p.cache_write]
                                .iter()
                                .any(|v| *v > 0.0)
                        })
                    })
                })
                .or_else(|| candidates.iter().find_map(|m| m.price))
                .cloned();
            let context = candidates.iter().find_map(|m| m.context);
            (key, (price, context))
        })
        .collect()
}
