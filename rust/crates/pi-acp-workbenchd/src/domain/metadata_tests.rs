use super::{
    command::{AgentEvent, DomainCommand},
    event::DomainEvent,
    ids::{Prompt, ProviderMessageId},
    reducer::apply,
    transcript::EntryRole,
};
#[test]
fn live_entry_and_opaque_group_metadata_matches_distinct_transcript_rows_without_merging_or_pixels()
{
    let mut state = super::tests::state();
    let session = state.id.clone();
    let mut events = apply(
        &mut state,
        DomainCommand::Prompt {
            session,
            prompt: Prompt::new("hello").unwrap(),
        },
    )
    .unwrap();
    let turn = state.active_turn.clone().unwrap();
    let group = ProviderMessageId::generate();
    let asset = super::image::ImageAsset::from_base64("image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=").unwrap();
    for event in [
        AgentEvent::Thought {
            turn: turn.clone(),
            text: "thought".into(),
            message: Some(group.clone()),
        },
        AgentEvent::Text {
            turn: turn.clone(),
            text: "he".into(),
            message: Some(group.clone()),
        },
        AgentEvent::Text {
            turn: turn.clone(),
            text: "llo".into(),
            message: Some(group.clone()),
        },
        AgentEvent::Image {
            turn,
            asset,
            message: Some(group.clone()),
        },
    ] {
        let session = state.id.clone();
        events.extend(apply(&mut state, DomainCommand::Agent { session, event }).unwrap());
    }
    let mut observed = std::collections::BTreeSet::new();
    for event in events {
        let wire = serde_json::to_string(&event).unwrap();
        assert!(!wire.contains("iVBOR") && !wire.contains("\"data\""));
        let event: DomainEvent = serde_json::from_str(&wire).unwrap();
        let (entry, message, text, role, image) = match event {
            DomainEvent::UserPromptAdded { entry, prompt, .. } => {
                (entry, None, prompt, EntryRole::User, None)
            }
            DomainEvent::AgentThought {
                entry,
                message,
                text,
                ..
            } => (entry, message, text, EntryRole::Thought, None),
            DomainEvent::AgentText {
                entry,
                message,
                text,
                ..
            } => (entry, message, text, EntryRole::Agent, None),
            DomainEvent::AgentImage {
                entry,
                message,
                image,
                ..
            } => (entry, message, String::new(), EntryRole::Agent, Some(image)),
            _ => continue,
        };
        let row = state
            .transcript
            .entries
            .iter()
            .find(|row| row.id == entry)
            .unwrap();
        assert!(observed.insert(entry));
        assert_eq!(row.message, message);
        assert_eq!(row.text, text);
        assert_eq!(row.role, role);
        assert_eq!(row.image, image);
        if role != EntryRole::User {
            assert_eq!(message, Some(group.clone()));
        }
    }
    assert_eq!(observed.len(), 5);
    assert_eq!(state.transcript.entries.len(), 5);
}
