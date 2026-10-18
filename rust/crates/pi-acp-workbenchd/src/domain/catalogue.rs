use super::ids::{ModeId, ModelId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct Catalogue {
    pub models: Vec<ModelChoice>,
    pub modes: Vec<ModeChoice>,
    pub commands: Vec<AvailableCommand>,
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
    pub current_model: Option<ModelId>,
    pub current_mode: Option<ModeId>,
}
impl Catalogue {
    pub fn apply(&mut self, patch: CataloguePatch) {
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
