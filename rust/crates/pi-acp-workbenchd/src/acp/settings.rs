use super::dto::NativeSessionId;
use crate::domain::{
    catalogue::*,
    error::DomainError,
    ids::{ModeId, ModelId},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetails {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_options: Option<Vec<ConfigOption>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modes: Option<ModeState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<ModelState>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ConfigOption {
    #[serde(rename = "select", rename_all = "camelCase")]
    Select {
        id: String,
        name: String,
        #[serde(default)]
        category: Option<String>,
        current_value: String,
        options: SelectOptions,
    },
    #[serde(other)]
    Unknown,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SelectOptions {
    Flat(Vec<SelectOption>),
    Groups(Vec<SelectGroup>),
}
impl SelectOptions {
    pub fn values(&self) -> Vec<&SelectOption> {
        match self {
            Self::Flat(options) => options.iter().collect(),
            Self::Groups(groups) => groups
                .iter()
                .flat_map(|group| group.options.iter())
                .collect(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SelectOption {
    pub value: String,
    pub name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SelectGroup {
    pub group: String,
    pub name: String,
    pub options: Vec<SelectOption>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeState {
    pub current_mode_id: String,
    pub available_modes: Vec<ModeInfo>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModeInfo {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelState {
    pub current_model_id: String,
    pub available_models: Vec<ModelInfo>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub model_id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetConfigRequest {
    pub session_id: NativeSessionId,
    pub config_id: String,
    pub value: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetConfigResponse {
    pub config_options: Vec<ConfigOption>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetModeRequest {
    pub session_id: NativeSessionId,
    pub mode_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetModelRequest {
    pub session_id: NativeSessionId,
    pub model_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EmptyResponse {}

impl SessionDetails {
    pub fn select(&self, category: &str) -> Option<(&str, &str, &SelectOptions)> {
        self.config_options
            .as_ref()?
            .iter()
            .find_map(|option| match option {
                ConfigOption::Select {
                    id,
                    category: candidate,
                    current_value,
                    options,
                    ..
                } if candidate.as_deref() == Some(category) || id == category => {
                    Some((id.as_str(), current_value.as_str(), options))
                }
                _ => None,
            })
    }
    pub fn observe_mode(&mut self, mode: &ModeId) {
        if let Some(modes) = &mut self.modes {
            modes.current_mode_id = mode.as_str().to_owned();
        }
        if let Some(options) = &mut self.config_options {
            for option in options {
                if let ConfigOption::Select {
                    id,
                    category,
                    current_value,
                    ..
                } = option
                {
                    if category.as_deref() == Some("mode") || id == "mode" {
                        *current_value = mode.as_str().to_owned();
                    }
                }
            }
        }
    }
    pub fn catalogue_patch(&self) -> Result<CataloguePatch, DomainError> {
        let models = if let Some((_, _, options)) = self.select("model") {
            Some(
                options
                    .values()
                    .into_iter()
                    .map(|option| {
                        Ok(ModelChoice {
                            id: ModelId::new(&option.value)?,
                            name: option.name.clone(),
                        })
                    })
                    .collect::<Result<Vec<_>, DomainError>>()?,
            )
        } else if let Some(models) = &self.models {
            Some(
                models
                    .available_models
                    .iter()
                    .map(|model| {
                        Ok(ModelChoice {
                            id: ModelId::new(&model.model_id)?,
                            name: model.name.clone(),
                        })
                    })
                    .collect::<Result<Vec<_>, DomainError>>()?,
            )
        } else {
            self.config_options.as_ref().map(|_| vec![])
        };
        let modes = if let Some((_, _, options)) = self.select("mode") {
            Some(
                options
                    .values()
                    .into_iter()
                    .map(|option| {
                        Ok(ModeChoice {
                            id: ModeId::new(&option.value)?,
                            name: option.name.clone(),
                        })
                    })
                    .collect::<Result<Vec<_>, DomainError>>()?,
            )
        } else if let Some(modes) = &self.modes {
            Some(
                modes
                    .available_modes
                    .iter()
                    .map(|mode| {
                        Ok(ModeChoice {
                            id: ModeId::new(&mode.id)?,
                            name: mode.name.clone(),
                        })
                    })
                    .collect::<Result<Vec<_>, DomainError>>()?,
            )
        } else {
            self.config_options.as_ref().map(|_| vec![])
        };
        let current_model = self
            .select("model")
            .map(|(_, current, _)| current)
            .or_else(|| {
                self.models
                    .as_ref()
                    .map(|state| state.current_model_id.as_str())
            })
            .map(ModelId::new)
            .transpose()?;
        let current_mode = self
            .select("mode")
            .map(|(_, current, _)| current)
            .or_else(|| {
                self.modes
                    .as_ref()
                    .map(|state| state.current_mode_id.as_str())
            })
            .map(ModeId::new)
            .transpose()?;
        let selects = self.config_options.as_ref().map(|options| {
            options
                .iter()
                .filter_map(|option| match option {
                    ConfigOption::Select {
                        id,
                        name,
                        category,
                        current_value,
                        options,
                    } => Some(SelectSetting {
                        id: id.clone(),
                        name: name.clone(),
                        category: category.clone(),
                        current_value: current_value.clone(),
                        choices: options
                            .values()
                            .iter()
                            .map(|c| SelectChoice {
                                value: c.value.clone(),
                                name: c.name.clone(),
                            })
                            .collect(),
                    }),
                    ConfigOption::Unknown => None,
                })
                .collect::<Vec<_>>()
        });
        if let Some(selects) = &selects {
            SelectSetting::validate_all(selects)?;
        }
        Ok(CataloguePatch {
            selects,
            image_input: None,
            models,
            modes,
            commands: None,
            current_model,
            current_mode,
        })
    }
}
