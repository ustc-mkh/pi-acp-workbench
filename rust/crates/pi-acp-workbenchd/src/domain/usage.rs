use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct UsageState {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_micros: u64,
    #[serde(default)]
    pub context_used: Option<u64>,
    #[serde(default)]
    pub context_size: Option<u64>,
}
