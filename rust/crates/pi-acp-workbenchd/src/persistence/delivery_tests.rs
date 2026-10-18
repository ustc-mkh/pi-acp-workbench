use super::*;
use crate::domain::{
    event::DomainEvent,
    ids::{EntryId, TurnId},
    session::SessionConfig,
    transcript::{EntryRole, TranscriptEntry},
    Harness, SessionId, SessionState, SessionStatus, WorkspacePath,
};
fn root() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("workbench-sql-session-{}", uuid::Uuid::new_v4()))
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
        revision: 0,
    }
}
async fn finish(store: &SessionStore, state: &mut SessionState, text: &str) -> EntryId {
    store.save(state).await.unwrap();
    let previous = state.clone();
    let turn = TurnId::generate();
    let id = EntryId::generate();
    state.transcript.entries.push(TranscriptEntry {
        id: id.clone(),
        turn: turn.clone(),
        role: EntryRole::Agent,
        text: text.into(),
        message: None,
        image: None,
    });
    state.revision += 1;
    let change = database::SessionCommit::between(
        &previous,
        state,
        &[DomainEvent::TurnFinished {
            session: state.id.clone(),
            turn,
        }],
        None,
    )
    .unwrap();
    store.commit(change).await.unwrap();
    id
}
#[tokio::test]
async fn sql_session_commit_and_delivery_are_durable_without_projection_scan() {
    let root = root();
    let store = SessionStore::fixture(&root);
    let mut state = state();
    let entry = finish(&store, &mut state, "你好 immutable output").await;
    store.payloads.shutdown().await;
    let store = SessionStore::fixture(&root);
    let pending = store.outbox.pending(0, 16).await.unwrap();
    assert_eq!(pending.len(), 1);
    assert!(
        matches!(&pending[0].event.payload, outbox::DeliveryPayload::Entries { entries, .. } if entries == &vec![entry.clone()])
    );
    store.remove(state.id.as_str()).await.unwrap();
    assert!(store.load(state.id.as_str()).await.unwrap().is_none());
    assert_eq!(
        store.payloads.entry(&entry).await.unwrap().text,
        "你好 immutable output"
    );
    assert_eq!(store.outbox.pending(0, 16).await.unwrap().len(), 1);
    store.outbox.ack(&pending[0].event.id).await.unwrap();
    store.payloads.shutdown().await;
    let reopened = SessionStore::fixture(&root);
    assert!(reopened.outbox.pending(0, 16).await.unwrap().is_empty());
    reopened.payloads.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn sql_state_rejects_stale_and_scope_conflicts_without_mutation() {
    let root = root();
    let store = SessionStore::fixture(&root);
    let mut state = state();
    store.save(&state).await.unwrap();
    let stale = state.clone();
    finish(&store, &mut state, "committed").await;
    assert!(store.save(&stale).await.is_err());
    let mut conflicting = state.clone();
    conflicting.status = SessionStatus::Failed("same revision, different state".into());
    assert!(store.save(&conflicting).await.is_err());
    store.save(&state).await.unwrap();
    assert_eq!(
        serde_json::to_vec(&store.load(state.id.as_str()).await.unwrap().unwrap()).unwrap(),
        serde_json::to_vec(&state).unwrap()
    );
    let mut moved = state.clone();
    moved.cwd = WorkspacePath::new("/").unwrap();
    moved.revision += 1;
    assert!(store.save(&moved).await.is_err());
    assert_eq!(
        store.load(state.id.as_str()).await.unwrap().unwrap().cwd,
        WorkspacePath::new("/tmp").unwrap()
    );
    store.payloads.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
