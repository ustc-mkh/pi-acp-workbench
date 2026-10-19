use super::{
    command::{AgentEvent, DomainCommand},
    ids::{Prompt, ProviderMessageId},
    tests::apply,
    transcript::EntryRole,
};
#[test]
fn live_headers_match_distinct_immutable_write_rows_without_merging_or_pixels() {
    let mut state = super::tests::state();
    let session = state.id.clone();
    let mut changes = vec![apply(
        &mut state,
        DomainCommand::Prompt {
            session,
            prompt: Prompt::new("hello").unwrap(),
        },
    )
    .unwrap()
    .unwrap()];
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
        changes.push(
            apply(&mut state, DomainCommand::Agent { session, event })
                .unwrap()
                .unwrap(),
        );
    }
    let mut observed = std::collections::BTreeSet::new();
    let mut seq = super::query::SafeInteger::new(0).unwrap();
    for change in changes {
        let batch = change.batch(seq).unwrap();
        let wire = serde_json::to_string(&batch).unwrap();
        assert!(!wire.contains("iVBOR") && !wire.contains("\"data\""));
        let batch: super::query::CommitBatch = serde_json::from_str(&wire).unwrap();
        assert_eq!(batch.entries.len(), change.append.len());
        for (header, row) in batch.entries.iter().zip(&change.append) {
            assert!(observed.insert(header.id.clone()));
            seq = seq.next().unwrap();
            assert_eq!(header.seq, seq);
            assert_eq!(header.id, row.id);
            assert_eq!(header.turn, row.turn);
            assert_eq!(header.message, row.message);
            assert_eq!(header.role, row.role);
            assert_eq!(
                header.image.as_ref(),
                row.image.as_ref().map(|image| image.image())
            );
            assert!(
                matches!(&header.text, super::query::TextBody::Inline { text } if text == &row.text.text)
            );
            if header.role != EntryRole::User {
                assert_eq!(header.message.as_ref(), Some(&group));
            }
        }
    }
    assert_eq!(observed.len(), 5);
    assert_eq!(state.last_entry_seq.get(), 5);
}
