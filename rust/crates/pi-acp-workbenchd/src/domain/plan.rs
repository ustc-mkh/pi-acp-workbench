use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Plan {
    pub items: Vec<PlanItem>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PlanItem {
    pub description: String,
    pub status: PlanStatus,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum PlanStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}
