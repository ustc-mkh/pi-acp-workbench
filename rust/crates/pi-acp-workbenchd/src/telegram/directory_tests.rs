use super::*;
use crate::telegram::directories;
use std::collections::HashMap;
#[tokio::test]
async fn directory_navigation_rejects_retargeted_paths_and_rebound_topic_before_reading_new_names()
{
    let root = root();
    let app = app(&root);
    let workspace = root.join("workspace");
    let target = workspace.join("target");
    let other = workspace.join("other");
    let outside = root.join("outside");
    for directory in [
        &target,
        &other.join("do-not-open"),
        &outside.join("do-not-open"),
    ] {
        tokio::fs::create_dir_all(directory).await.unwrap();
    }
    let mut cfg = config();
    cfg.workspace = path(&workspace);
    let api = Fake::default();
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), cfg)
        .await
        .unwrap();
    let mut id = 1;
    for destination in [&other, &outside] {
        command(&context, id, None, "/menu directories").await;
        let selected = key(&context, "Directory: target").await;
        let saved = workspace.join("saved");
        tokio::fs::rename(&target, &saved).await.unwrap();
        std::os::unix::fs::symlink(destination, &target).unwrap();
        click(&context, id + 1, None, &selected, 5).await;
        assert!(app
            .delivery_payloads()
            .find_notice(&crate::domain::NoticeId::new(format!("menu-reply-{}", id + 1)).unwrap())
            .await
            .unwrap()
            .is_none());
        assert!(!api
            .0
            .lock()
            .await
            .sent
            .iter()
            .any(|message| message.text.contains("do-not-open")));
        tokio::fs::remove_file(&target).await.unwrap();
        tokio::fs::rename(saved, &target).await.unwrap();
        id += 2;
    }
    assert!(app.journal_snapshot().await.unwrap().is_empty());
    command(&context, id, None, "/menu directories").await;
    let stale = key(&context, "Directory: target").await;
    let session = created(&app, workspace.to_str().unwrap()).await;
    context
        .store
        .bind(
            TopicKey {
                chat: ChatId::new(-100).unwrap(),
                thread: None,
            },
            session,
        )
        .await
        .unwrap();
    let journal = app.journal_snapshot().await.unwrap();
    click(&context, id + 1, None, &stale, 5).await;
    assert!(context
        .store
        .callback(&stale)
        .await
        .unwrap()
        .unwrap()
        .used_by
        .is_none());
    assert_eq!(app.journal_snapshot().await.unwrap(), journal);
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

fn path(value: &std::path::Path) -> WorkspacePath {
    WorkspacePath::new(value.to_str().unwrap()).unwrap()
}
async fn key(context: &Context<Fake>, label: &str) -> CallbackKey {
    choices(context)
        .await
        .into_iter()
        .find(|(name, _, _)| name == label)
        .unwrap_or_else(|| panic!("missing {label}"))
        .1
}

#[tokio::test]
async fn directory_menu_pages_selects_unicode_path_and_harness_then_creates_once_after_restart() {
    let root = root();
    let trace = root.join("trace");
    let env = HashMap::from([(
        "WORKBENCH_CONTRACT_TRACE".into(),
        trace.to_string_lossy().into_owned(),
    )]);
    let first = app_with_env(&root, env.clone());
    let workspace = root.join("workspace");
    tokio::fs::create_dir_all(&workspace).await.unwrap();
    for index in 0..13 {
        tokio::fs::create_dir(workspace.join(format!("d{index:02}")))
            .await
            .unwrap();
    }
    let selected = workspace.join("d12/项目 😀");
    tokio::fs::create_dir(&selected).await.unwrap();
    tokio::fs::create_dir(workspace.join(".private"))
        .await
        .unwrap();
    let outside = root.join("outside");
    tokio::fs::create_dir_all(outside.join("never-show"))
        .await
        .unwrap();
    std::os::unix::fs::symlink(&outside, workspace.join("external-link")).unwrap();
    std::os::unix::fs::symlink(workspace.join("d12"), workspace.join("internal-link")).unwrap();
    tokio::fs::write(workspace.join("binary-file"), [0xff, 0xfe])
        .await
        .unwrap();
    let mut cfg = config();
    cfg.workspace = path(&workspace);
    let api = Fake::default();
    let context = Context::new(
        first.clone(),
        api.clone(),
        &root.join("telegram"),
        cfg.clone(),
    )
    .await
    .unwrap();
    command(&context, 1, None, "/menu directories").await;
    let first_page = choices(&context).await;
    assert_eq!(
        first_page
            .iter()
            .filter(|(name, _, _)| name.starts_with("Directory:"))
            .count(),
        10
    );
    assert!(!first_page
        .iter()
        .any(|(name, _, _)| name == "Parent directory"));
    assert!(!first_page.iter().any(|(name, _, _)| name.contains("link")
        || name.contains("private")
        || name.contains("binary")));
    click(
        &context,
        2,
        None,
        &key(&context, "Next directories").await,
        5,
    )
    .await;
    assert_eq!(
        choices(&context)
            .await
            .iter()
            .filter(|(name, _, _)| name.starts_with("Directory:"))
            .count(),
        3
    );
    click(&context, 3, None, &key(&context, "Directory: d12").await, 5).await;
    assert!(choices(&context)
        .await
        .iter()
        .any(|(name, _, _)| name == "Parent directory"));
    click(
        &context,
        4,
        None,
        &key(&context, "Directory: 项目 😀").await,
        5,
    )
    .await;
    click(
        &context,
        5,
        None,
        &key(&context, "Use this directory").await,
        5,
    )
    .await;
    let harnesses = choices(&context).await;
    assert!(!harnesses
        .iter()
        .any(|(name, _, _)| name == "New Codex" || name == "New Claude"));
    let new = harnesses.into_iter().find(|(_, _, command)| matches!(command, ControlCommand::NewSession { cwd, harness: Harness::Pi, create_topic: true } if cwd == &path(&selected))).unwrap().1;
    assert!(!trace.exists());
    assert!(first.journal_snapshot().await.unwrap().is_empty());
    first.shutdown_checked().await.unwrap();
    let second = app_with_env(&root, env);
    let context = Context::new(second.clone(), api.clone(), &root.join("telegram"), cfg)
        .await
        .unwrap();
    click(&context, 6, None, &new, 5).await;
    let destination = TopicKey {
        chat: ChatId::new(-100).unwrap(),
        thread: Some(TopicId::new(101).unwrap()),
    };
    let session = context.store.binding(&destination).await.unwrap().unwrap();
    let snapshot = context.inspect(&session).await.unwrap().unwrap();
    assert_eq!(snapshot.cwd, path(&selected));
    assert!(snapshot.provider_session.is_none());
    click(&context, 7, None, &new, 5).await;
    assert_eq!(api.0.lock().await.topics, 1);
    assert_eq!(second.list(None, None).await.unwrap().sessions.len(), 1);
    command(
        &context,
        8,
        None,
        &format!("/new pi {}", selected.display()),
    )
    .await;
    let sessions = second.list(None, None).await.unwrap().sessions;
    assert_eq!(sessions.len(), 2);
    assert!(sessions
        .iter()
        .all(|summary| summary.cwd == path(&selected)));
    assert!(
        !trace.exists(),
        "browsing and creating must stay cold, including after restart"
    );
    second.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn directory_new_rejects_escape_before_admission_and_internal_retarget_before_execution() {
    let root = root();
    let app = app(&root);
    let workspace = root.join("workspace");
    let target = workspace.join("target");
    let other = workspace.join("other");
    let outside = root.join("outside");
    for directory in [&target, &other, &outside] {
        tokio::fs::create_dir_all(directory).await.unwrap();
    }
    let mut cfg = config();
    cfg.workspace = path(&workspace);
    let api = Fake::default();
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), cfg)
        .await
        .unwrap();
    command(&context, 1, None, "/menu directories").await;
    click(
        &context,
        2,
        None,
        &key(&context, "Directory: target").await,
        5,
    )
    .await;
    click(
        &context,
        3,
        None,
        &key(&context, "Use this directory").await,
        5,
    )
    .await;
    let new = key(&context, "New Pi").await;
    let saved = workspace.join("saved");
    tokio::fs::rename(&target, &saved).await.unwrap();
    std::os::unix::fs::symlink(&outside, &target).unwrap();
    click(&context, 4, None, &new, 5).await;
    assert!(context
        .store
        .callback(&new)
        .await
        .unwrap()
        .unwrap()
        .used_by
        .is_none());
    assert!(app.journal_snapshot().await.unwrap().is_empty());
    assert_eq!(api.0.lock().await.topics, 0);
    tokio::fs::remove_file(&target).await.unwrap();
    tokio::fs::rename(&saved, &target).await.unwrap();
    api.0.lock().await.updates.push_back(WireUpdate {
        update_id: UpdateId::new(5).unwrap(),
        message: None,
        callback_query: Some(WireCallback {
            id: "directory-5".into(),
            from: user(false),
            message: Some(message(5, None, None)),
            data: Some(new.as_str().into()),
        }),
    });
    poll_once(&context).await.unwrap();
    assert_eq!(
        context.store.callback(&new).await.unwrap().unwrap().used_by,
        Some(UpdateId::new(5).unwrap())
    );
    tokio::fs::rename(&target, &saved).await.unwrap();
    std::os::unix::fs::symlink(&other, &target).unwrap();
    execute(&context).await;
    deliver_once(&context).await.unwrap();
    assert!(
        app.journal_snapshot().await.unwrap().is_empty(),
        "a different canonical cwd must not reach create/topic side effects"
    );
    assert_eq!(api.0.lock().await.topics, 0);
    assert!(app.list(None, None).await.unwrap().sessions.is_empty());
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn directory_scan_budget_counts_ignored_entries_and_never_fakes_complete_listing() {
    let root = root();
    let app = app(&root);
    let workspace = root.join("workspace");
    tokio::fs::create_dir_all(workspace.join("visible"))
        .await
        .unwrap();
    for index in 1..directories::MAX_ENTRIES {
        tokio::fs::write(workspace.join(format!(".ignored-{index}")), [])
            .await
            .unwrap();
    }
    let page = directories::list(path(&workspace), None, 10).await.unwrap();
    assert_eq!(page.names, ["visible"]);
    assert!(!page.too_large);
    tokio::fs::write(workspace.join("overflow"), [])
        .await
        .unwrap();
    let page = directories::list(path(&workspace), None, 10).await.unwrap();
    assert!(page.too_large);
    assert!(page.names.is_empty() && page.next.is_none());
    let mut cfg = config();
    cfg.workspace = path(&workspace);
    let api = Fake::default();
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), cfg)
        .await
        .unwrap();
    command(&context, 1, None, "/menu directories").await;
    assert!(api.0.lock().await.sent.iter().any(|message| message
        .text
        .contains("listing omitted, not a complete page")));
    assert!(choices(&context)
        .await
        .iter()
        .any(|(name, _, _)| name == "Use this directory"));
    assert!(!choices(&context)
        .await
        .iter()
        .any(|(name, _, _)| name == "Next directories" || name.starts_with("Directory:")));
    assert!(app.journal_snapshot().await.unwrap().is_empty());
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn directory_reader_refuses_symlink_cwd_and_omits_non_utf8_hidden_and_file_entries() {
    use std::os::unix::ffi::OsStringExt;
    let root = root();
    tokio::fs::create_dir_all(root.join("visible"))
        .await
        .unwrap();
    tokio::fs::create_dir(root.join(".hidden")).await.unwrap();
    tokio::fs::create_dir(root.join(std::ffi::OsString::from_vec(vec![0xff])))
        .await
        .unwrap();
    tokio::fs::write(root.join("file"), [0xff]).await.unwrap();
    std::os::unix::fs::symlink(root.join("visible"), root.join("link")).unwrap();
    assert_eq!(
        directories::list(path(&root), None, 10)
            .await
            .unwrap()
            .names,
        ["visible"]
    );
    assert!(directories::list(path(&root.join("link")), None, 10)
        .await
        .is_err());
    tokio::fs::remove_dir_all(root).await.unwrap();
}
