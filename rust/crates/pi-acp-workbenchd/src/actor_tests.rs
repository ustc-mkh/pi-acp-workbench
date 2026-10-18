#[cfg(test)]
mod tests {
    use crate::{
        domain::{DomainCommand, DomainEvent, Harness},
        persistence::SessionStore,
        Runtime,
    };
    use std::time::{SystemTime, UNIX_EPOCH};
    fn temp(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "workbenchd-{name}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
    async fn create(runtime: &Runtime) -> crate::domain::SessionId {
        let events = runtime
            .registry
            .command(DomainCommand::CreateSession {
                harness: Harness::Pi,
                cwd: crate::domain::WorkspacePath::new("/tmp").unwrap(),
            })
            .await
            .unwrap();
        match &events[0] {
            DomainEvent::SessionCreated(snapshot) => snapshot.id.clone(),
            _ => panic!("expected creation"),
        }
    }

    #[tokio::test]
    async fn cancelled_worker_epoch_cannot_publish_a_late_crash_before_or_after_replacement() {
        use crate::domain::{command::AgentEvent, Prompt, SessionStatus};
        let root = temp("cancel-epoch");
        let runtime = Runtime::start(SessionStore::fixture(&root), 8);
        let id = create(&runtime).await;
        runtime
            .registry
            .worker_started(id.clone(), 1)
            .await
            .unwrap();
        runtime
            .registry
            .command(DomainCommand::Prompt {
                session: id.clone(),
                prompt: Prompt::new("first").unwrap(),
            })
            .await
            .unwrap();
        runtime
            .registry
            .command(DomainCommand::Cancel {
                session: id.clone(),
            })
            .await
            .unwrap();
        assert!(runtime
            .registry
            .worker_event(
                id.clone(),
                1,
                AgentEvent::Crashed {
                    reason: "late closed".into()
                }
            )
            .await
            .unwrap()
            .is_empty());
        let events = runtime
            .registry
            .command(DomainCommand::Inspect(id.clone()))
            .await
            .unwrap();
        assert!(
            matches!(&events[0], DomainEvent::SessionLoaded(snapshot) if matches!(snapshot.status, SessionStatus::Idle) && snapshot.revision == 2)
        );
        runtime
            .registry
            .worker_started(id.clone(), 2)
            .await
            .unwrap();
        runtime
            .registry
            .command(DomainCommand::Prompt {
                session: id.clone(),
                prompt: Prompt::new("next").unwrap(),
            })
            .await
            .unwrap();
        assert!(runtime
            .registry
            .worker_event(
                id.clone(),
                1,
                AgentEvent::Crashed {
                    reason: "obsolete".into()
                }
            )
            .await
            .unwrap()
            .is_empty());
        let events = runtime
            .registry
            .command(DomainCommand::Inspect(id))
            .await
            .unwrap();
        assert!(
            matches!(&events[0], DomainEvent::SessionLoaded(snapshot) if matches!(snapshot.status, SessionStatus::Running) && snapshot.active_turn.is_some())
        );
        runtime.registry.shutdown().await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn failed_commit_does_not_publish_or_replace_owned_state() {
        let root = temp("failed-commit");
        let store = SessionStore::fixture(&root);
        let runtime = Runtime::start(store.clone(), 8);
        let id = create(&runtime).await;
        // SQLite storage failure must be injected at the executor boundary; renaming the DB root
        // after open correctly does not disconnect its file descriptor.
        store
            .database()
            .set_session_commit_failure(id.clone(), true)
            .await
            .unwrap();
        let result = runtime
            .registry
            .command(DomainCommand::Prompt {
                session: id.clone(),
                prompt: crate::domain::Prompt::new("hello").unwrap(),
            })
            .await;
        assert!(matches!(
            result,
            Err(crate::domain::error::DomainError::Persistence(_))
        ));
        let events = runtime
            .registry
            .command(DomainCommand::Inspect(id.clone()))
            .await
            .unwrap();
        assert!(matches!(&events[0], DomainEvent::SessionLoaded(snapshot)
            if snapshot.revision == 0 && matches!(snapshot.status, crate::domain::SessionStatus::Idle)));
        store
            .database()
            .set_session_commit_failure(id.clone(), false)
            .await
            .unwrap();
        assert!(store
            .load(id.as_str())
            .await
            .unwrap()
            .unwrap()
            .active_turn
            .is_none());

        runtime
            .registry
            .command(DomainCommand::Prompt {
                session: id,
                prompt: crate::domain::Prompt::new("retry").unwrap(),
            })
            .await
            .unwrap();
        runtime.registry.shutdown().await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn durable_cancelling_state_fences_notifications_and_worker_reattachment_until_terminal_commit(
    ) {
        let root = temp("cancelling-fence");
        let runtime = Runtime::start(SessionStore::fixture(&root), 8);
        let id = create(&runtime).await;
        let started = runtime
            .registry
            .command(DomainCommand::Prompt {
                session: id.clone(),
                prompt: crate::domain::Prompt::new("hello").unwrap(),
            })
            .await
            .unwrap();
        let turn = started
            .iter()
            .find_map(|event| match event {
                DomainEvent::TurnStarted { turn, .. } => Some(turn.clone()),
                _ => None,
            })
            .unwrap();
        runtime
            .registry
            .worker_started(id.clone(), 7)
            .await
            .unwrap();
        runtime
            .registry
            .command(DomainCommand::RequestCancel {
                session: id.clone(),
            })
            .await
            .unwrap();
        let cancellation = runtime
            .registry
            .command(DomainCommand::Inspect(id.clone()))
            .await
            .unwrap();
        assert!(
            matches!(&cancellation[0], DomainEvent::SessionLoaded(snapshot) if matches!(snapshot.status, crate::domain::SessionStatus::Cancelling) && snapshot.active_turn.as_ref() == Some(&turn))
        );
        for event in [
            crate::domain::command::AgentEvent::Finished { turn },
            crate::domain::command::AgentEvent::Crashed {
                reason: "late crash".into(),
            },
        ] {
            assert!(runtime
                .registry
                .worker_event(id.clone(), 7, event)
                .await
                .unwrap()
                .is_empty());
        }
        assert!(runtime
            .registry
            .worker_started(id.clone(), 8)
            .await
            .is_err());
        runtime
            .registry
            .command(DomainCommand::Cancel {
                session: id.clone(),
            })
            .await
            .unwrap();
        runtime.registry.worker_started(id, 8).await.unwrap();
        runtime.registry.shutdown().await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn load_does_not_replace_live_owner_and_restart_interrupts_turn() {
        let root = temp("load-owner");
        let store = SessionStore::fixture(&root);
        let runtime = Runtime::start(store.clone(), 8);
        let id = create(&runtime).await;
        runtime
            .registry
            .command(DomainCommand::Prompt {
                session: id.clone(),
                prompt: crate::domain::Prompt::new("hello").unwrap(),
            })
            .await
            .unwrap();
        let events = runtime
            .registry
            .command(DomainCommand::LoadSession(id.clone()))
            .await
            .unwrap();
        assert!(matches!(&events[0], DomainEvent::SessionLoaded(snapshot)
            if matches!(snapshot.status, crate::domain::SessionStatus::Running)));
        let crash_fixture = store.load(id.as_str()).await.unwrap().unwrap();
        runtime.registry.shutdown().await;
        // Preserve the committed running hot fields without rolling back SQL history.
        let mut crash_fixture = crash_fixture;
        crash_fixture.revision = store.load(id.as_str()).await.unwrap().unwrap().revision + 1;
        store.save(&crash_fixture).await.unwrap();
        let restarted = Runtime::start(store.clone(), 8);
        let events = restarted
            .registry
            .command(DomainCommand::LoadSession(id.clone()))
            .await
            .unwrap();
        assert!(matches!(&events[0], DomainEvent::SessionLoaded(snapshot)
            if matches!(snapshot.status, crate::domain::SessionStatus::Failed(_))));
        assert!(store
            .load(id.as_str())
            .await
            .unwrap()
            .unwrap()
            .active_turn
            .is_none());
        restarted.registry.shutdown().await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn removal_is_durable_and_shutdown_rejects_late_commands() {
        let root = temp("remove");
        let store = SessionStore::fixture(&root);
        let runtime = Runtime::start(store.clone(), 8);
        let id = create(&runtime).await;
        runtime
            .registry
            .command(DomainCommand::Prompt {
                session: id.clone(),
                prompt: crate::domain::Prompt::new("hello").unwrap(),
            })
            .await
            .unwrap();
        runtime
            .registry
            .command(DomainCommand::RemoveSession(id.clone()))
            .await
            .unwrap();
        assert!(store.load(id.as_str()).await.unwrap().is_none());
        assert!(runtime
            .registry
            .command(DomainCommand::Inspect(id.clone()))
            .await
            .is_err());
        runtime.registry.shutdown().await;
        assert!(runtime
            .registry
            .command(DomainCommand::LoadSession(id))
            .await
            .is_err());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn list_and_inspect_expose_committed_domain_projection_without_workers() {
        let root = temp("list-state");
        let store = SessionStore::fixture(&root);
        let runtime = Runtime::start(store.clone(), 8);
        let id = create(&runtime).await;
        runtime
            .registry
            .command(DomainCommand::Prompt {
                session: id.clone(),
                prompt: crate::domain::Prompt::new("你好").unwrap(),
            })
            .await
            .unwrap();
        let events = runtime
            .registry
            .command(DomainCommand::Inspect(id.clone()))
            .await
            .unwrap();
        assert!(matches!(&events[0], DomainEvent::SessionLoaded(snapshot)
            if snapshot.transcript.entries.len() == 1 && snapshot.transcript.entries[0].text == "你好"
                && snapshot.revision == 1 && snapshot.active_turn.is_some()));
        runtime.registry.shutdown().await;
        let cold = Runtime::start(store.clone(), 8);
        let events = cold
            .registry
            .command(DomainCommand::ListSessions)
            .await
            .unwrap();
        assert!(matches!(&events[0], DomainEvent::SessionsListed(sessions)
            if sessions.len() == 1 && sessions[0].id == id && sessions[0].transcript.entries.len() == 1));
        let before = serde_json::to_vec(&store.load(id.as_str()).await.unwrap()).unwrap();
        let inspected = cold
            .registry
            .command(DomainCommand::Inspect(id.clone()))
            .await
            .unwrap();
        assert!(
            matches!(&inspected[0], DomainEvent::SessionLoaded(snapshot) if snapshot.id == id && snapshot.transcript.entries.len() == 1)
        );
        assert_eq!(
            serde_json::to_vec(&store.load(id.as_str()).await.unwrap()).unwrap(),
            before
        );
        // Neither listing nor cold inspection starts a mutable session owner.
        assert!(matches!(
            cold.registry
                .command(DomainCommand::Prompt {
                    session: id,
                    prompt: crate::domain::Prompt::new("must load explicitly").unwrap()
                })
                .await,
            Err(crate::domain::error::DomainError::NotFound(_))
        ));
        cold.registry.shutdown().await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn independent_sessions_accept_one_hundred_commands() {
        let root = temp("concurrent-sessions");
        let runtime = Runtime::start(SessionStore::fixture(&root), 128);
        let mut ids = vec![];
        for _ in 0..16 {
            ids.push(create(&runtime).await);
        }
        let mut tasks = tokio::task::JoinSet::new();
        for index in 0..100 {
            let registry = runtime.registry.clone();
            let session = ids[index % ids.len()].clone();
            tasks.spawn(async move {
                registry
                    .command(DomainCommand::SetModel {
                        session,
                        model: crate::domain::ModelId::new(format!("model-{index}")).unwrap(),
                    })
                    .await
            });
        }
        let mut completed = 0;
        while let Some(result) = tasks.join_next().await {
            result.unwrap().unwrap();
            completed += 1;
        }
        assert_eq!(completed, 100);
        let events = runtime
            .registry
            .command(DomainCommand::ListSessions)
            .await
            .unwrap();
        let DomainEvent::SessionsListed(sessions) = &events[0] else {
            panic!("expected list")
        };
        assert_eq!(sessions.len(), 16);
        assert_eq!(sessions.iter().map(|s| s.revision).sum::<u64>(), 100);
        runtime.registry.shutdown().await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn replacement_worker_fences_late_events_and_obsolete_attachments() {
        use crate::domain::command::AgentEvent;
        let root = temp("epoch-fence");
        let runtime = Runtime::start(SessionStore::fixture(&root), 8);
        let id = create(&runtime).await;
        let started = runtime
            .registry
            .command(DomainCommand::Prompt {
                session: id.clone(),
                prompt: crate::domain::Prompt::new("hello").unwrap(),
            })
            .await
            .unwrap();
        let DomainEvent::TurnStarted { turn, .. } = &started[0] else {
            panic!("expected turn")
        };
        runtime
            .registry
            .worker_started(id.clone(), 10)
            .await
            .unwrap();
        runtime
            .registry
            .worker_started(id.clone(), 11)
            .await
            .unwrap();
        assert!(runtime
            .registry
            .worker_started(id.clone(), 10)
            .await
            .is_err());
        for event in [
            AgentEvent::Text {
                turn: turn.clone(),
                text: "stale".into(),
                message: None,
            },
            AgentEvent::Crashed {
                reason: "old EOF".into(),
            },
        ] {
            assert!(runtime
                .registry
                .worker_event(id.clone(), 10, event)
                .await
                .unwrap()
                .is_empty());
        }
        runtime
            .registry
            .worker_event(
                id.clone(),
                11,
                AgentEvent::Text {
                    turn: turn.clone(),
                    text: "current".into(),
                    message: None,
                },
            )
            .await
            .unwrap();
        let events = runtime
            .registry
            .command(DomainCommand::Inspect(id))
            .await
            .unwrap();
        assert!(matches!(&events[0], DomainEvent::SessionLoaded(snapshot)
            if snapshot.transcript.entries.len() == 2
                && snapshot.transcript.entries[1].text == "current"
                && matches!(snapshot.status, crate::domain::SessionStatus::Running)));
        runtime.registry.shutdown().await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn checked_shutdown_commits_cancellation_and_reports_failed_final_write() {
        let root = temp("shutdown-commit");
        let store = SessionStore::fixture(&root);
        let runtime = Runtime::start(store.clone(), 8);
        let id = create(&runtime).await;
        runtime
            .registry
            .command(DomainCommand::Prompt {
                session: id.clone(),
                prompt: crate::domain::Prompt::new("hello").unwrap(),
            })
            .await
            .unwrap();
        runtime.registry.shutdown_checked().await.unwrap();
        let final_state = store.load(id.as_str()).await.unwrap().unwrap();
        assert!(final_state.active_turn.is_none());
        assert!(matches!(
            final_state.status,
            crate::domain::SessionStatus::Idle
        ));
        let runtime = Runtime::start(store.clone(), 8);
        runtime
            .registry
            .command(DomainCommand::LoadSession(id.clone()))
            .await
            .unwrap();
        runtime
            .registry
            .command(DomainCommand::Prompt {
                session: id.clone(),
                prompt: crate::domain::Prompt::new("second").unwrap(),
            })
            .await
            .unwrap();
        store
            .database()
            .set_session_commit_failure(id, true)
            .await
            .unwrap();
        assert!(matches!(
            runtime.registry.shutdown_checked().await,
            Err(crate::domain::error::DomainError::Persistence(_))
        ));
        store.payloads.shutdown().await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn registry_owns_session_and_routes_commands() {
        let root = temp("route");
        let runtime = Runtime::start(SessionStore::fixture(&root), 4);
        let events = runtime
            .registry
            .command(DomainCommand::CreateSession {
                harness: Harness::Pi,
                cwd: crate::domain::WorkspacePath::new("/tmp").unwrap(),
            })
            .await
            .unwrap();
        let id = match &events[0] {
            DomainEvent::SessionCreated(snapshot) => snapshot.id.clone(),
            _ => panic!("expected creation"),
        };
        let prompt = crate::domain::ids::Prompt::new("hello").unwrap();
        let events = runtime
            .registry
            .command(DomainCommand::Prompt {
                session: id,
                prompt,
            })
            .await
            .unwrap();
        assert!(events
            .iter()
            .any(|event| matches!(event, DomainEvent::TurnStarted { .. })));
        runtime.registry.shutdown().await;
        let _ = tokio::fs::remove_dir_all(root).await;
    }
    #[tokio::test]
    async fn agent_events_update_owned_state() {
        let root = temp("agent");
        let runtime = Runtime::start(SessionStore::fixture(&root), 4);
        let events = runtime
            .registry
            .command(DomainCommand::CreateSession {
                harness: Harness::Pi,
                cwd: crate::domain::WorkspacePath::new("/tmp").unwrap(),
            })
            .await
            .unwrap();
        let id = match &events[0] {
            DomainEvent::SessionCreated(snapshot) => snapshot.id.clone(),
            _ => panic!("expected creation"),
        };
        let prompt = crate::domain::ids::Prompt::new("hello").unwrap();
        let started = runtime
            .registry
            .command(DomainCommand::Prompt {
                session: id.clone(),
                prompt,
            })
            .await
            .unwrap();
        let turn = match &started[0] {
            DomainEvent::TurnStarted { turn, .. } => turn.clone(),
            _ => panic!("expected turn"),
        };
        let events = runtime
            .registry
            .command(DomainCommand::Agent {
                session: id,
                event: crate::domain::command::AgentEvent::Text {
                    turn,
                    text: "world".into(),
                    message: None,
                },
            })
            .await
            .unwrap();
        assert!(matches!(&events[0],DomainEvent::AgentText{text,..} if text=="world"));
        runtime.registry.shutdown().await;
        let _ = tokio::fs::remove_dir_all(root).await;
    }
}
