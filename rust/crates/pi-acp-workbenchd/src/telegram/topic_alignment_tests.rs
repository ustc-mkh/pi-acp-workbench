use super::*;
use crate::domain::{
    management::ManagementAction, query::CommandReceipt, Harness, SessionId, WorkspacePath,
};

async fn desktop(app: &WorkbenchApp) -> SessionId {
    let CommandReceipt::Created { summary } = app
        .command(DomainCommand::CreateSession {
            harness: Harness::Pi,
            cwd: WorkspacePath::new("/tmp").unwrap(),
        })
        .await
        .unwrap()
    else {
        panic!("created")
    };
    summary.id
}
async fn rename(app: &WorkbenchApp, session: &SessionId, title: &str) {
    app.command(DomainCommand::Manage {
        session: session.clone(),
        action: ManagementAction::Rename {
            title: title.into(),
        },
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn desktop_topic_and_classic_title_reconcile_once_including_rename_cycles_and_restart() {
    let root = root();
    let app = app(&root);
    let api = Fake::default();
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    let id = desktop(&app).await;
    let chat = ChatId::new(-100).unwrap();
    super::super::topics::reconcile(&context, chat, None)
        .await
        .unwrap();
    let topic = context.store.topic(&id).await.unwrap().unwrap();
    assert_eq!(api.0.lock().await.topic_names, vec!["#1 · 新对话"]);
    assert_eq!(api.0.lock().await.topics, 1);
    for title in ["第一项", "第二项", "第一项"] {
        rename(&app, &id, title).await;
        super::super::topics::reconcile(&context, chat, None)
            .await
            .unwrap();
        assert_eq!(
            api.0.lock().await.topic_edits.last().unwrap().1,
            format!("#1 · {title}")
        );
    }
    let edits = api.0.lock().await.topic_edits.len();
    super::super::topics::reconcile(&context, chat, None)
        .await
        .unwrap();
    assert_eq!(api.0.lock().await.topic_edits.len(), edits);
    assert!(
        context
            .inspect(&id)
            .await
            .unwrap()
            .unwrap()
            .provider_session
            .is_none(),
        "topic reconciliation must stay cold"
    );
    app.shutdown().await;
    let reopened = super::app(&root);
    let context = Context::new(
        reopened.clone(),
        api.clone(),
        &root.join("telegram"),
        config(),
    )
    .await
    .unwrap();
    super::super::topics::reconcile(&context, chat, None)
        .await
        .unwrap();
    assert_eq!(context.store.topic(&id).await.unwrap(), Some(topic));
    assert_eq!(api.0.lock().await.topics, 1);
    assert_eq!(api.0.lock().await.topic_edits.len(), edits);
    reopened.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn new_inside_a_forum_topic_creates_an_independent_topic_without_rebinding_source() {
    let root = root();
    let app = app(&root);
    let api = Fake::default();
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    api.0
        .lock()
        .await
        .updates
        .push_back(update(1, None, "/new"));
    poll_once(&context).await.unwrap();
    execute(&context).await;
    let first = context
        .store
        .snapshot()
        .await
        .unwrap()
        .bindings
        .into_iter()
        .next()
        .unwrap();
    api.0
        .lock()
        .await
        .updates
        .push_back(update(2, first.0.thread, "/new"));
    poll_once(&context).await.unwrap();
    execute(&context).await;
    assert_eq!(api.0.lock().await.topics, 2);
    assert_eq!(
        context.store.binding(&first.0).await.unwrap(),
        Some(first.1)
    );
    assert_eq!(context.store.snapshot().await.unwrap().bindings.len(), 2);
    assert_eq!(
        api.0.lock().await.topic_names,
        vec!["#1 · 新对话", "#2 · 新对话"]
    );
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn uncertain_automatic_topic_never_retries_creation_and_names_obey_utf16_limit() {
    let root = root();
    let app = app(&root);
    let api = Fake::default();
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    let id = desktop(&app).await;
    api.0.lock().await.lose_topic_response = true;
    let chat = ChatId::new(-100).unwrap();
    for _ in 0..3 {
        super::super::topics::reconcile(&context, chat, None)
            .await
            .unwrap();
    }
    assert_eq!(api.0.lock().await.topics, 1);
    assert!(context.store.topic(&id).await.unwrap().is_none());
    let mut summary = app.database().summary(id).await.unwrap();
    summary.title = Some("😀".repeat(100));
    let name = super::super::topics::title(&summary);
    assert!(name.encode_utf16().count() <= 128);
    assert!(name.starts_with("#1 · "));
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn desktop_output_waits_for_automatic_binding_without_ack_loss_or_agent_replay() {
    let root = root();
    let app = app(&root);
    let api = Fake::default();
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    context
        .auto_forum
        .store(-100, std::sync::atomic::Ordering::Release);
    let id = desktop(&app).await;
    let mut events = app.subscribe();
    app.command(DomainCommand::Prompt {
        session: id.clone(),
        prompt: crate::domain::Prompt::new("quick desktop task").unwrap(),
    })
    .await
    .unwrap();
    finished(&mut events).await;
    deliver_once(&context).await.unwrap();
    assert!(!app
        .delivery_store()
        .pending(u64::MAX, 32)
        .await
        .unwrap()
        .is_empty());
    assert!(api.0.lock().await.sent.is_empty());
    super::super::topics::reconcile(&context, ChatId::new(-100).unwrap(), None)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(1100)).await;
    deliver_once(&context).await.unwrap();
    assert!(api
        .0
        .lock()
        .await
        .sent
        .iter()
        .any(|m| m.text == "echo: quick desktop task"));
    let page = app
        .query(crate::domain::query::QueryCommand::History {
            session: id,
            cursor: None,
            limit: None,
        })
        .await
        .unwrap();
    let crate::domain::query::QueryResult::History(page) = page else {
        panic!("history")
    };
    assert_eq!(
        page.entries
            .iter()
            .filter(|e| e.role == crate::domain::transcript::EntryRole::User)
            .count(),
        1
    );
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
