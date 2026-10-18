use super::*;

fn config() -> Config {
    serde_json::from_str(r#"{"workers":{"pi":{"command":"node"}},"sessions":{},"storage":{"root":"/tmp/fixture-not-started"},"limits":{}}"#).unwrap()
}
#[test]
fn only_explicit_harnesses_are_enabled_and_unknown_or_singleton_launch_formats_are_rejected() {
    let config = config();
    assert!(config.validate().is_ok());
    assert!(config.workers.get(&crate::domain::Harness::Pi).is_some());
    assert!(config.workers.get(&crate::domain::Harness::Codex).is_none());
    assert!(serde_json::from_str::<WorkersConfig>(r#"{"command":"node","args":[]}"#).is_err());
    assert!(serde_json::from_str::<WorkersConfig>(r#"{"unknown":{"command":"node"}}"#).is_err());
    assert!(serde_json::from_str::<WorkersConfig>(
        r#"{"pi":{"command":"node","token":"fixture-only"}}"#
    )
    .is_err());
}
#[test]
fn empty_or_invalid_launches_and_unbounded_runtime_limits_fail_before_startup() {
    let mut config = config();
    config.workers.pi = None;
    assert!(config.validate().is_err());
    for command in ["", "   ", "node\0bad"] {
        let mut config = self::config();
        config.workers.pi.as_mut().unwrap().command = command.into();
        assert!(config.validate().is_err());
    }
    let mut config = self::config();
    config
        .workers
        .pi
        .as_mut()
        .unwrap()
        .env
        .insert("A=B".into(), "value".into());
    assert!(config.validate().is_err());
    let mut config = self::config();
    config
        .workers
        .pi
        .as_mut()
        .unwrap()
        .args
        .push("nul\0arg".into());
    assert!(config.validate().is_err());
    let mut config = self::config();
    config.sessions.max_workers = usize::MAX;
    assert!(config.validate().is_err());
    let mut config = self::config();
    config.limits.pending_interactions = 33;
    assert!(config.validate().is_err());
}
