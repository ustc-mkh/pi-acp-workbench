pub const FORMAT_VERSION: u32 = 3;
mod commit;
mod content;
pub mod database;
pub mod delivery;
#[cfg(test)]
mod delivery_sql_tests;
pub mod format;
#[cfg(test)]
#[path = "persistence_tests.rs"]
mod history_tests;
pub mod inbox;
pub mod interface;
pub mod journal;
pub mod maintenance;
pub mod outbox;
pub mod payload;
mod query;
mod schema;
mod session;
mod session_state;
#[cfg(test)]
mod session_state_tests;
pub mod telegram_effect;
mod telegram_sql;
#[cfg(test)]
mod telegram_sql_tests;
pub use session::SessionStore;

#[cfg(test)]
mod delivery_tests;
#[cfg(test)]
mod image_tests;
#[cfg(test)]
mod sqlite_tests;
