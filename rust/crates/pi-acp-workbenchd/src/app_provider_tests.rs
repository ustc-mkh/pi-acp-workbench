use super::*;

fn config(root: &std::path::Path) -> Config {
    let peer = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/contract-agent.mjs");
    let launch = |name: &str| WorkerConfig {
        command: "node".into(),
        args: vec![peer.to_string_lossy().into_owned(), name.into()],
        env: std::collections::HashMap::from([("WORKBENCH_CONTRACT_PROVIDER".into(), name.into())]),
    };
    let mut codex = launch("codex");
    codex.command = "/bin/sh".into();
    codex.args.splice(
        0..0,
        [
            "-c".into(),
            "exec node \"$@\"".into(),
            "provider-shell".into(),
        ],
    );
    Config {
        workers: WorkersConfig {
            pi: Some(launch("pi")),
            codex: Some(codex),
            claude: Some(launch("claude")),
        },
        sessions: SessionsConfig {
            mailbox: 128,
            max_workers: 3,
        },
        telegram: None,
        storage: StorageConfig { root: root.into() },
        limits: LimitsConfig {
            pending_interactions: 1,
        },
    }
}
async fn inspect(app: &WorkbenchApp, id: &SessionId) -> crate::domain::session::SessionSnapshot {
    let events = app
        .command(DomainCommand::Inspect(id.clone()))
        .await
        .unwrap();
    let DomainEvent::SessionLoaded(snapshot) = &events[0] else {
        panic!("inspect")
    };
    snapshot.clone()
}

#[tokio::test]
async fn standard_tool_details_for_three_synthetic_profiles_are_committed_and_cold_restart_preserves_patches(
) {
    use crate::domain::{
        tool::{ToolContent, ToolKind, ToolStatus},
        ToolCallId,
    };
    let root =
        std::env::temp_dir().join(format!("workbench-tool-details-{}", uuid::Uuid::new_v4()));
    let app = WorkbenchApp::new(config(&root)).unwrap();
    let mut saved = Vec::new();
    let mut events = app.subscribe();
    for harness in [Harness::Pi, Harness::Codex, Harness::Claude] {
        let created = app
            .command(DomainCommand::CreateSession {
                harness,
                cwd: WorkspacePath::new("/tmp").unwrap(),
            })
            .await
            .unwrap();
        let DomainEvent::SessionCreated(session) = &created[0] else {
            panic!("created")
        };
        prompt(&app, &session.id, "tool-metadata").await;
        wait_finished(&mut events).await;
        let snapshot = inspect(&app, &session.id).await;
        let tools = snapshot.transcript.tools.values().next().unwrap();
        let edit = &tools[&ToolCallId::new("tool:edit").unwrap()];
        assert_eq!(edit.status, ToolStatus::Completed);
        assert_eq!(edit.details.kind, Some(ToolKind::Edit));
        assert_eq!(edit.details.name.as_deref(), Some("apply_patch"));
        assert_eq!(edit.details.locations[0].line, Some(0));
        assert!(
            matches!(&edit.details.content[0], ToolContent::Diff { old_text: Some(old), new_text, .. } if old == "before" && new_text == "after")
        );
        let clear = &tools[&ToolCallId::new("tool:clear").unwrap()];
        assert_eq!(clear.details.kind, Some(ToolKind::Read));
        assert!(clear.details.content.is_empty() && clear.details.locations.is_empty());
        let serialized = serde_json::to_vec(&snapshot.transcript).unwrap();
        assert!(!String::from_utf8_lossy(&serialized).contains("NOT_IN_DOMAIN"));
        saved.push((session.id.clone(), serialized));
    }
    app.shutdown_checked().await.unwrap();
    let app = WorkbenchApp::new(config(&root)).unwrap();
    for (id, expected) in saved {
        assert_eq!(
            serde_json::to_vec(&inspect(&app, &id).await.transcript).unwrap(),
            expected
        );
    }
    assert!(
        app.core.adapters.lock().await.is_empty(),
        "cold metadata inspect must not launch workers"
    );
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn app_routes_each_harness_to_its_launch_and_disabled_harness_is_inspectable_but_never_prompted(
) {
    let root = std::env::temp_dir().join(format!("workbench-providers-{}", uuid::Uuid::new_v4()));
    let first = WorkbenchApp::new(config(&root)).unwrap();
    let mut ids = Vec::new();
    let mut events = first.subscribe();
    for (harness, name) in [
        (Harness::Pi, "pi"),
        (Harness::Codex, "codex"),
        (Harness::Claude, "claude"),
    ] {
        let created = first
            .command(DomainCommand::CreateSession {
                harness: harness.clone(),
                cwd: WorkspacePath::new("/tmp").unwrap(),
            })
            .await
            .unwrap();
        let DomainEvent::SessionCreated(snapshot) = &created[0] else {
            panic!("create")
        };
        let id = snapshot.id.clone();
        prompt(&first, &id, "worker-profile").await;
        wait_finished(&mut events).await;
        let snapshot = inspect(&first, &id).await;
        assert_eq!(snapshot.harness, harness);
        assert!(snapshot
            .transcript
            .entries
            .iter()
            .any(|entry| entry.text == format!("{name}:{name}")));
        ids.push(id);
    }
    first.shutdown().await;
    let mut disabled = config(&root);
    disabled.workers.codex = None;
    let second = WorkbenchApp::new(disabled).unwrap();
    second
        .command(DomainCommand::LoadSession(ids[1].clone()))
        .await
        .unwrap();
    let before = inspect(&second, &ids[1]).await;
    assert!(matches!(
        second
            .command(DomainCommand::Prompt {
                session: ids[1].clone(),
                prompt: Prompt::new("must not execute").unwrap()
            })
            .await,
        Err(DomainError::ProviderNotConfigured)
    ));
    let after = inspect(&second, &ids[1]).await;
    assert_eq!(after.revision, before.revision);
    assert_eq!(
        after.transcript.entries.len(),
        before.transcript.entries.len()
    );
    assert!(matches!(
        second
            .command(DomainCommand::CreateSession {
                harness: Harness::Codex,
                cwd: WorkspacePath::new("/tmp").unwrap()
            })
            .await,
        Err(DomainError::ProviderNotConfigured)
    ));
    let listed = second.command(DomainCommand::ListSessions).await.unwrap();
    assert!(matches!(&listed[0], DomainEvent::SessionsListed(sessions) if sessions.len() == 3));
    second.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn all_three_synthetic_profiles_cover_plan_usage_permission_forms_cancel_crash_and_native_restart(
) {
    use crate::domain::{
        interaction::{FieldValue, InteractionAnswer, InteractionResponse},
        plan::PlanStatus,
    };
    let root = std::env::temp_dir().join(format!(
        "workbench-provider-lifecycle-{}",
        uuid::Uuid::new_v4()
    ));
    let mut config = config(&root);
    for (name, launch) in [
        ("pi", config.workers.pi.as_mut().unwrap()),
        ("codex", config.workers.codex.as_mut().unwrap()),
        ("claude", config.workers.claude.as_mut().unwrap()),
    ] {
        launch.env.insert(
            "WORKBENCH_CONTRACT_TRACE".into(),
            root.join(format!("{name}.ndjson"))
                .to_string_lossy()
                .into_owned(),
        );
        launch.env.insert(
            "HOME".into(),
            root.join("isolated-home").to_string_lossy().into_owned(),
        );
    }
    let app = WorkbenchApp::new(config.clone()).unwrap();
    let mut events = app.subscribe();
    let mut saved = vec![];
    for (harness, name) in [
        (Harness::Pi, "pi"),
        (Harness::Codex, "codex"),
        (Harness::Claude, "claude"),
    ] {
        let created = app
            .command(DomainCommand::CreateSession {
                harness: harness.clone(),
                cwd: WorkspacePath::new("/tmp").unwrap(),
            })
            .await
            .unwrap();
        let DomainEvent::SessionCreated(session) = &created[0] else {
            panic!("create {name}")
        };
        let id = session.id.clone();
        for text in ["worker-profile", "plan-report", "usage-report"] {
            prompt(&app, &id, text).await;
            wait_finished(&mut events).await;
        }
        let snapshot = inspect(&app, &id).await;
        assert_eq!(snapshot.harness, harness);
        assert!(snapshot
            .transcript
            .entries
            .iter()
            .any(|entry| entry.text == format!("{name}:{name}")));
        assert!(matches!(
            snapshot.plan.items[0].status,
            PlanStatus::Completed
        ));
        assert!(matches!(
            snapshot.plan.items[1].status,
            PlanStatus::InProgress
        ));
        assert_eq!(
            (snapshot.usage.input_tokens, snapshot.usage.output_tokens),
            (100, 20)
        );
        assert_eq!(
            (snapshot.usage.context_used, snapshot.usage.context_size),
            (Some(500), Some(200_000))
        );
        let native = snapshot.provider_session.clone();
        assert!(native.is_some());
        prompt(&app, &id, "permission").await;
        let permission = wait_interaction(&mut events).await;
        assert!(app
            .command(DomainCommand::AnswerInteraction {
                session: id.clone(),
                answer: InteractionAnswer {
                    interaction: permission.id.clone(),
                    response: InteractionResponse::Permission {
                        option: "not-offered".into()
                    }
                }
            })
            .await
            .is_err());
        assert!(inspect(&app, &id)
            .await
            .pending_interactions
            .contains_key(&permission.id));
        app.command(DomainCommand::AnswerInteraction {
            session: id.clone(),
            answer: InteractionAnswer {
                interaction: permission.id,
                response: InteractionResponse::Permission {
                    option: "yes".into(),
                },
            },
        })
        .await
        .unwrap();
        wait_finished(&mut events).await;
        prompt(&app, &id, "elicitation-multi").await;
        let form = wait_interaction(&mut events).await;
        app.command(DomainCommand::AnswerInteraction {
            session: id.clone(),
            answer: InteractionAnswer {
                interaction: form.id,
                response: InteractionResponse::Form {
                    fields: std::collections::BTreeMap::from([
                        (
                            "question_0".into(),
                            FieldValue::Selected(vec!["a:b".into(), "其它".into()]),
                        ),
                        (
                            "question_1".into(),
                            FieldValue::Text(format!("{name} 世界")),
                        ),
                    ]),
                },
            },
        })
        .await
        .unwrap();
        wait_finished(&mut events).await;
        assert!(inspect(&app, &id)
            .await
            .transcript
            .entries
            .iter()
            .any(|entry| entry.text.contains(&format!("{name} 世界"))));
        prompt(&app, &id, "permission").await;
        wait_interaction(&mut events).await;
        app.command(DomainCommand::Cancel {
            session: id.clone(),
        })
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if matches!(events.recv().await.unwrap(), DomainEvent::TurnCancelled { session, .. } if session == id) { break; }
            }
        }).await.unwrap();
        let cancelled = inspect(&app, &id).await;
        assert!(matches!(cancelled.status, SessionStatus::Idle));
        assert!(cancelled.pending_interactions.is_empty() && cancelled.active_turn.is_none());
        assert_eq!(cancelled.provider_session, native);
        prompt(&app, &id, "after cancel").await;
        wait_finished(&mut events).await;
        prompt(&app, &id, "crash").await;
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if matches!(events.recv().await.unwrap(), DomainEvent::SessionError { session, .. } if session == id) { break; }
            }
        }).await.unwrap();
        assert!(matches!(
            inspect(&app, &id).await.status,
            SessionStatus::Failed(_)
        ));
        prompt(&app, &id, "after crash").await;
        wait_finished(&mut events).await;
        let recovered = inspect(&app, &id).await;
        assert_eq!(recovered.provider_session, native);
        assert!(matches!(recovered.status, SessionStatus::Idle));
        assert!(recovered.pending_interactions.is_empty());
        saved.push((id, name, recovered));
    }
    app.shutdown_checked().await.unwrap();
    let app = WorkbenchApp::new(config).unwrap();
    let mut events = app.subscribe();
    for (id, name, expected) in &saved {
        let trace_path = root.join(format!("{name}.ndjson"));
        let trace = tokio::fs::read(&trace_path).await.unwrap();
        let cold = inspect(&app, id).await;
        assert_eq!(
            serde_json::to_vec(&cold).unwrap(),
            serde_json::to_vec(expected).unwrap()
        );
        app.command(DomainCommand::LoadSession(id.clone()))
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read(trace_path).await.unwrap(),
            trace,
            "cold inspect/load must not boot {name}"
        );
    }
    assert!(app.core.adapters.lock().await.is_empty());
    for (id, name, expected) in saved {
        prompt(&app, &id, "worker-profile").await;
        wait_finished(&mut events).await;
        let after = inspect(&app, &id).await;
        assert_eq!(after.provider_session, expected.provider_session);
        assert_eq!(
            after.transcript.entries.len(),
            expected.transcript.entries.len() + 2
        );
        assert_eq!(
            after.transcript.entries.last().unwrap().text,
            format!("{name}:{name}")
        );
        assert_eq!(after.usage.input_tokens, 100);
        // A typed trace confirms native load, not session/new or text reseeding.
        #[derive(serde::Deserialize)]
        struct Trace {
            method: String,
            #[serde(default, rename = "sessionId")]
            native: Option<crate::domain::ProviderSessionId>,
        }
        let records: Vec<Trace> = tokio::fs::read_to_string(root.join(format!("{name}.ndjson")))
            .await
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(records.iter().any(
            |record| record.method == "session/load" && record.native == after.provider_session
        ));
    }
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn configured_interaction_limit_is_enforced_before_exposing_excess_provider_requests() {
    let root =
        std::env::temp_dir().join(format!("workbench-provider-limit-{}", uuid::Uuid::new_v4()));
    let app = WorkbenchApp::new(config(&root)).unwrap();
    let id = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &id, "permission-over-limit").await;
    let count = tokio::time::timeout(Duration::from_secs(5), async {
        let mut count = 0;
        loop {
            match events.recv().await.unwrap() {
                DomainEvent::InteractionRequested { .. } => count += 1,
                DomainEvent::SessionError { .. } => break count,
                DomainEvent::TurnFinished { .. } => panic!("limit must fail closed"),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(count, 1);
    let failed = inspect(&app, &id).await;
    assert!(matches!(failed.status, SessionStatus::Failed(_)));
    assert!(failed.pending_interactions.is_empty());
    prompt(&app, &id, "worker-profile").await;
    wait_finished(&mut events).await;
    assert_eq!(
        inspect(&app, &id).await.provider_session,
        failed.provider_session
    );
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
