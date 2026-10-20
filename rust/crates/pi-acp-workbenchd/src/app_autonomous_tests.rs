use super::*;
use crate::domain::interaction::{InteractionAnswer, InteractionResponse};

#[tokio::test]
async fn autonomous_wake_permission_usage_history_cancel_and_cold_reopen() {
    let root = std::env::temp_dir().join(format!("wb-p3-{}", uuid::Uuid::new_v4()));
    let gate = root.join("wake");
    let app = app_at_with_env(
        &root,
        std::collections::HashMap::from([
            ("WORKBENCH_CONTRACT_AUTONOMOUS".into(), "1".into()),
            (
                "WORKBENCH_CONTRACT_WAKE_GATE".into(),
                gate.to_string_lossy().into_owned(),
            ),
        ]),
    );
    let id = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &id, "autonomous-arm").await;
    wait_finished(&mut events).await;
    tokio::fs::write(&gate, "first").await.unwrap();
    let interaction = wait_interaction(&mut events).await;
    let view = inspect_view(&app, &id).await;
    let background = view.active_turn.clone().unwrap();
    assert!(!app.core.coordinator.adapters.lock().await[&id]
        .background_safe
        .load(Ordering::Acquire));
    let revision = view.revision;
    assert!(matches!(
        app.command(DomainCommand::Prompt {
            session: id.clone(),
            prompt: Prompt::new("must remain a draft").unwrap(),
        })
        .await,
        Err(DomainError::Busy)
    ));
    assert_eq!(inspect_view(&app, &id).await.revision, revision);
    app.command(DomainCommand::AnswerInteraction {
        session: id.clone(),
        answer: InteractionAnswer {
            interaction: interaction.id,
            response: InteractionResponse::Text("yes".into()),
        },
    })
    .await
    .unwrap();
    wait_finished(&mut events).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if events
                .recv()
                .await
                .unwrap()
                .view
                .is_some_and(|v| v.usage.context_used == Some(123))
            {
                break;
            }
        }
    })
    .await
    .unwrap();
    let view = inspect_view(&app, &id).await;
    assert_eq!(view.usage.context_used, Some(123));
    assert_eq!((view.usage.input_tokens, view.usage.output_tokens), (7, 11));
    let diff = app
        .core
        .database
        .turn_diff(id.clone(), background.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        diff.status,
        crate::workspace_review::DiffStatus::Unavailable
    );
    let text = history_text(&app, &id).await;
    assert!(text.iter().any(|s| s == "autonomous complete"));
    assert!(!text.iter().any(|s| s.contains("stale autonomous")
        || s.contains("must remain")
        || s.contains("unlabelled idle")));
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    let totals: (i64, i64, i64) = sql.query_row(
        "SELECT count(*),sum(input),sum(output) FROM usage_facts WHERE session=?1 AND input IS NOT NULL",
        [id.as_str()], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap();
    assert_eq!(totals, (2, 8, 13));
    drop(sql);
    let deliveries = app.delivery_store().pending(0, 32).await.unwrap();
    assert!(deliveries.iter().any(|d| matches!(&d.event.payload,
        crate::persistence::outbox::DeliveryPayload::Turn { turn, .. } if turn == &background)));
    tokio::fs::write(&gate, "second").await.unwrap();
    wait_interaction(&mut events).await;
    assert_ne!(inspect_view(&app, &id).await.active_turn, Some(background));
    app.command(DomainCommand::Cancel {
        session: id.clone(),
    })
    .await
    .unwrap();
    assert!(inspect_view(&app, &id).await.active_turn.is_none());
    let saved = history_text(&app, &id).await;
    app.shutdown().await;
    let app = app_at(&root);
    assert_eq!(history_text(&app, &id).await, saved);
    assert!(app.core.coordinator.adapters.lock().await.is_empty());
    let mut events = app.subscribe();
    prompt(&app, &id, "explicit continue").await;
    wait_finished(&mut events).await;
    let revision = inspect_view(&app, &id).await.revision;
    app.command_durable(
        crate::domain::OperationId::generate(),
        DomainCommand::Cancel {
            session: id.clone(),
        },
    )
    .await
    .unwrap();
    assert!(app.core.coordinator.adapters.lock().await.is_empty());
    assert_eq!(inspect_view(&app, &id).await.revision, revision);
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn autonomous_last_mile_rejection_keeps_a_distinct_turn_and_does_not_kill_the_wake() {
    let root = std::env::temp_dir().join(format!("wb-p3-race-{}", uuid::Uuid::new_v4()));
    let app = app_at_with_env(
        &root,
        std::collections::HashMap::from([("WORKBENCH_CONTRACT_AUTONOMOUS".into(), "1".into())]),
    );
    let id = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &id, "autonomous-race").await;
    let interaction = wait_interaction(&mut events).await;
    let turn = inspect_view(&app, &id).await.active_turn.unwrap();
    let QueryResult::History(history) = app
        .query(QueryCommand::History {
            session: id.clone(),
            cursor: None,
            limit: Some(200),
        })
        .await
        .unwrap()
    else {
        panic!("history")
    };
    let rejected = history
        .entries
        .iter()
        .find(|e| {
            e.message
                .as_ref()
                .is_some_and(|id| id.as_str() == "pi-workbench-input-rejected")
        })
        .unwrap();
    assert_ne!(rejected.turn, turn);
    app.command(DomainCommand::AnswerInteraction {
        session: id.clone(),
        answer: InteractionAnswer {
            interaction: interaction.id,
            response: InteractionResponse::Text("yes".into()),
        },
    })
    .await
    .unwrap();
    wait_finished(&mut events).await;
    assert_eq!(inspect_view(&app, &id).await.usage.output_tokens, 11);
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
