//! Incremental facade regressions: no full-state save/load or transcript diff.
use super::*;
use crate::domain::{
    query::{SafeInteger, SessionView},
    transcript::EntryRole,
    transition::{
        DeliveryIntent, DeliveryPayload, DeliveryTarget, NewContent, NewEntry, Transition,
    },
    DeliveryId, EntryId, TurnId,
};
const TEXT: &str = "增量 🌏\n\\\"";
fn state() -> SessionView {
    turn_manifest_tests::initial()
}
fn text(value: &str) -> NewContent {
    let sha256 = crate::domain::fork::ContentHash::of(value);
    NewContent {
        content: crate::domain::query::ContentRef {
            id: crate::domain::ContentId::new(format!("test-{}", sha256.as_str())).unwrap(),
            sha256,
            bytes: SafeInteger::new(value.len() as u64).unwrap(),
            kind: crate::domain::query::ContentKind::Text,
        },
        text: value.into(),
    }
}
fn append(previous: &SessionView) -> Transition {
    let mut next = previous.clone();
    next.revision = next.revision.next().unwrap();
    next.last_entry_seq = next.last_entry_seq.next().unwrap();
    let turn = TurnId::generate();
    Transition {
        operation: None,
        expected_revision: previous.revision,
        deliveries: vec![DeliveryIntent {
            id: DeliveryId::new(format!("turn-{turn}")).unwrap(),
            revision: next.revision,
            target: DeliveryTarget::Session {
                session: next.id.clone(),
                cwd: next.cwd.clone(),
            },
            payload: DeliveryPayload::Turn {
                session: next.id.clone(),
                turn: turn.clone(),
                first_seq: next.last_entry_seq,
                last_seq: next.last_entry_seq,
            },
        }],
        next,
        contents: vec![],
        tool_updates: vec![],
        append: vec![NewEntry {
            id: EntryId::generate(),
            turn,
            role: EntryRole::Agent,
            message: None,
            text: text(TEXT),
            image: None,
        }],
    }
}
async fn view(store: &SessionStore, expected: &SessionView) {
    assert_eq!(
        serde_json::to_vec(&store.database().view(expected.id.clone()).await.unwrap()).unwrap(),
        serde_json::to_vec(expected).unwrap()
    );
}
#[tokio::test]
async fn incremental_commit_preserves_revision_immutable_archive_and_ack_replay() {
    let root = sqlite_tests::Root::new();
    let store = SessionStore::fixture(root.data());
    let initial = state();
    store.database().create(initial.clone()).await.unwrap();
    let change = append(&initial);
    let next = change.next.clone();
    store.commit(change.clone()).await.unwrap();
    view(&store, &next).await;
    let pending = store.outbox.pending(0, 1).await.unwrap();
    assert_eq!(pending[0].event.revision, next.revision);
    store.outbox.ack(&pending[0].event.id).await.unwrap();
    assert!(store.commit(change.clone()).await.is_err());
    store
        .outbox
        .enqueue(change.deliveries[0].clone())
        .await
        .unwrap();
    assert!(store.outbox.pending(0, 1).await.unwrap().is_empty());
    assert!(store.database().create(next.clone()).await.is_err());
    let mut rewritten = append(&next);
    rewritten.append[0].id = change.append[0].id.clone();
    rewritten.append[0].text = text("rewritten");
    assert!(store.commit(rewritten).await.is_err());
    view(&store, &next).await;
    assert_eq!(
        store
            .payloads
            .entry(&change.append[0].id)
            .await
            .unwrap()
            .text,
        TEXT
    );
    store.payloads.shutdown().await;
    let store = SessionStore::fixture(root.data());
    view(&store, &next).await;
    assert!(store.outbox.pending(0, 1).await.unwrap().is_empty());
    store.payloads.shutdown().await;
}
#[tokio::test]
async fn incremental_tools_round_trip_status_patch_without_losing_archived_bodies() {
    use crate::domain::{
        tool::{ToolCall, ToolCallUpdate, ToolContent, ToolDetails, ToolStatus},
        transition::ToolUpdate,
        ToolCallId,
    };
    let root = sqlite_tests::Root::new();
    let store = SessionStore::fixture(root.data());
    let initial = state();
    store.database().create(initial.clone()).await.unwrap();
    let mut change = append(&initial);
    let turn = change.append[0].turn.clone();
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
    change
        .tool_updates
        .push(ToolUpdate::from_call(&call).unwrap());
    let mut next = change.next.clone();
    store.commit(change).await.unwrap();
    let old = store
        .database()
        .tools(next.id.clone(), turn.clone(), None, None)
        .await
        .unwrap()
        .tools
        .remove(0);
    let patch = ToolUpdate::patch(
        ToolCallUpdate {
            id: id.clone(),
            turn: turn.clone(),
            title: None,
            status: Some(ToolStatus::Completed),
            details: Default::default(),
        },
        Some(&old),
    )
    .unwrap();
    assert!(patch.contents.is_empty());
    let mut change = append(&next);
    change.tool_updates.push(patch);
    next = change.next.clone();
    store.commit(change).await.unwrap();
    store.payloads.shutdown().await;
    let store = SessionStore::fixture(root.data());
    view(&store, &next).await;
    let header = store
        .database()
        .tools(next.id.clone(), turn, None, None)
        .await
        .unwrap()
        .tools
        .remove(0);
    assert_eq!(header.status, ToolStatus::Completed);
    assert_eq!(
        serde_json::to_vec(&header.content).unwrap(),
        serde_json::to_vec(&old.content).unwrap()
    );
    for body in &header.content {
        match body {
            crate::domain::query::ToolBody::Text { content } => assert_eq!(
                store.payloads.content(content).await.unwrap(),
                "大工具 🌏\n".repeat(4000)
            ),
            crate::domain::query::ToolBody::Diff {
                old_text, new_text, ..
            } => {
                assert_eq!(
                    store
                        .payloads
                        .content(old_text.as_ref().unwrap())
                        .await
                        .unwrap(),
                    "old 🦀"
                );
                assert_eq!(store.payloads.content(new_text).await.unwrap(), "new 🌏");
            }
            crate::domain::query::ToolBody::ResourceText { content, .. } => assert_eq!(
                store.payloads.content(content).await.unwrap(),
                "resource text"
            ),
            _ => panic!("unexpected body"),
        }
    }
    store.payloads.shutdown().await;
}
#[tokio::test]
async fn incremental_delivery_abort_rolls_back_view_entries_image_contents_and_order() {
    let root = sqlite_tests::Root::new();
    let store = SessionStore::fixture(root.data());
    let initial = state();
    store.database().create(initial.clone()).await.unwrap();
    store.payloads.shutdown().await;
    let sql = rusqlite::Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    sql.execute_batch("CREATE TRIGGER reject_delivery BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT,'test delivery failure'); END").unwrap();
    sql.close().unwrap();
    let store = SessionStore::fixture(root.data());
    let mut change = append(&initial);
    let next = change.next.clone();
    let entry = change.append[0].id.clone();
    let asset =
        crate::domain::image::ImageAsset::from_base64("image/gif", "R0lGODlhAQABAA==").unwrap();
    change.append[0].image = Some(asset.clone());
    assert!(store.commit(change.clone()).await.is_err());
    view(&store, &initial).await;
    assert!(store.payloads.entry(&entry).await.is_err());
    assert!(store.payloads.image(asset.image()).await.is_err());
    assert!(store.outbox.pending(0, 1).await.unwrap().is_empty());
    store.payloads.shutdown().await;
    let sql = rusqlite::Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    for table in [
        "contents",
        "entries",
        "session_entries",
        "deliveries",
        "delivery_entries",
    ] {
        assert_eq!(
            sql.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    assert_eq!(
        sql.query_row(
            "SELECT value FROM store_meta WHERE key='delivery_seq'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    sql.execute_batch("DROP TRIGGER reject_delivery").unwrap();
    sql.close().unwrap();
    let store = SessionStore::fixture(root.data());
    store.commit(change).await.unwrap();
    view(&store, &next).await;
    assert_eq!(
        store.payloads.image(asset.image()).await.unwrap().bytes(),
        asset.bytes()
    );
    assert_eq!(store.payloads.entry(&entry).await.unwrap().text, TEXT);
    assert_eq!(store.outbox.pending(0, 1).await.unwrap().len(), 1);
    store.payloads.shutdown().await;
}
#[tokio::test]
async fn incremental_stale_owner_rejected_and_dropped_observer_drains_before_lease_release() {
    let root = sqlite_tests::Root::new();
    let store = SessionStore::fixture(root.data());
    let initial = state();
    store.database().create(initial.clone()).await.unwrap();
    let change = append(&initial);
    let next = change.next.clone();
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
    view(&store, &next).await;
    assert_eq!(store.outbox.pending(0, 1).await.unwrap().len(), 1);
    let stale = append(&initial);
    let stale_id = stale.append[0].id.clone();
    assert!(store.commit(stale).await.is_err());
    assert!(store.payloads.entry(&stale_id).await.is_err());
    view(&store, &next).await;
    store.payloads.shutdown().await;
}
#[tokio::test]
async fn incremental_frozen_turn_intents_survive_window_source_removal_and_restart() {
    let root = sqlite_tests::Root::new();
    let store = SessionStore::fixture(root.data());
    let window = outbox::OutboxStore::new(store.database().clone(), 1);
    let mut next = state();
    let mut ids = Vec::new();
    store.database().create(next.clone()).await.unwrap();
    for _ in 0..3 {
        let change = append(&next);
        ids.push((change.deliveries[0].id.clone(), change.append[0].id.clone()));
        next = change.next.clone();
        store.commit(change).await.unwrap();
    }
    assert_eq!(window.pending(0, 10).await.unwrap().len(), 1);
    store
        .database()
        .remove(next.id.clone(), None)
        .await
        .unwrap();
    store.payloads.shutdown().await;
    let store = SessionStore::fixture(root.data());
    let window = outbox::OutboxStore::new(store.database().clone(), 1);
    for (id, entry) in ids {
        let pending = window.pending(0, 10).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].event.id, id);
        assert_eq!(store.payloads.entry(&entry).await.unwrap().text, TEXT);
        let manifest = store
            .payloads
            .delivery_page(&id, SafeInteger::new(0).unwrap())
            .await
            .unwrap();
        assert_eq!(manifest.entries.len(), 1);
        window.ack(&id).await.unwrap();
    }
    assert!(window.pending(0, 10).await.unwrap().is_empty());
    store.payloads.shutdown().await;
}
