#[path = "directory_tests.rs"]
mod directory_tests;
use super::*;
use crate::{
    domain::{query::CommandReceipt, Harness, SessionId, WorkspacePath},
    telegram::{
        command::{ControlCommand, MenuPage},
        types::{CallbackAction, IncomingContent, IncomingUpdate},
    },
};
async fn command(context: &Context<Fake>, id: u64, thread: Option<TopicId>, text: &str) {
    context
        .api
        .0
        .lock()
        .await
        .updates
        .push_back(update(id, thread, text));
    poll_once(context).await.unwrap();
    execute(context).await;
    deliver_once(context).await.unwrap();
}
async fn click(
    context: &Context<Fake>,
    id: u64,
    thread: Option<TopicId>,
    key: &CallbackKey,
    sender: i64,
) {
    let mut from = user(false);
    from.id = UserId::new(sender).unwrap();
    context.api.0.lock().await.updates.push_back(WireUpdate {
        update_id: UpdateId::new(id).unwrap(),
        message: None,
        callback_query: Some(WireCallback {
            id: format!("menu-{id}"),
            from,
            message: Some(message(id as i64, thread, None)),
            data: Some(key.as_str().into()),
        }),
    });
    poll_once(context).await.unwrap();
    execute(context).await;
    deliver_once(context).await.unwrap();
}
async fn choices(context: &Context<Fake>) -> Vec<(String, CallbackKey, ControlCommand)> {
    let keyboard = context
        .api
        .0
        .lock()
        .await
        .sent
        .iter()
        .rev()
        .find_map(|message| message.reply_markup.clone())
        .unwrap();
    let mut result = vec![];
    for button in keyboard.inline_keyboard.into_iter().flatten() {
        let binding = context
            .store
            .callback(&button.callback_data)
            .await
            .unwrap()
            .unwrap();
        if let CallbackAction::Control { command, .. } = binding.action {
            result.push((button.text, button.callback_data, command));
        }
    }
    result
}
async fn created(app: &WorkbenchApp, cwd: &str) -> SessionId {
    let CommandReceipt::Created { summary } = app
        .command(DomainCommand::CreateSession {
            harness: Harness::Pi,
            cwd: WorkspacePath::new(cwd).unwrap(),
        })
        .await
        .unwrap()
    else {
        panic!("create")
    };
    summary.id
}

#[tokio::test]
async fn menu_create_buttons_are_cold_forum_aware_topic_bound_single_use_and_restart_safe() {
    let root = root();
    let trace = root.join("trace");
    let first = app_with_env(
        &root,
        std::collections::HashMap::from([(
            "WORKBENCH_CONTRACT_TRACE".into(),
            trace.to_string_lossy().into_owned(),
        )]),
    );
    let api = Fake::default();
    let context = Context::new(first.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    command(&context, 1, None, "/menu").await;
    let buttons = choices(&context).await;
    assert!(buttons.iter().any(|(label, _, _)| label == "New Pi"));
    assert!(!buttons
        .iter()
        .any(|(label, _, _)| label == "New Codex" || label == "New Claude"));
    let key = buttons
        .into_iter()
        .find(|(_, _, command)| matches!(command, ControlCommand::NewSession { .. }))
        .unwrap()
        .1;
    assert!(!trace.exists());
    assert!(first.journal_snapshot().await.unwrap().is_empty());
    click(&context, 2, Some(TopicId::new(101).unwrap()), &key, 5).await;
    click(&context, 3, None, &key, 6).await;
    assert!(context
        .store
        .callback(&key)
        .await
        .unwrap()
        .unwrap()
        .used_by
        .is_none());
    assert_eq!(api.0.lock().await.topics, 0);
    first.shutdown_checked().await.unwrap();
    let second = app_with_env(
        &root,
        std::collections::HashMap::from([(
            "WORKBENCH_CONTRACT_TRACE".into(),
            trace.to_string_lossy().into_owned(),
        )]),
    );
    let context = Context::new(
        second.clone(),
        api.clone(),
        &root.join("telegram"),
        config(),
    )
    .await
    .unwrap();
    click(&context, 4, None, &key, 5).await;
    let destination = TopicKey {
        chat: ChatId::new(-100).unwrap(),
        thread: Some(TopicId::new(101).unwrap()),
    };
    let session = context.store.binding(&destination).await.unwrap().unwrap();
    assert_eq!(api.0.lock().await.topics, 1);
    assert!(context
        .inspect(&session)
        .await
        .unwrap()
        .unwrap()
        .provider_session
        .is_none());
    assert!(!trace.exists(), "menu creation must not load an ACP peer");
    click(&context, 5, None, &key, 5).await;
    assert_eq!(api.0.lock().await.topics, 1);
    assert_eq!(second.list(None, None).await.unwrap().sessions.len(), 1);
    assert_eq!(
        context.store.callback(&key).await.unwrap().unwrap().used_by,
        Some(UpdateId::new(4).unwrap())
    );
    assert!(api
        .0
        .lock()
        .await
        .sent
        .iter()
        .any(|message| message.text.contains("按钮已使用")));
    second.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn menu_model_and_mode_buttons_share_existing_provider_execution_and_old_binding_is_rejected()
{
    let root = root();
    let trace = root.join("trace");
    let app = app_with_env(
        &root,
        std::collections::HashMap::from([(
            "WORKBENCH_CONTRACT_TRACE".into(),
            trace.to_string_lossy().into_owned(),
        )]),
    );
    let api = Fake::default();
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    let session = created(&app, "/tmp").await;
    let destination = TopicKey {
        chat: ChatId::new(-100).unwrap(),
        thread: Some(TopicId::new(101).unwrap()),
    };
    context
        .store
        .bind(destination.clone(), session.clone())
        .await
        .unwrap();
    command(&context, 1, destination.thread, "/menu models").await;
    assert!(!trace.exists());
    assert!(api
        .0
        .lock()
        .await
        .sent
        .iter()
        .any(|message| message.text.contains("No offerings")));
    let mut events = app.subscribe();
    command(&context, 2, destination.thread, "prime").await;
    finished(&mut events).await;
    deliver_once(&context).await.unwrap();
    command(&context, 3, destination.thread, "/menu models").await;
    let key = choices(&context).await.into_iter().find(|(_, _, command)| matches!(command, ControlCommand::SetModel { model, .. } if model.as_str() == "other")).unwrap().1;
    click(&context, 4, destination.thread, &key, 5).await;
    assert_eq!(
        context
            .inspect(&session)
            .await
            .unwrap()
            .unwrap()
            .config
            .model
            .unwrap()
            .as_str(),
        "other"
    );
    let before = tokio::fs::read_to_string(&trace).await.unwrap();
    click(&context, 5, destination.thread, &key, 5).await;
    assert_eq!(
        tokio::fs::read_to_string(&trace).await.unwrap(),
        before,
        "repeated button must not configure twice"
    );
    command(&context, 6, destination.thread, "/menu modes").await;
    let mode = choices(&context).await.into_iter().find(|(_, _, command)| matches!(command, ControlCommand::SetMode { mode, .. } if mode.as_str() == "high")).unwrap().1;
    click(&context, 7, destination.thread, &mode, 5).await;
    assert_eq!(
        context
            .inspect(&session)
            .await
            .unwrap()
            .unwrap()
            .config
            .mode
            .unwrap()
            .as_str(),
        "high"
    );
    command(&context, 8, destination.thread, "/menu").await;
    let stale = choices(&context)
        .await
        .into_iter()
        .find(|(_, _, command)| matches!(command, ControlCommand::Cancel { .. }))
        .unwrap()
        .1;
    let other = created(&app, "/tmp").await;
    context
        .store
        .bind(destination.clone(), other)
        .await
        .unwrap();
    let journal = app.journal_snapshot().await.unwrap();
    click(&context, 9, destination.thread, &stale, 5).await;
    assert_eq!(app.journal_snapshot().await.unwrap(), journal);
    assert!(context
        .store
        .callback(&stale)
        .await
        .unwrap()
        .unwrap()
        .used_by
        .is_none());
    assert!(api
        .0
        .lock()
        .await
        .sent
        .iter()
        .any(|message| message.text.contains("按钮无效")));
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn session_menu_is_bounded_authorized_cold_and_uses_stable_keyset_pages() {
    let root = root();
    let trace = root.join("trace");
    let app = app_with_env(
        &root,
        std::collections::HashMap::from([(
            "WORKBENCH_CONTRACT_TRACE".into(),
            trace.to_string_lossy().into_owned(),
        )]),
    );
    let api = Fake::default();
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    let mut expected = std::collections::BTreeSet::new();
    for _ in 0..25 {
        expected.insert(created(&app, "/tmp").await);
    }
    let forbidden = created(&app, "/").await;
    let elsewhere = created(&app, "/tmp").await;
    context
        .store
        .bind(
            TopicKey {
                chat: ChatId::new(-100).unwrap(),
                thread: Some(TopicId::new(102).unwrap()),
            },
            elsewhere.clone(),
        )
        .await
        .unwrap();
    let thread = Some(TopicId::new(101).unwrap());
    command(&context, 1, thread, "/menu sessions").await;
    let late = created(&app, "/tmp").await;
    let journal = app.journal_snapshot().await.unwrap();
    let mut found = std::collections::BTreeSet::new();
    let mut update = 2;
    loop {
        let buttons = choices(&context).await;
        let mut count = 0;
        for (_, _, command) in &buttons {
            if let ControlCommand::Attach { session } = command {
                assert!(found.insert(session.clone()));
                count += 1;
            }
        }
        assert!(count <= 10);
        let next = buttons.into_iter().find(|(label, _, command)| {
            label == "Next session page"
                && matches!(
                    command,
                    ControlCommand::Menu {
                        page: MenuPage::Sessions { cursor: Some(_) },
                        ..
                    }
                )
        });
        let Some((_, key, _)) = next else {
            break;
        };
        click(&context, update, thread, &key, 5).await;
        update += 1;
    }
    assert_eq!(found, expected);
    assert!(!found.contains(&forbidden));
    assert!(
        !found.contains(&elsewhere),
        "menu must not offer an implicit cross-topic binding transfer"
    );
    assert!(api
        .0
        .lock()
        .await
        .sent
        .iter()
        .any(|message| message.text.contains("already bound to another topic")));
    assert!(!found.contains(&late));
    assert!(!trace.exists());
    assert_eq!(
        app.journal_snapshot().await.unwrap(),
        journal,
        "menu queries must not write operation journal"
    );
    let latest = choices(&context)
        .await
        .into_iter()
        .find(|(label, _, _)| label == "Latest session page")
        .unwrap()
        .1;
    click(&context, update, thread, &latest, 5).await;
    let current = choices(&context).await;
    assert!(current.iter().any(
        |(_, _, command)| matches!(command, ControlCommand::Attach { session } if session == &late)
    ));
    let open = current.into_iter().find(|(_, _, command)| matches!(command, ControlCommand::Attach { session } if session == &late)).unwrap().1;
    click(&context, update + 1, thread, &open, 5).await;
    assert_eq!(
        context
            .store
            .binding(&TopicKey {
                chat: ChatId::new(-100).unwrap(),
                thread
            })
            .await
            .unwrap(),
        Some(late)
    );
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn menu_payload_is_frozen_for_retry_bounded_and_expired_rendering_has_no_buttons() {
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
        .push_back(update(1, None, "/menu"));
    poll_once(&context).await.unwrap();
    execute(&context).await;
    let record = app
        .delivery_store()
        .pending(u64::MAX, 16)
        .await
        .unwrap()
        .remove(0);
    let crate::domain::transition::DeliveryPayload::Menu { content } = &record.event.payload else {
        panic!("menu intent")
    };
    let frozen = app.delivery_payloads().content(content).await.unwrap();
    let value: serde_json::Value = serde_json::from_str(&frozen).unwrap();
    let expiry = value["expires_at"].as_u64().unwrap();
    api.0.lock().await.fail_send = true;
    deliver_once(&context).await.unwrap();
    app.delivery_store()
        .fail(&record.event.id, DeliveryFailure::RateLimited, 0)
        .await
        .unwrap();
    deliver_once(&context).await.unwrap();
    assert_eq!(
        app.delivery_payloads().content(content).await.unwrap(),
        frozen
    );
    for (_, key, _) in choices(&context).await {
        assert_eq!(
            context
                .store
                .callback(&key)
                .await
                .unwrap()
                .unwrap()
                .expires_at,
            expiry
        );
    }
    let first_key = choices(&context).await.remove(0).1;
    super::super::admission::admit_update(
        &context.store,
        IncomingUpdate {
            id: UpdateId::new(2).unwrap(),
            topic: TopicKey {
                chat: ChatId::new(-100).unwrap(),
                thread: None,
            },
            sender: UserId::new(5).unwrap(),
            from_bot: false,
            forum: true,
            content: IncomingContent::Callback {
                key: first_key.clone(),
                query: "expired-menu".into(),
            },
        },
        None,
        &super::super::admission::AdmissionPolicy {
            chats: context.config.allowed_chat_ids.iter().copied().collect(),
            users: context.config.allowed_user_ids.iter().copied().collect(),
            cwd: context.config.workspace.clone(),
        },
        expiry,
    )
    .await
    .unwrap();
    assert!(matches!(
        context
            .store
            .pending(16)
            .await
            .unwrap()
            .into_iter()
            .find(|record| record.id == UpdateId::new(2).unwrap())
            .unwrap()
            .command
            .action,
        super::super::command::TelegramAction::Rejected(
            super::super::command::RejectionReason::ExpiredInteraction
        )
    ));
    assert!(context
        .store
        .callback(&first_key)
        .await
        .unwrap()
        .unwrap()
        .used_by
        .is_none());
    let menu = super::super::menu::Menu::decode(&frozen).unwrap();
    let destination = TopicKey {
        chat: ChatId::new(-100).unwrap(),
        thread: None,
    };
    let parts =
        super::super::menu::render(&record.event.id, &destination, menu, &context.store, expiry)
            .await
            .unwrap();
    // Expiry projection uses the same topic and cannot register replacement keys.
    assert!(parts.into_iter().all(|part| matches!(part, super::super::render::DeliveryPart::Message(message) if message.reply_markup.is_none())));
    let mut bad = value;
    bad["text"] = "x".repeat(70_000).into();
    assert!(super::super::menu::Menu::decode(&bad.to_string()).is_err());
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn menu_new_revalidates_workspace_without_consuming_the_key_or_failing_polling() {
    let root = root();
    let app = app(&root);
    let workspace = root.join("workspace");
    tokio::fs::create_dir_all(&workspace).await.unwrap();
    let other = root.join("other-workspace");
    tokio::fs::create_dir_all(&other).await.unwrap();
    let allowed = root.join("allowed-workspace");
    std::os::unix::fs::symlink(&workspace, &allowed).unwrap();
    let api = Fake::default();
    let mut cfg = config();
    cfg.workspace = WorkspacePath::new(allowed.to_str().unwrap()).unwrap();
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), cfg)
        .await
        .unwrap();
    let thread = Some(TopicId::new(101).unwrap());
    command(&context, 1, thread, "/menu").await;
    let key = choices(&context)
        .await
        .into_iter()
        .find(|(_, _, command)| matches!(command, ControlCommand::NewSession { .. }))
        .unwrap()
        .1;
    tokio::fs::remove_file(&allowed).await.unwrap();
    std::os::unix::fs::symlink(&other, &allowed).unwrap();
    click(&context, 2, thread, &key, 5).await;
    assert_eq!(context.store.offset().await.unwrap(), 3);
    assert!(context
        .store
        .callback(&key)
        .await
        .unwrap()
        .unwrap()
        .used_by
        .is_none());
    assert!(app.journal_snapshot().await.unwrap().is_empty());
    assert!(api
        .0
        .lock()
        .await
        .sent
        .iter()
        .any(|message| message.text.contains("工作区不在此 Bot 的授权范围内")));
    tokio::fs::remove_file(&allowed).await.unwrap();
    std::os::unix::fs::symlink(&workspace, &allowed).unwrap();
    click(&context, 3, thread, &key, 5).await;
    assert_eq!(app.list(None, None).await.unwrap().sessions.len(), 1);
    assert_eq!(
        context.store.callback(&key).await.unwrap().unwrap().used_by,
        Some(UpdateId::new(3).unwrap())
    );
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn menu_failure_reply_replays_its_frozen_notice_even_if_the_query_would_now_succeed() {
    let root = root();
    let app = app(&root);
    let api = Fake::default();
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    let thread = Some(TopicId::new(101).unwrap());
    api.0
        .lock()
        .await
        .updates
        .push_back(update(1, thread, "/menu models"));
    poll_once(&context).await.unwrap();
    let original = context.store.pending(16).await.unwrap().remove(0);
    execute(&context).await;
    deliver_once(&context).await.unwrap();
    let error_id = crate::domain::NoticeId::new("reply-1").unwrap();
    let menu_id = crate::domain::NoticeId::new("menu-reply-1").unwrap();
    let frozen = app.delivery_payloads().notice(&error_id).await.unwrap();
    assert!(app
        .delivery_payloads()
        .find_notice(&menu_id)
        .await
        .unwrap()
        .is_none());
    let session = created(&app, "/tmp").await;
    context
        .store
        .bind(
            TopicKey {
                chat: ChatId::new(-100).unwrap(),
                thread,
            },
            session,
        )
        .await
        .unwrap();
    // Re-enter the original snapshot to exercise recovery's reply-reuse path.
    // This deterministic replay regression is not process-loss fault coverage.
    super::super::execution::execute_record(&context, &original)
        .await
        .unwrap();
    assert_eq!(
        app.delivery_payloads()
            .notice(&error_id)
            .await
            .unwrap()
            .text,
        frozen.text
    );
    assert!(app
        .delivery_payloads()
        .find_notice(&menu_id)
        .await
        .unwrap()
        .is_none());
    command(&context, 2, thread, "/menu models").await;
    assert!(
        app.delivery_payloads()
            .find_notice(&crate::domain::NoticeId::new("menu-reply-2").unwrap())
            .await
            .unwrap()
            .is_some(),
        "a new query, not replay of the failed receipt, may build the now-valid menu"
    );
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
