//! Pure, bounded transitions. Only the session owner commits their write set.
#[path = "reducer_transition.rs"]
mod incremental;
pub use incremental::{transition, TransitionContext};
fn validate_observed(
    config: &super::session::SessionConfig,
    model: Option<&super::ModelId>,
    mode: Option<&super::ModeId>,
) -> Result<(), super::error::DomainError> {
    if config
        .model
        .as_ref()
        .is_some_and(|expected| model != Some(expected))
        || config
            .mode
            .as_ref()
            .is_some_and(|expected| mode != Some(expected))
    {
        return Err(super::error::DomainError::Protocol(
            "provider did not confirm requested settings".into(),
        ));
    }
    Ok(())
}
