use super::tests::state;
use super::{
    command::{AgentEvent, DomainCommand},
    reducer::apply,
    session::{ConfigurationIntent, SessionConfig},
    ModelId,
};

#[test]
fn configuration_intent_requires_known_baseline_and_observed_confirmation_before_commit_or_recovery(
) {
    let mut state = state();
    let id = state.id.clone();
    let requested = SessionConfig {
        model: Some(ModelId::new("other").unwrap()),
        mode: None,
    };
    let mut intent = ConfigurationIntent {
        requested: requested.clone(),
        restore: state.config.clone(),
    };
    assert!(apply(
        &mut state,
        DomainCommand::PrepareConfiguration {
            session: id.clone(),
            intent: intent.clone()
        }
    )
    .is_err());
    assert!(state.configuration_intent.is_none());
    intent.restore.model = Some(ModelId::new("default").unwrap());
    apply(
        &mut state,
        DomainCommand::PrepareConfiguration {
            session: id.clone(),
            intent,
        },
    )
    .unwrap();
    assert!(state.config.model.is_none());
    assert!(apply(
        &mut state,
        DomainCommand::CommitConfiguration {
            session: id.clone()
        }
    )
    .is_err());
    assert!(state.configuration_intent.is_some());
    assert!(apply(
        &mut state,
        DomainCommand::SetModel {
            session: id.clone(),
            model: ModelId::new("default").unwrap()
        }
    )
    .is_err());
    assert!(apply(
        &mut state,
        DomainCommand::Agent {
            session: id.clone(),
            event: AgentEvent::ConfigurationRestored(Default::default())
        }
    )
    .is_err());
    assert!(state.configuration_intent.is_some());
    let confirmed = super::catalogue::CataloguePatch {
        current_model: requested.model.clone(),
        ..Default::default()
    };
    apply(
        &mut state,
        DomainCommand::Agent {
            session: id.clone(),
            event: AgentEvent::Catalogue(confirmed),
        },
    )
    .unwrap();
    apply(
        &mut state,
        DomainCommand::CommitConfiguration { session: id },
    )
    .unwrap();
    assert_eq!(state.config, requested);
    assert!(state.configuration_intent.is_none());
}
