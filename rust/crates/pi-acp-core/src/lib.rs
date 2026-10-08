//! Shared building blocks for the Rust daemons.
//! Contracts: docs/service-protocol.md (wire frames) and docs/data-formats.md
//! (atomic writes, proper-lockfile-compatible mkdir locks). Do not drift.
pub mod atomic;
pub mod canonical;
pub mod mkdir_lock;
pub mod turn_event;
pub mod utf16;
pub mod wire;
