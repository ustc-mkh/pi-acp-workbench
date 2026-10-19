use super::*;
use crate::domain::{
    command::AgentEvent, query::SessionView, transition::Transition, DomainCommand, EntryId,
    SessionStatus, WorkspacePath,
};
fn root() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("workbench-sql-session-{}", uuid::Uuid::new_v4()))
}
fn state() -> SessionView {
    let mut view = turn_manifest_tests::initial();
    view.cwd = WorkspacePath::new("/tmp").unwrap();
    view
}
async fn finish(store: &SessionStore, view: &mut SessionView, text: &str) -> EntryId {
    turn_manifest_tests::apply(
        store.database(),
        view,
        DomainCommand::Prompt {
            session: view.id.clone(),
            prompt: crate::domain::Prompt::new("input").unwrap(),
        },
    )
    .await;
    let turn = view.active_turn.clone().unwrap();
    turn_manifest_tests::apply(
        store.database(),
        view,
        DomainCommand::Agent {
            session: view.id.clone(),
            event: AgentEvent::Text {
                turn: turn.clone(),
                message: None,
                text: text.into(),
            },
        },
    )
    .await;
    turn_manifest_tests::apply(
        store.database(),
        view,
        DomainCommand::Agent {
            session: view.id.clone(),
            event: AgentEvent::Finished { turn },
        },
    )
    .await;
    store
        .database()
        .history(view.id.clone(), None, Some(1))
        .await
        .unwrap()
        .entries[0]
        .id
        .clone()
}
fn changed(view: &SessionView) -> Transition {
    let mut next = view.clone();
    next.revision = next.revision.next().unwrap();
    Transition {
        operation: None,
        expected_revision: view.revision,
        next,
        contents: vec![],
        append: vec![],
        tool_updates: vec![],
        deliveries: vec![],
    }
}
#[tokio::test]
async fn sql_session_commit_and_delivery_are_durable_without_projection_scan() {
    let root = root();
    let store = SessionStore::fixture(&root);
    let mut view = state();
    store.database().create(view.clone()).await.unwrap();
    let entry = finish(&store, &mut view, "你好 immutable output").await;
    store.payloads.shutdown().await;
    let store = SessionStore::fixture(&root);
    let all = store.outbox.pending(0, 16).await.unwrap();
    assert_eq!(all.len(), 2);
    let input = all
        .iter()
        .find(|record| matches!(&record.event.payload, outbox::DeliveryPayload::Input { .. }))
        .unwrap();
    let outbox::DeliveryPayload::Input {
        entry: input_entry, ..
    } = &input.event.payload
    else {
        unreachable!()
    };
    assert_eq!(
        store.payloads.entry_header(input_entry).await.unwrap().role,
        crate::domain::transcript::EntryRole::User
    );
    store.outbox.ack(&input.event.id).await.unwrap();
    let pending: Vec<_> = all
        .into_iter()
        .filter(|record| matches!(&record.event.payload, outbox::DeliveryPayload::Turn { .. }))
        .collect();
    assert_eq!(pending.len(), 1);
    assert!(
        matches!(&pending[0].event.payload, outbox::DeliveryPayload::Turn { session, first_seq, last_seq, .. } if session == &view.id && first_seq.get() == 1 && last_seq.get() == 2)
    );
    let frozen = store
        .payloads
        .delivery_page(&pending[0].event.id, Default::default())
        .await
        .unwrap();
    assert_eq!(frozen.entries[0].id, entry);
    store
        .database()
        .remove(view.id.clone(), None)
        .await
        .unwrap();
    assert!(store.database().view(view.id.clone()).await.is_err());
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
async fn sql_incremental_rejects_stale_same_revision_and_scope_conflicts_without_mutation() {
    let root = root();
    let store = SessionStore::fixture(&root);
    let mut view = state();
    store.database().create(view.clone()).await.unwrap();
    let stale = changed(&view);
    finish(&store, &mut view, "committed").await;
    assert!(store.commit(stale).await.is_err());
    let mut conflicting = changed(&view);
    conflicting.next.revision = view.revision;
    conflicting.next.status = SessionStatus::Failed("same revision, different state".into());
    assert!(store.commit(conflicting).await.is_err());
    assert_eq!(
        serde_json::to_vec(&store.database().view(view.id.clone()).await.unwrap()).unwrap(),
        serde_json::to_vec(&view).unwrap()
    );
    let mut moved = changed(&view);
    moved.next.cwd = WorkspacePath::new("/").unwrap();
    assert!(store.commit(moved).await.is_err());
    assert_eq!(
        store.database().view(view.id).await.unwrap().cwd,
        WorkspacePath::new("/tmp").unwrap()
    );
    store.payloads.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
