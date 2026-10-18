use super::*;
use crate::domain::{
    event::DomainEvent,
    ids::{EntryId, TurnId},
    session::SessionConfig,
    transcript::{EntryRole, TranscriptEntry},
    Harness, SessionId, SessionState, SessionStatus, WorkspacePath,
};
fn root() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("workbench-projection-{}", uuid::Uuid::new_v4()))
}
fn state() -> SessionState {
    SessionState {
        id: SessionId::generate(),
        provider_session: None,
        harness: Harness::Pi,
        cwd: WorkspacePath::new("/tmp").unwrap(),
        status: SessionStatus::Idle,
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
}
#[tokio::test]
async fn stale_or_conflicting_history_revision_cannot_overwrite_state_or_create_invalid_delivery_ledger(
) {
    let root = root();
    let store = HistoryStore::fixture(&root);
    let mut state = state();
    store.save(&state).await.unwrap();
    let stale = state.clone();
    finish(&store, &mut state, "committed").await;
    assert!(store.save(&stale).await.is_err());
    let mut conflict = state.clone();
    conflict.status = SessionStatus::Failed("same revision, different state".into());
    assert!(store.save(&conflict).await.is_err());
    store.save(&state).await.unwrap();
    let loaded = store.load(state.id.as_str()).await.unwrap().unwrap();
    assert_eq!(loaded.revision, state.revision);
    assert!(matches!(loaded.status, SessionStatus::Idle));
    assert_eq!(loaded.transcript.entries.len(), 1);
    store.project_outbox().await.unwrap();
    assert_eq!(store.outbox.pending(0, 10).await.unwrap().len(), 1);
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn workspace_identity_is_immutable_and_its_delivery_scope_is_validated_even_with_a_matching_checksum(
) {
    let root = root();
    let store = HistoryStore::fixture(&root);
    let mut state = state();
    finish(&store, &mut state, "scoped output").await;
    let path = root.join(format!("{}.json", state.id));
    let before = tokio::fs::read(&path).await.unwrap();
    let mut moved = state.clone();
    moved.cwd = WorkspacePath::new("/").unwrap();
    moved.revision += 1;
    assert_eq!(
        store.save(&moved).await.unwrap_err(),
        "history workspace identity changed"
    );
    assert_eq!(tokio::fs::read(&path).await.unwrap(), before);
    let mut snapshot: history::HistorySnapshot = serde_json::from_slice(&before).unwrap();
    for event in snapshot.delivery_events.values_mut() {
        event.target = outbox::DeliveryTarget::Session {
            session: state.id.clone(),
            cwd: WorkspacePath::new("/").unwrap(),
        };
    }
    snapshot.checksum = history::checksum(&snapshot.session, &snapshot.delivery_events).unwrap();
    tokio::fs::write(&path, serde_json::to_vec(&snapshot).unwrap())
        .await
        .unwrap();
    assert_eq!(
        store.load(state.id.as_str()).await.unwrap_err(),
        "history delivery identity mismatch"
    );
    tokio::fs::remove_dir_all(root).await.unwrap();
}
async fn finish(store: &HistoryStore, state: &mut SessionState, text: &str) -> EntryId {
    let turn = TurnId::generate();
    let entry = EntryId::generate();
    state.transcript.entries.push(TranscriptEntry {
        id: entry.clone(),
        turn: turn.clone(),
        role: EntryRole::Agent,
        text: text.into(),
        message: None,
        image: None,
    });
    state.revision += 1;
    store
        .commit(
            state,
            &[DomainEvent::TurnFinished {
                session: state.id.clone(),
                turn,
            }],
        )
        .await
        .unwrap();
    entry
}
#[tokio::test]
async fn history_commit_before_outbox_projection_recovers_and_archive_survives_session_removal() {
    let root = root();
    let store = HistoryStore::fixture(&root);
    let mut state = state();
    let entry = finish(&store, &mut state, "你好 immutable output").await;
    assert!(store.outbox.pending(0, 16).await.unwrap().is_empty()); // crash before projection
    store.payloads.shutdown().await;
    let restarted = HistoryStore::fixture(&root);
    restarted.project_outbox().await.unwrap();
    let deliveries = restarted.outbox.pending(0, 16).await.unwrap();
    assert_eq!(deliveries.len(), 1);
    assert!(
        matches!(&deliveries[0].event.payload, outbox::DeliveryPayload::SessionCompleted { entries, .. } if entries == &vec![entry.clone()])
    );
    restarted.remove(state.id.as_str()).await.unwrap();
    assert_eq!(
        restarted.payloads.entry(&entry).await.unwrap().text,
        "你好 immutable output"
    );
    assert!(restarted.load(state.id.as_str()).await.unwrap().is_none());
    assert_eq!(restarted.outbox.pending(0, 16).await.unwrap().len(), 1);
    restarted.outbox.ack(&deliveries[0].event.id).await.unwrap();
    restarted.payloads.shutdown().await;
    let reopened = HistoryStore::fixture(&root);
    assert!(reopened.outbox.pending(0, 16).await.unwrap().is_empty());
    reopened.payloads.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn projection_replay_preserves_durable_ack_and_capacity_defers_without_losing_history() {
    let root = root();
    let defaults = HistoryStore::fixture(&root);
    let store = HistoryStore::with_delivery(
        root.join("history"),
        outbox::OutboxStore::new(root.join("outbox"), 1),
        defaults.payloads.clone(),
    );
    let mut state = state();
    finish(&store, &mut state, "first").await;
    finish(&store, &mut state, "second").await;
    store.project_outbox().await.unwrap();
    assert_eq!(store.outbox.pending(0, 16).await.unwrap().len(), 1);
    assert!(store.remove(state.id.as_str()).await.is_err());
    assert!(store.load(state.id.as_str()).await.unwrap().is_some());
    let pending = store.outbox.pending(0, 16).await.unwrap();
    store.outbox.ack(&pending[0].event.id).await.unwrap();
    store.project_outbox().await.unwrap();
    let second = store.outbox.pending(0, 16).await.unwrap();
    assert_eq!(second.len(), 1);
    assert_ne!(pending[0].event.id, second[0].event.id);
    store.project_outbox().await.unwrap();
    assert_eq!(store.outbox.pending(0, 16).await.unwrap().len(), 1);
    store.remove(state.id.as_str()).await.unwrap();
    assert!(store.load(state.id.as_str()).await.unwrap().is_none());
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn immutable_payload_conflict_and_tampered_projection_do_not_silently_replace_records() {
    let root = root();
    let store = HistoryStore::fixture(&root);
    let mut state = state();
    let entry = finish(&store, &mut state, "original").await;
    let mut altered = state.transcript.entries[0].clone();
    altered.text = "changed".into();
    assert!(store.payloads.put_entry(&altered).await.is_err());
    assert_eq!(store.payloads.entry(&entry).await.unwrap().text, "original");
    let path = root.join(format!("{}.json", state.id));
    let mut snapshot: HistorySnapshot =
        serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
    snapshot.delivery_events.clear();
    tokio::fs::write(&path, serde_json::to_vec(&snapshot).unwrap())
        .await
        .unwrap();
    assert!(store.project_outbox().await.is_err());
    assert!(store.load(state.id.as_str()).await.is_err());
    tokio::fs::remove_dir_all(root).await.unwrap();
}
