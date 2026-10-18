use super::{
    admission::{admit_update, AdmissionPolicy},
    command::{RejectionReason, TelegramAction},
    state::InboxOutcome,
    types::*,
};
use crate::{
    domain::{
        interaction::{
            Interaction, InteractionAnswer, InteractionKind, InteractionOption, InteractionResponse,
        },
        session::SessionConfig,
        DeliveryId, Harness, InteractionId, SessionId, SessionSnapshot, SessionState,
        SessionStatus, WorkspacePath,
    },
    persistence::inbox::{AdmissionResult, TelegramStore},
};
use std::{collections::BTreeSet, path::PathBuf};
fn topic(thread: i64) -> TopicKey {
    TopicKey {
        chat: ChatId::new(-100).unwrap(),
        thread: Some(TopicId::new(thread).unwrap()),
    }
}
fn policy() -> AdmissionPolicy {
    AdmissionPolicy {
        chats: BTreeSet::from([ChatId::new(-100).unwrap()]),
        users: BTreeSet::from([UserId::new(5).unwrap()]),
        cwd: WorkspacePath::new("/tmp").unwrap(),
    }
}
fn snapshot() -> SessionSnapshot {
    SessionState {
        id: SessionId::generate(),
        provider_session: None,
        harness: Harness::Pi,
        cwd: WorkspacePath::new("/tmp").unwrap(),
        status: SessionStatus::Waiting,
        transcript: Default::default(),
        plan: Default::default(),
        active_turn: None,
        pending_interactions: Default::default(),
        usage: Default::default(),
        configuration_intent: None,
        config: SessionConfig {
            model: None,
            mode: None,
        },
        catalogue: Default::default(),
        revision: 1,
    }
    .snapshot()
}
fn interaction() -> Interaction {
    Interaction {
        id: InteractionId::generate(),
        kind: InteractionKind::Permission,
        title: "Permission".into(),
        detail: "Allow?".into(),
        fields: vec![],
        options: vec![InteractionOption {
            id: "yes".into(),
            label: "Yes".into(),
        }],
        expires_at: Some(100),
    }
}
fn incoming(id: u64, content: IncomingContent) -> IncomingUpdate {
    IncomingUpdate {
        id: UpdateId::new(id).unwrap(),
        topic: topic(1),
        sender: UserId::new(5).unwrap(),
        from_bot: false,
        forum: true,
        content,
    }
}
fn root() -> PathBuf {
    std::env::temp_dir().join(format!("workbench-inbox-{}", uuid::Uuid::new_v4()))
}
#[tokio::test]
async fn canonical_workspace_scope_rejects_symlink_escapes_and_existing_outside_sessions() {
    let root = root();
    let allowed = root.join("allowed");
    let outside = root.join("outside");
    tokio::fs::create_dir_all(&allowed).await.unwrap();
    tokio::fs::create_dir_all(&outside).await.unwrap();
    tokio::fs::symlink(&outside, allowed.join("escape"))
        .await
        .unwrap();
    let mut policy = policy();
    policy.cwd = WorkspacePath::new(allowed.to_str().unwrap()).unwrap();
    let store = TelegramStore::new(root.join("state.json"), 8);
    let mut snapshot = snapshot();
    snapshot.cwd = WorkspacePath::new(outside.to_str().unwrap()).unwrap();
    store.bind(topic(1), snapshot.id.clone()).await.unwrap();
    admit_update(
        &store,
        incoming(1, IncomingContent::Text("prompt".into())),
        Some(&snapshot),
        &policy,
        1,
    )
    .await
    .unwrap();
    admit_update(
        &store,
        incoming(
            2,
            IncomingContent::Text(format!("/new pi {}", allowed.join("escape").display())),
        ),
        Some(&snapshot),
        &policy,
        1,
    )
    .await
    .unwrap();
    assert!(store
        .pending(8)
        .await
        .unwrap()
        .iter()
        .all(|record| matches!(
            record.command.action,
            TelegramAction::Rejected(RejectionReason::WorkspaceForbidden)
        )));
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[test]
fn merged_telegram_config_rejects_plain_tokens_empty_authorization_and_remote_http() {
    use crate::config::Config;
    let original = serde_json::json!({"workers":{"pi":{"command":"node"}},"sessions":{},"storage":{"root":"/tmp/fixture-not-started"},"limits":{},"telegram":{"bot_token_env":"TOKEN_ENV","workspace":"/tmp","allowed_chat_ids":[-100]}});
    let mut raw_token = original.clone();
    raw_token["telegram"]["token"] = serde_json::json!("NOT_A_REAL_TOKEN");
    assert!(serde_json::from_value::<Config>(raw_token).is_err());
    let mut empty = original.clone();
    empty["telegram"]["allowed_chat_ids"] = serde_json::json!([]);
    assert!(serde_json::from_value::<Config>(empty)
        .unwrap()
        .validate()
        .is_err());
    let mut http = original;
    http["telegram"]["api_base"] = serde_json::json!("http://example.com/");
    assert!(serde_json::from_value::<Config>(http)
        .unwrap()
        .validate()
        .is_err());
}

#[test]
fn ambiguous_text_is_rejected_and_explicit_multifield_answers_are_typed() {
    use super::command::parse_text;
    use crate::domain::interaction::{FieldKind, FieldValue, InteractionField};
    let mut snapshot = snapshot();
    let first = interaction();
    let second = interaction();
    snapshot
        .pending_interactions
        .insert(first.id.clone(), first);
    snapshot
        .pending_interactions
        .insert(second.id.clone(), second);
    let cwd = WorkspacePath::new("/tmp").unwrap();
    assert!(matches!(
        parse_text(Some(&snapshot), "yes", &cwd, 1),
        Err(RejectionReason::AmbiguousAnswer)
    ));
    assert!(matches!(
        parse_text(Some(&snapshot), "/prompt explicit", &cwd, 1),
        Ok(TelegramAction::Prompt { .. })
    ));
    assert!(matches!(
        parse_text(Some(&snapshot), "/unknown", &cwd, 1),
        Err(RejectionReason::UnknownCommand)
    ));
    let form = Interaction {
        id: InteractionId::generate(),
        kind: InteractionKind::Elicitation,
        title: "Form".into(),
        detail: "".into(),
        options: vec![],
        expires_at: Some(100),
        fields: vec![
            InteractionField {
                name: "name".into(),
                label: "Name".into(),
                required: true,
                kind: FieldKind::Text { max_length: 100 },
            },
            InteractionField {
                name: "count".into(),
                label: "Count".into(),
                required: true,
                kind: FieldKind::Integer {
                    min: Some(1),
                    max: Some(10),
                },
            },
        ],
    };
    let id = form.id.clone();
    snapshot.pending_interactions.insert(id.clone(), form);
    let input = format!("/answer {id} {{\"Form\":{{\"fields\":{{\"name\":{{\"Text\":\"Ada\"}},\"count\":{{\"Integer\":2}}}}}}}}");
    let action = parse_text(Some(&snapshot), &input, &cwd, 1).unwrap();
    assert!(
        matches!(action, TelegramAction::Answer { answer: InteractionAnswer { response: InteractionResponse::Form { fields }, .. }, .. } if fields["count"] == FieldValue::Integer(2))
    );
}

#[test]
fn telegram_identifiers_validate_serde_and_canonical_topic_map_keys() {
    for invalid in ["\"0:root\"", "\"-100:0\"", "\"-100:01\"", "\"+5:root\""] {
        assert!(serde_json::from_str::<TopicKey>(invalid).is_err());
    }
    assert!(serde_json::from_str::<ChatId>("0").is_err());
    assert!(serde_json::from_str::<UserId>("-1").is_err());
    assert!(serde_json::from_str::<UpdateId>(&u64::MAX.to_string()).is_err());
    let topics = std::collections::BTreeMap::from([(topic(1), SessionId::generate())]);
    assert_eq!(
        serde_json::from_slice::<std::collections::BTreeMap<TopicKey, SessionId>>(
            &serde_json::to_vec(&topics).unwrap()
        )
        .unwrap(),
        topics
    );
}
#[tokio::test]
async fn admission_freezes_answer_binding_across_restart_and_never_reinterprets_as_prompt() {
    let root = root();
    let store = TelegramStore::new(root.join("state.json"), 8);
    let mut snapshot = snapshot();
    let requested = interaction();
    let original = requested.id.clone();
    snapshot
        .pending_interactions
        .insert(original.clone(), requested);
    store.bind(topic(1), snapshot.id.clone()).await.unwrap();
    assert_eq!(
        admit_update(
            &store,
            incoming(1, IncomingContent::Text("yes".into())),
            Some(&snapshot),
            &policy(),
            1
        )
        .await
        .unwrap(),
        AdmissionResult::Accepted
    );
    snapshot.pending_interactions.clear();
    let replacement = interaction();
    snapshot
        .pending_interactions
        .insert(replacement.id.clone(), replacement);
    let restarted = TelegramStore::new(root.join("state.json"), 8);
    let pending = restarted.pending(8).await.unwrap();
    assert!(
        matches!(&pending[0].command.action, TelegramAction::Answer { answer, .. } if answer.interaction == original)
    );
    assert_eq!(
        admit_update(
            &restarted,
            incoming(1, IncomingContent::Text("not reclassified".into())),
            Some(&snapshot),
            &policy(),
            2
        )
        .await
        .unwrap(),
        AdmissionResult::Duplicate
    );
    assert_eq!(restarted.snapshot().await.unwrap().offset, 2);
    restarted
        .complete(UpdateId::new(1).unwrap(), InboxOutcome::Applied)
        .await
        .unwrap();
    assert!(TelegramStore::new(root.join("state.json"), 8)
        .pending(8)
        .await
        .unwrap()
        .is_empty());
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn authorization_drops_unauthorized_users_chats_and_bots_without_storing_text() {
    let root = root();
    let store = TelegramStore::new(root.join("state.json"), 8);
    let mut user = incoming(1, IncomingContent::Text("private untrusted text".into()));
    user.sender = UserId::new(6).unwrap();
    let mut chat = incoming(2, IncomingContent::Text("private untrusted text".into()));
    chat.topic.chat = ChatId::new(-200).unwrap();
    let mut bot = incoming(3, IncomingContent::Text("private untrusted text".into()));
    bot.from_bot = true;
    for update in [user, chat, bot] {
        assert_eq!(
            admit_update(&store, update, None, &policy(), 1)
                .await
                .unwrap(),
            AdmissionResult::Ignored
        );
    }
    let state = store.snapshot().await.unwrap();
    assert_eq!(state.offset, 4);
    assert!(state.inbox.is_empty());
    assert!(
        !String::from_utf8(tokio::fs::read(root.join("state.json")).await.unwrap())
            .unwrap()
            .contains("private untrusted text")
    );
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn callback_wrong_topic_expiry_and_consumption_are_durable() {
    let root = root();
    let store = TelegramStore::new(root.join("state.json"), 16);
    let mut snapshot = snapshot();
    let interaction = interaction();
    snapshot
        .pending_interactions
        .insert(interaction.id.clone(), interaction.clone());
    store.bind(topic(1), snapshot.id.clone()).await.unwrap();
    let key = CallbackKey::for_option(&DeliveryId::generate(), 0);
    store
        .register_callback(
            key.clone(),
            CallbackBinding {
                topic: topic(1),
                session: snapshot.id.clone(),
                answer: InteractionAnswer {
                    interaction: interaction.id,
                    response: InteractionResponse::Permission {
                        option: "yes".into(),
                    },
                },
                expires_at: 50,
                used_by: None,
            },
        )
        .await
        .unwrap();
    let callback = || IncomingContent::Callback {
        key: key.clone(),
        query: "query".into(),
    };
    let mut wrong_topic = incoming(1, callback());
    wrong_topic.topic = topic(2);
    admit_update(&store, wrong_topic, None, &policy(), 1)
        .await
        .unwrap();
    assert!(matches!(
        &store.pending(16).await.unwrap()[0].command.action,
        TelegramAction::Rejected(RejectionReason::WrongTopic)
    ));
    admit_update(
        &store,
        incoming(2, callback()),
        Some(&snapshot),
        &policy(),
        50,
    )
    .await
    .unwrap();
    assert!(matches!(
        &store.pending(16).await.unwrap()[1].command.action,
        TelegramAction::Rejected(RejectionReason::ExpiredInteraction)
    ));
    admit_update(
        &store,
        incoming(3, callback()),
        Some(&snapshot),
        &policy(),
        2,
    )
    .await
    .unwrap();
    let restarted = TelegramStore::new(root.join("state.json"), 16);
    assert_eq!(
        restarted.snapshot().await.unwrap().callbacks[&key].used_by,
        Some(UpdateId::new(3).unwrap())
    );
    admit_update(
        &restarted,
        incoming(4, callback()),
        Some(&snapshot),
        &policy(),
        3,
    )
    .await
    .unwrap();
    assert!(matches!(
        &restarted.pending(16).await.unwrap()[3].command.action,
        TelegramAction::Rejected(RejectionReason::AlreadyUsed)
    ));
    assert_eq!(
        restarted
            .pending(16)
            .await
            .unwrap()
            .iter()
            .filter(|record| matches!(record.command.action, TelegramAction::Answer { .. }))
            .count(),
        1
    );
    // Explicit GC cannot remove an expired callback still owned by a Pending
    // answer. In particular it may not break read()'s durable receipt check.
    assert_eq!(restarted.compact(100).await.unwrap(), (0, 0));
    restarted
        .complete(UpdateId::new(3).unwrap(), InboxOutcome::Applied)
        .await
        .unwrap();
    // Even after execution, retain an unexpired consumed key: a delayed click
    // must not become a newly usable answer after rendering/restart.
    assert_eq!(restarted.compact(3).await.unwrap(), (1, 0));
    assert_eq!(
        restarted.snapshot().await.unwrap().callbacks[&key].used_by,
        Some(UpdateId::new(3).unwrap())
    );
    assert_eq!(restarted.compact(100).await.unwrap(), (0, 1));
    let compacted = TelegramStore::new(root.join("state.json"), 16);
    assert_eq!(compacted.snapshot().await.unwrap().offset, 5);
    assert_eq!(compacted.pending(16).await.unwrap().len(), 3);
    assert_eq!(
        admit_update(
            &compacted,
            incoming(3, callback()),
            Some(&snapshot),
            &policy(),
            100
        )
        .await
        .unwrap(),
        AdmissionResult::Duplicate
    );
    assert_eq!(compacted.pending(16).await.unwrap().len(), 3);
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn full_inbox_and_failed_writes_do_not_advance_offset_or_consume_callback() {
    let root = root();
    let store = TelegramStore::new(root.join("state.json"), 1);
    let snapshot = snapshot();
    store.bind(topic(1), snapshot.id.clone()).await.unwrap();
    admit_update(
        &store,
        incoming(1, IncomingContent::Text("first".into())),
        Some(&snapshot),
        &policy(),
        1,
    )
    .await
    .unwrap();
    assert!(admit_update(
        &store,
        incoming(2, IncomingContent::Text("second".into())),
        Some(&snapshot),
        &policy(),
        1
    )
    .await
    .is_err());
    assert_eq!(store.snapshot().await.unwrap().offset, 2);
    store
        .complete(UpdateId::new(1).unwrap(), InboxOutcome::Applied)
        .await
        .unwrap();
    let backup = root.with_extension("backup");
    tokio::fs::rename(&root, &backup).await.unwrap();
    tokio::fs::write(&root, b"not a directory").await.unwrap();
    assert!(admit_update(
        &store,
        incoming(2, IncomingContent::Text("second".into())),
        Some(&snapshot),
        &policy(),
        1
    )
    .await
    .is_err());
    tokio::fs::remove_file(&root).await.unwrap();
    tokio::fs::rename(&backup, &root).await.unwrap();
    assert_eq!(store.snapshot().await.unwrap().offset, 2);
    assert!(store.pending(8).await.unwrap().is_empty());
    let committed = tokio::fs::read(root.join("state.json")).await.unwrap();
    tokio::fs::rename(&root, &backup).await.unwrap();
    tokio::fs::write(&root, b"blocked GC storage")
        .await
        .unwrap();
    assert!(store.compact(100).await.is_err());
    tokio::fs::remove_file(&root).await.unwrap();
    tokio::fs::rename(&backup, &root).await.unwrap();
    assert_eq!(
        tokio::fs::read(root.join("state.json")).await.unwrap(),
        committed
    );
    assert_eq!(store.compact(100).await.unwrap(), (1, 0));
    assert_eq!(store.snapshot().await.unwrap().offset, 2);
    assert_eq!(store.compact(100).await.unwrap(), (0, 0));
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn bot_identity_and_corrupt_state_fail_closed() {
    let root = root();
    let store = TelegramStore::new(root.join("state.json"), 8);
    store.claim_bot(UserId::new(1).unwrap()).await.unwrap();
    assert!(store.claim_bot(UserId::new(2).unwrap()).await.is_err());
    tokio::fs::write(root.join("state.json"), b"{truncated")
        .await
        .unwrap();
    assert!(store.pending(8).await.is_err());
    assert!(admit_update(
        &store,
        incoming(1, IncomingContent::Text("/new".into())),
        None,
        &policy(),
        1
    )
    .await
    .is_err());
    tokio::fs::remove_dir_all(root).await.unwrap();
}
