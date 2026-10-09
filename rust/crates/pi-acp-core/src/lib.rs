//! Shared building blocks for the Rust daemons.
//! Contracts: docs/service-protocol.md (wire frames) and docs/data-formats.md
//! (atomic writes, proper-lockfile-compatible mkdir locks). Do not drift.
pub mod acp;
pub mod atomic;
pub mod canonical;
pub mod error;
pub mod harness;
pub mod mkdir_lock;
pub mod protocol;
pub mod turn_event;
pub mod types;
pub mod usage;
pub mod utf16;
pub mod util;
pub mod wire;

pub mod panic_guard;
pub mod sync;
