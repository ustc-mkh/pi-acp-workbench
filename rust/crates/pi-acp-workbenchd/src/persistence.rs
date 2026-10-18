pub const FORMAT_VERSION: u32 = 2;
pub mod format;
mod history;
pub mod inbox;
pub mod interface;
mod io;
pub mod journal;
pub mod maintenance;
pub mod outbox;
pub mod payload;
pub mod telegram_effect;
pub use history::{HistorySnapshot, HistoryStore};

#[cfg(test)]
fn checksum(state: &crate::domain::SessionState) -> Result<String, serde_json::Error> {
    history::checksum(state, &Default::default())
}
#[cfg(test)]
mod delivery_tests;
#[cfg(test)]
#[path = "persistence_tests.rs"]
mod history_tests;
#[cfg(test)]
mod image_tests;
