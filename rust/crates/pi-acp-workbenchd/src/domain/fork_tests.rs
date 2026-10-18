use super::{
    fork::*,
    ids::*,
    session::SessionState,
    tool::{ToolCall, ToolStatus},
    transcript::{EntryRole, TranscriptEntry},
};
fn fixture() -> SessionState {
    let mut state = super::tests::state();
    state.provider_session = Some(ProviderSessionId::new("native-source").unwrap());
    for index in 0..2 {
        let turn = TurnId::generate();
        for (role, text) in [
            (EntryRole::User, format!("question-{index}")),
            (EntryRole::Agent, format!("answer-{index}")),
        ] {
            state.transcript.entries.push(TranscriptEntry {
                id: EntryId::generate(),
                turn: turn.clone(),
                role,
                text,
                message: None,
                image: None,
            });
        }
        let tool = ToolCall {
            id: ToolCallId::generate(),
            turn: turn.clone(),
            title: format!("tool-{index}"),
            status: ToolStatus::Completed,
            details: super::tool::ToolDetails {
                kind: Some(super::tool::ToolKind::Edit),
                content: vec![super::tool::ToolContent::Diff {
                    path: format!("/display/only-{index}"),
                    old_text: None,
                    new_text: format!("tool-{index}"),
                }],
                ..Default::default()
            },
        };
        state
            .transcript
            .tools
            .entry(turn)
            .or_default()
            .insert(tool.id.clone(), tool);
    }
    state.config.model = Some(ModelId::new("source-current-model").unwrap());
    state.config.mode = Some(ModeId::new("source-current-mode").unwrap());
    state.revision = 99;
    state
}
fn candidate(entry: &TranscriptEntry) -> ForkCandidate {
    ForkCandidate {
        target: ForkTarget {
            entry: ProviderEntryId::new("native-node").unwrap(),
            prefix: PrefixHash::new("a".repeat(64)).unwrap(),
        },
        role: match entry.role {
            EntryRole::User => ForkRole::User,
            _ => ForkRole::Agent,
        },
        text: ContentHash::of(&entry.text),
        safe: true,
    }
}
#[test]
fn fork_projection_is_an_independent_prefix_without_current_settings_or_future_tools() {
    let state = fixture();
    let before = serde_json::to_vec(&state).unwrap();
    let entry = &state.transcript.entries[2];
    let projection = prepare(
        &state,
        &ForkRequest {
            entry: entry.id.clone(),
        },
        &[candidate(entry)],
    )
    .unwrap();
    assert_eq!(serde_json::to_vec(&state).unwrap(), before);
    assert_ne!(projection.snapshot.id, state.id);
    assert_eq!(projection.snapshot.transcript.entries.len(), 3);
    assert_eq!(projection.snapshot.transcript.tools.len(), 1);
    let retained = projection
        .snapshot
        .transcript
        .tools
        .values()
        .next()
        .unwrap()
        .values()
        .next()
        .unwrap();
    assert!(
        matches!(&retained.details.content[0], super::tool::ToolContent::Diff { new_text, .. } if new_text == "tool-0")
    );
    assert!(!projection
        .snapshot
        .transcript
        .tools
        .contains_key(&entry.turn));
    assert!(
        projection.snapshot.config.model.is_none() && projection.snapshot.config.mode.is_none()
    );
    assert!(projection.snapshot.provider_session.is_none());
    assert_eq!(projection.snapshot.revision, 0);
    let origin = projection.snapshot.transcript.origin.as_ref().unwrap();
    assert_eq!(origin.session, state.id);
    assert_eq!(origin.entry, entry.id);
    assert!(projection
        .clone()
        .adopt(state.provider_session.clone().unwrap())
        .is_err());
    let adopted = projection
        .adopt(ProviderSessionId::new("independent-native").unwrap())
        .unwrap();
    assert_eq!(
        adopted.provider_session.as_ref().unwrap().as_str(),
        "independent-native"
    );
    assert_eq!(adopted.transcript.entries.len(), 3);
    assert!(adopted.active_turn.is_none() && adopted.pending_interactions.is_empty());
}
#[test]
fn fork_rejects_busy_unknown_unsafe_and_duplicate_points_without_mutation() {
    let mut state = fixture();
    let entry = state.transcript.entries[0].clone();
    let request = ForkRequest {
        entry: entry.id.clone(),
    };
    let valid = candidate(&entry);
    let before = serde_json::to_vec(&state).unwrap();
    assert!(prepare(&state, &request, &[]).is_err());
    assert!(prepare(&state, &request, &[valid.clone(), valid.clone()]).is_err());
    let mut unsafe_candidate = valid.clone();
    unsafe_candidate.safe = false;
    assert!(prepare(&state, &request, &[unsafe_candidate]).is_err());
    assert!(prepare(
        &state,
        &ForkRequest {
            entry: EntryId::generate()
        },
        std::slice::from_ref(&valid)
    )
    .is_err());
    assert_eq!(serde_json::to_vec(&state).unwrap(), before);
    state.active_turn = Some(TurnId::generate());
    assert!(matches!(
        prepare(&state, &request, std::slice::from_ref(&valid)),
        Err(super::error::DomainError::Busy)
    ));
    state.active_turn = None;
    state.configuration_intent = Some(super::session::ConfigurationIntent {
        requested: state.config.clone(),
        restore: state.config.clone(),
    });
    assert!(matches!(
        prepare(&state, &request, std::slice::from_ref(&valid)),
        Err(super::error::DomainError::Busy)
    ));
    state.configuration_intent = None;
    let mut repeated = entry.clone();
    repeated.id = EntryId::generate();
    state.transcript.entries.push(repeated);
    assert!(prepare(&state, &request, &[valid]).is_err());
}
#[test]
fn partial_assistant_chunks_and_non_message_entries_never_guess_native_positions() {
    let mut state = fixture();
    let entry = state.transcript.entries[1].clone();
    let request = ForkRequest {
        entry: entry.id.clone(),
    };
    assert!(prepare(&state, &request, &[candidate(&entry)]).is_ok());
    let mut chunk = entry.clone();
    chunk.id = EntryId::generate();
    chunk.text = "remaining chunk".into();
    state.transcript.entries.insert(2, chunk);
    assert!(prepare(&state, &request, &[candidate(&entry)]).is_err());
    state.transcript.entries[1].role = EntryRole::Thought;
    assert!(prepare(&state, &request, &[candidate(&entry)]).is_err());
}
#[test]
fn opaque_stream_groups_match_only_whole_messages_and_keep_delta_ids_immutable() {
    let mut state = fixture();
    let original = state.transcript.entries.pop().unwrap();
    let valid = candidate(&original);
    let message = ProviderMessageId::generate();
    for (role, text) in [
        (EntryRole::Thought, "reasoning"),
        (EntryRole::Agent, "ans"),
        (EntryRole::Agent, "wer-1"),
    ] {
        state.transcript.entries.push(TranscriptEntry {
            id: EntryId::generate(),
            turn: original.turn.clone(),
            role,
            text: text.into(),
            message: Some(message.clone()),
            image: None,
        });
    }
    let early = state.transcript.entries[4].id.clone();
    let last = state.transcript.entries[5].id.clone();
    state.transcript.entries.push(TranscriptEntry {
        id: EntryId::generate(),
        turn: original.turn.clone(),
        role: EntryRole::Agent,
        text: "future answer".into(),
        message: Some(ProviderMessageId::generate()),
        image: None,
    });
    let before = serde_json::to_vec(&state).unwrap();
    assert!(prepare(
        &state,
        &ForkRequest { entry: early },
        std::slice::from_ref(&valid)
    )
    .is_err());
    let projection = prepare(
        &state,
        &ForkRequest {
            entry: last.clone(),
        },
        std::slice::from_ref(&valid),
    )
    .unwrap();
    assert_eq!(projection.snapshot.transcript.entries.len(), 6);
    assert_eq!(projection.snapshot.transcript.entries[5].id, last);
    assert_eq!(
        serde_json::to_vec(&projection.snapshot.transcript.entries).unwrap(),
        serde_json::to_vec(&state.transcript.entries[..6]).unwrap()
    );
    assert_eq!(serde_json::to_vec(&state).unwrap(), before);
    let mut partial_native = valid;
    partial_native.text = ContentHash::of("wer-1");
    assert!(prepare(&state, &ForkRequest { entry: last }, &[partial_native]).is_err());
}

#[test]
fn stream_group_reuse_interleaving_unknown_boundaries_and_equal_full_messages_fail_closed() {
    let base = fixture();
    let valid = candidate(&base.transcript.entries[3]);
    for shape in ["missing", "interleaved", "duplicate", "trailing-thought"] {
        let mut state = base.clone();
        let original = state.transcript.entries.pop().unwrap();
        let message = ProviderMessageId::generate();
        let mut add = |text: &str, id: Option<ProviderMessageId>, role| {
            let id_entry = EntryId::generate();
            state.transcript.entries.push(TranscriptEntry {
                id: id_entry.clone(),
                turn: original.turn.clone(),
                role,
                text: text.into(),
                message: id,
                image: None,
            });
            id_entry
        };
        add("ans", Some(message.clone()), EntryRole::Agent);
        if shape == "interleaved" {
            add(
                "another message",
                Some(ProviderMessageId::generate()),
                EntryRole::Agent,
            );
        }
        let last = add(
            "wer-1",
            if shape == "missing" {
                None
            } else {
                Some(message.clone())
            },
            EntryRole::Agent,
        );
        if shape == "duplicate" {
            add(
                "answer-1",
                Some(ProviderMessageId::generate()),
                EntryRole::Agent,
            );
        }
        if shape == "trailing-thought" {
            add(
                "not a visible terminal text row",
                Some(message),
                EntryRole::Thought,
            );
        }
        assert!(
            prepare(
                &state,
                &ForkRequest { entry: last },
                std::slice::from_ref(&valid)
            )
            .is_err(),
            "{shape}"
        );
    }
    // Providers may reuse stream IDs on a new turn. Never merge across turns.
    let mut state = base;
    let id = ProviderMessageId::new("reused-stream-id").unwrap();
    state.transcript.entries[1].message = Some(id.clone());
    state.transcript.entries[3].message = Some(id);
    assert!(prepare(
        &state,
        &ForkRequest {
            entry: state.transcript.entries[3].id.clone()
        },
        &[valid]
    )
    .is_ok());
}

#[test]
fn text_only_native_keys_never_authorize_an_image_bearing_message_cut() {
    let mut state = fixture();
    let original = state.transcript.entries[3].clone();
    let valid = candidate(&original);
    let message = ProviderMessageId::generate();
    state.transcript.entries[3].message = Some(message.clone());
    let asset = super::image::ImageAsset::from_base64("image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=").unwrap();
    let image_entry = EntryId::generate();
    state.transcript.entries.push(TranscriptEntry {
        id: image_entry.clone(),
        turn: original.turn,
        role: EntryRole::Agent,
        text: String::new(),
        message: Some(message),
        image: Some(asset.image().clone()),
    });
    let before = serde_json::to_vec(&state).unwrap();
    for entry in [original.id, image_entry] {
        assert!(prepare(&state, &ForkRequest { entry }, std::slice::from_ref(&valid)).is_err());
    }
    assert_eq!(serde_json::to_vec(&state).unwrap(), before);
}
#[test]
fn digests_validate_constructor_and_serde_and_preserve_content_role_separation() {
    for bad in [
        "".to_owned(),
        "a".repeat(63),
        "a".repeat(65),
        "A".repeat(64),
        "g".repeat(64),
        format!("{}\n", "a".repeat(63)),
    ] {
        assert!(PrefixHash::new(&bad).is_err());
        assert!(
            serde_json::from_str::<ContentHash>(&serde_json::to_string(&bad).unwrap()).is_err()
        );
    }
    assert_eq!(
        ContentHash::of("hello").as_str(),
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
    let state = fixture();
    let entry = &state.transcript.entries[0];
    let mut wrong = candidate(entry);
    wrong.role = ForkRole::Agent;
    assert!(prepare(
        &state,
        &ForkRequest {
            entry: entry.id.clone()
        },
        &[wrong]
    )
    .is_err());
}
