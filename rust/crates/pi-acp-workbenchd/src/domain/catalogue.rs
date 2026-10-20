use super::ids::{ModeId, ModelId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct Catalogue {
    pub models: Vec<ModelChoice>,
    pub modes: Vec<ModeChoice>,
    pub commands: Vec<AvailableCommand>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selects: Vec<SelectSetting>,
    #[serde(default)]
    pub image_input: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_model: Option<ModelId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_mode: Option<ModeId>,
}

/// Omitted provider fields preserve the last committed value. Explicit empty
/// lists clear that offering. Observed values do not change desired preferences.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CataloguePatch {
    pub models: Option<Vec<ModelChoice>>,
    pub modes: Option<Vec<ModeChoice>>,
    pub commands: Option<Vec<AvailableCommand>>,
    pub selects: Option<Vec<SelectSetting>>,
    pub image_input: Option<bool>,
    pub current_model: Option<ModelId>,
    pub current_mode: Option<ModeId>,
}
impl Catalogue {
    pub fn apply(&mut self, patch: CataloguePatch) {
        if let Some(selects) = patch.selects {
            self.selects = selects;
        }
        if let Some(image_input) = patch.image_input {
            self.image_input = image_input;
        }
        if let Some(models) = patch.models {
            if models.is_empty() {
                self.current_model = None;
            }
            self.models = models;
        }
        if let Some(modes) = patch.modes {
            if modes.is_empty() {
                self.current_mode = None;
            }
            self.modes = modes;
        }
        if let Some(commands) = patch.commands {
            self.commands = commands;
        }
        if let Some(model) = patch.current_model {
            self.current_model = Some(model);
        }
        if let Some(mode) = patch.current_mode {
            self.current_mode = Some(mode);
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelChoice {
    pub id: ModelId,
    pub name: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModeChoice {
    pub id: ModeId,
    pub name: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AvailableCommand {
    pub name: String,
    pub description: String,
    pub input_hint: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelectSetting {
    pub id: String,
    pub name: String,
    pub category: Option<String>,
    pub current_value: String,
    pub choices: Vec<SelectChoice>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelectChoice {
    pub value: String,
    pub name: String,
}
impl SelectSetting {
    pub fn validate_all(settings: &[Self]) -> Result<(), super::error::DomainError> {
        let valid = |s: &str, limit: usize| {
            !s.is_empty() && s.len() <= limit && !s.chars().any(char::is_control)
        };
        let mut ids = std::collections::HashSet::new();
        if settings.len() > 32 {
            return Err(super::error::DomainError::Protocol(
                "too many provider settings".into(),
            ));
        }
        for setting in settings {
            let mut values = std::collections::HashSet::new();
            if !valid(&setting.id, 200)
                || !ids.insert(&setting.id)
                || !valid(&setting.name, 512)
                || setting.category.as_ref().is_some_and(|s| !valid(s, 200))
                || setting.choices.is_empty()
                || setting.choices.len() > 500
                || setting.choices.iter().any(|c| {
                    !valid(&c.value, 200) || !valid(&c.name, 512) || !values.insert(&c.value)
                })
                || !setting
                    .choices
                    .iter()
                    .any(|c| c.value == setting.current_value)
            {
                return Err(super::error::DomainError::Protocol(
                    "invalid provider select setting".into(),
                ));
            }
        }
        if serde_json::to_vec(settings)
            .map_err(|e| super::error::DomainError::Protocol(e.to_string()))?
            .len()
            > 128 * 1024
        {
            return Err(super::error::DomainError::Protocol(
                "provider settings budget exceeded".into(),
            ));
        }
        Ok(())
    }
}
