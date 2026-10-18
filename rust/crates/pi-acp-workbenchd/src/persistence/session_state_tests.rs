//! Facade-level regressions for the T04 full-state to normalized SQL boundary.
use super::*;
use crate::domain::{
    event::DomainEvent,
    ids::{DeliveryId, EntryId, TurnId},
    transcript::{EntryRole, TranscriptEntry},
    Harness, SessionId, SessionState, WorkspacePath,
};
fn state() -> SessionState {
    SessionState {
        id: SessionId::generate(),
        provider_session: None,
        harness: Harness::Pi,
        cwd: WorkspacePath::new("/tmp").unwrap(),
        status: crate::domain::SessionStatus::Idle,
        transcript: Default::default(),
        plan: Default::default(),
        active_turn: None,
        pending_interactions: Default::default(),
        usage: Default::default(),
        config: crate::domain::session::SessionConfig {
            model: None,
            mode: None,
        },
        configuration_intent: None,
        catalogue: Default::default(),
        revision: 0,
    }
}
fn append(state: &mut SessionState) -> TurnId {
    let turn = TurnId::generate();
    state.transcript.entries.push(TranscriptEntry {
        id: EntryId::generate(),
        turn: turn.clone(),
        role: EntryRole::Agent,
        text: "增量 🌏\n\\\"".into(),
        message: None,
        image: None,
    });
    state.revision += 1;
    turn
}
fn finished(state: &SessionState, turn: TurnId) -> DomainEvent {
    DomainEvent::TurnFinished {
        session: state.id.clone(),
        turn,
    }
}
#[tokio::test]
async fn sql_state_preserves_revision_and_immutable_prefix_and_ack_replay() {
    let root = sqlite_tests::Root::new();
    let store = SessionStore::fixture(root.data());
    let mut state = state();
    store.save(&state).await.unwrap();
    let previous = state.clone();
    let turn = append(&mut state);
    let event = finished(&state, turn);
    let change = database::SessionCommit::between(&previous, &state, &[event], None).unwrap();
    store.commit(change.clone()).await.unwrap();
    let expected = serde_json::to_vec(&state).unwrap();
    assert_eq!(
        serde_json::to_vec(&store.load(state.id.as_str()).await.unwrap().unwrap()).unwrap(),
        expected
    );
    let pending = store.outbox.pending(0, 1).await.unwrap();
    assert_eq!(pending[0].event.revision.get(), state.revision);
    store.outbox.ack(&pending[0].event.id).await.unwrap();
    // CAS retries conflict; immutable intent replay still cannot revive an ack.
    assert!(store.commit(change.clone()).await.is_err());
    store
        .outbox
        .enqueue(change.deliveries[0].clone())
        .await
        .unwrap();
    store.save(&state).await.unwrap();
    assert!(store.outbox.pending(0, 1).await.unwrap().is_empty());
    for truncate in [false, true] {
        let mut changed = state.clone();
        changed.revision += 1;
        if truncate {
            changed.transcript.entries.clear();
        } else {
            changed.transcript.entries[0].text = "rewritten".into();
        }
        assert!(store.save(&changed).await.is_err());
    }
    assert_eq!(
        serde_json::to_vec(&store.load(state.id.as_str()).await.unwrap().unwrap()).unwrap(),
        expected
    );
    store.payloads.shutdown().await;
    let store = SessionStore::fixture(root.data());
    assert_eq!(
        serde_json::to_vec(&store.load(state.id.as_str()).await.unwrap().unwrap()).unwrap(),
        expected
    );
    assert!(store.outbox.pending(0, 1).await.unwrap().is_empty());
    store.payloads.shutdown().await;
}

#[tokio::test]
async fn sql_state_tools_round_trip_and_update_without_losing_archived_bodies() {
    use crate::domain::{
        ids::ToolCallId,
        tool::{ToolCall, ToolContent, ToolDetails, ToolStatus},
    };
    let root = sqlite_tests::Root::new();
    let store = SessionStore::fixture(root.data());
    let mut state = state();
    let turn = TurnId::generate();
    let id = ToolCallId::generate();
    let call = ToolCall {
        id: id.clone(),
        turn: turn.clone(),
        title: "tool metadata".into(),
        status: ToolStatus::InProgress,
        details: ToolDetails {
            content: vec![
                ToolContent::Text {
                    text: "大工具 🌏\n".repeat(4000),
                },
                ToolContent::Diff {
                    path: "/untrusted/display-only".into(),
                    old_text: Some("old 🦀".into()),
                    new_text: "new 🌏".into(),
                },
                ToolContent::ResourceText {
                    uri: "https://untrusted.invalid/no-fetch".into(),
                    text: "resource text".into(),
                    mime_type: Some("text/plain".into()),
                },
            ],
            ..Default::default()
        },
    };
    state
        .transcript
        .tools
        .entry(turn.clone())
        .or_default()
        .insert(id.clone(), call);
    store.save(&state).await.unwrap();
    state.revision += 2;
    state
        .transcript
        .tools
        .get_mut(&turn)
        .unwrap()
        .get_mut(&id)
        .unwrap()
        .status = ToolStatus::Completed;
    store.save(&state).await.unwrap();
    let expected = serde_json::to_vec(&state).unwrap();
    store.payloads.shutdown().await;
    let store = SessionStore::fixture(root.data());
    assert_eq!(
        serde_json::to_vec(&store.load(state.id.as_str()).await.unwrap().unwrap()).unwrap(),
        expected
    );
    let mut removed = state.clone();
    removed.revision += 1;
    removed.transcript.tools.clear();
    assert!(store.save(&removed).await.is_err());
    assert_eq!(
        serde_json::to_vec(&store.load(state.id.as_str()).await.unwrap().unwrap()).unwrap(),
        expected
    );
    store.payloads.shutdown().await;
}
#[tokio::test]
async fn sql_state_delivery_insert_abort_rolls_back_state_entries_contents_and_order() {
    let root = sqlite_tests::Root::new();
    let store = SessionStore::fixture(root.data());
    let mut state = state();
    store.save(&state).await.unwrap();
    store.payloads.shutdown().await;
    let sql = rusqlite::Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    sql.execute_batch("CREATE TRIGGER reject_delivery BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT,'test delivery failure'); END").unwrap();
    sql.close().unwrap();
    let store = SessionStore::fixture(root.data());
    let original = serde_json::to_vec(&state).unwrap();
    let previous = state.clone();
    let turn = append(&mut state);
    let entry = state.transcript.entries[0].id.clone();
    let event = finished(&state, turn);
    let asset =
        crate::domain::image::ImageAsset::from_base64("image/gif", "R0lGODlhAQABAA==").unwrap();
    state.transcript.entries[0].image = Some(asset.image().clone());
    let change =
        database::SessionCommit::between(&previous, &state, &[event], Some(asset.clone())).unwrap();
    assert!(store.commit(change.clone()).await.is_err());
    assert_eq!(
        serde_json::to_vec(&store.load(state.id.as_str()).await.unwrap().unwrap()).unwrap(),
        original
    );
    assert!(store.payloads.entry(&entry).await.is_err());
    assert!(store.payloads.image(asset.image()).await.is_err());
    assert!(store.outbox.pending(0, 1).await.unwrap().is_empty());
    store.payloads.shutdown().await;
    let sql = rusqlite::Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    for table in ["contents", "entries", "session_entries", "deliveries"] {
        assert_eq!(
            sql.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    assert_eq!(
        sql.query_row(
            "SELECT value FROM store_meta WHERE key='delivery_seq'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    sql.execute_batch("DROP TRIGGER reject_delivery").unwrap();
    sql.close().unwrap();
    let store = SessionStore::fixture(root.data());
    store.commit(change).await.unwrap();
    assert_eq!(
        store.payloads.image(asset.image()).await.unwrap().bytes(),
        asset.bytes()
    );
    assert_eq!(
        store.payloads.entry(&entry).await.unwrap().text,
        state.transcript.entries[0].text
    );
    assert_eq!(store.outbox.pending(0, 1).await.unwrap().len(), 1);
    store.payloads.shutdown().await;
}
#[tokio::test]
async fn sql_state_commit_rejects_stale_owner_and_observer_drop_still_drains_all_records() {
    let root = sqlite_tests::Root::new();
    let store = SessionStore::fixture(root.data());
    let previous = state();
    store.save(&previous).await.unwrap();
    let mut next = previous.clone();
    let turn = append(&mut next);
    let change =
        database::SessionCommit::between(&previous, &next, &[finished(&next, turn)], None).unwrap();
    let paused = store.database().pause_executor().await.unwrap();
    let (reply, observer) = tokio::sync::oneshot::channel();
    store
        .database()
        .enqueue(database::StoreRequest::Commit {
            commit: Box::new(change),
            reply,
        })
        .await
        .unwrap();
    drop(observer);
    let closing = store.database().clone();
    let shutdown = tokio::spawn(async move { closing.shutdown().await });
    tokio::task::yield_now().await;
    assert!(!shutdown.is_finished());
    assert!(format::StorageLease::lock(&root.data()).is_err());
    drop(paused);
    shutdown.await.unwrap().unwrap();
    let store = SessionStore::fixture(root.data());
    assert_eq!(
        serde_json::to_vec(&store.load(next.id.as_str()).await.unwrap().unwrap()).unwrap(),
        serde_json::to_vec(&next).unwrap()
    );
    assert_eq!(store.outbox.pending(0, 1).await.unwrap().len(), 1);
    let mut stale = previous.clone();
    let turn = append(&mut stale);
    let stale_id = stale.transcript.entries[0].id.clone();
    let stale_commit =
        database::SessionCommit::between(&previous, &stale, &[finished(&stale, turn)], None)
            .unwrap();
    assert!(store.commit(stale_commit).await.is_err());
    assert!(store.payloads.entry(&stale_id).await.is_err());
    assert_eq!(
        serde_json::to_vec(&store.load(next.id.as_str()).await.unwrap().unwrap()).unwrap(),
        serde_json::to_vec(&next).unwrap()
    );
    store.payloads.shutdown().await;
}

#[tokio::test]
async fn sql_state_intents_survive_small_read_window_source_removal_and_restart() {
    let root = sqlite_tests::Root::new();
    let store = SessionStore::fixture(root.data());
    let window = outbox::OutboxStore::new(store.database().clone(), 1);
    let mut state = state();
    let mut ids = Vec::new();
    store.save(&state).await.unwrap();
    for _ in 0..3 {
        let previous = state.clone();
        let turn = append(&mut state);
        ids.push(DeliveryId::new(format!("turn-{turn}")).unwrap());
        let change =
            database::SessionCommit::between(&previous, &state, &[finished(&state, turn)], None)
                .unwrap();
        store.commit(change).await.unwrap();
    }
    assert_eq!(window.pending(0, 10).await.unwrap().len(), 1);
    store.remove(state.id.as_str()).await.unwrap();
    store.payloads.shutdown().await;
    let store = SessionStore::fixture(root.data());
    let window = outbox::OutboxStore::new(store.database().clone(), 1);
    for (index, id) in ids.iter().enumerate() {
        let pending = window.pending(0, 10).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(&pending[0].event.id, id);
        assert_eq!(
            store
                .payloads
                .entry(&state.transcript.entries[index].id)
                .await
                .unwrap()
                .text,
            state.transcript.entries[index].text
        );
        window.ack(id).await.unwrap();
    }
    assert!(window.pending(0, 10).await.unwrap().is_empty());
    store.payloads.shutdown().await;
}
