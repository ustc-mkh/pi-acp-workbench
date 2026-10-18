use super::fork_tests::{inspect, native_config, setup};
use super::*;
use crate::domain::{fork::ForkRequest, OperationId};
use tokio::sync::Notify;
fn fork(source: &SessionId, snapshot: &crate::domain::session::SessionSnapshot) -> DomainCommand {
    DomainCommand::Fork {
        session: source.clone(),
        request: ForkRequest {
            entry: snapshot.transcript.entries[0].id.clone(),
        },
    }
}
async fn marker(path: &std::path::Path) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}
fn gated(root: &std::path::Path) -> Config {
    let mut config = native_config(root);
    config.workers.pi.as_mut().unwrap().env.extend([
        (
            "WORKBENCH_CONTRACT_FORK_GATE".into(),
            root.join("fork-gate").to_string_lossy().into_owned(),
        ),
        (
            "WORKBENCH_CONTRACT_TRACE".into(),
            root.join("trace.ndjson").to_string_lossy().into_owned(),
        ),
    ]);
    config
}
#[tokio::test]
async fn queued_fork_cancellation_bypasses_a_saturated_lane_without_touching_its_source_and_is_durable(
) {
    let root = std::env::temp_dir().join(format!(
        "workbench-fork-queued-cancel-{}",
        uuid::Uuid::new_v4()
    ));
    let app = WorkbenchApp::new(native_config(&root)).unwrap();
    let source = setup(&app).await;
    let before = inspect(&app, &source).await;
    let release = Arc::new(Notify::new());
    let gate = release.clone();
    app.ingress
        .submit(Request::Test {
            lane: Some(source.clone()),
            pool: 0,
            job: Box::pin(async move { gate.notified().await }),
        })
        .unwrap();
    let operation = OperationId::generate();
    let command = fork(&source, &before);
    let ticket = app
        .enqueue_command(Some(operation.clone()), command.clone())
        .unwrap();
    for _ in 0..62 {
        app.ingress
            .submit(Request::Test {
                lane: Some(source.clone()),
                pool: 0,
                job: Box::pin(async {}),
            })
            .unwrap();
    }
    let cancel_id = OperationId::generate();
    let cancel = DomainCommand::CancelFork {
        session: source.clone(),
        operation: operation.clone(),
    };
    let cancelled = tokio::time::timeout(
        Duration::from_secs(3),
        app.command_durable(cancel_id.clone(), cancel.clone()),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        matches!(&cancelled[..], [DomainEvent::ForkCancelled { session, operation: target }] if session == &source && target == &operation)
    );
    assert!(matches!(
        ticket.wait().await,
        Err(DomainError::ForkCancelled)
    ));
    assert_eq!(
        serde_json::to_vec(&before).unwrap(),
        serde_json::to_vec(&inspect(&app, &source).await).unwrap()
    );
    assert_eq!(
        app.core.adapters.lock().await.len(),
        1,
        "queued cancellation must not stop another source workflow"
    );
    release.notify_one();
    app.shutdown_checked().await.unwrap();
    let app = WorkbenchApp::new(native_config(&root)).unwrap();
    assert!(matches!(
        app.command_durable(operation, command).await,
        Err(DomainError::ForkCancelled)
    ));
    let replay = app.command_durable(cancel_id, cancel).await.unwrap();
    assert_eq!(
        serde_json::to_vec(&replay).unwrap(),
        serde_json::to_vec(&cancelled).unwrap()
    );
    assert!(app.core.adapters.lock().await.is_empty());
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn active_fork_cancellation_is_exactly_scoped_flushes_joins_and_preserves_uncertain_failure()
{
    let root = std::env::temp_dir().join(format!(
        "workbench-fork-active-cancel-{}",
        uuid::Uuid::new_v4()
    ));
    let app = WorkbenchApp::new(gated(&root)).unwrap();
    let source = setup(&app).await;
    let before = inspect(&app, &source).await;
    let operation = OperationId::generate();
    let command = fork(&source, &before);
    let ticket = app
        .enqueue_command(Some(operation.clone()), command.clone())
        .unwrap();
    marker(&root.join("fork-gate.started")).await;
    assert!(matches!(
        app.command(DomainCommand::CancelFork {
            session: SessionId::generate(),
            operation: operation.clone()
        })
        .await,
        Err(DomainError::NoActiveFork)
    ));
    assert!(matches!(
        app.command(DomainCommand::CancelFork {
            session: source.clone(),
            operation: OperationId::generate()
        })
        .await,
        Err(DomainError::NoActiveFork)
    ));
    // A dropped duplicate observer still owns a bounded accepted lease. Its
    // cancelled queued execution must settle without waiting behind the fork.
    drop(
        app.enqueue_command(Some(operation.clone()), command.clone())
            .unwrap(),
    );
    let cancel_id = OperationId::generate();
    let cancel = DomainCommand::CancelFork {
        session: source.clone(),
        operation: operation.clone(),
    };
    assert!(matches!(
        tokio::time::timeout(
            Duration::from_secs(3),
            app.command_durable(cancel_id.clone(), cancel.clone())
        )
        .await
        .unwrap(),
        Err(DomainError::NativeForkUncertain)
    ));
    assert!(matches!(
        ticket.wait().await,
        Err(DomainError::NativeForkUncertain)
    ));
    assert!(app.core.adapters.lock().await.is_empty());
    assert_eq!(
        serde_json::to_vec(&before).unwrap(),
        serde_json::to_vec(&inspect(&app, &source).await).unwrap()
    );
    #[derive(serde::Deserialize)]
    struct Trace {
        method: String,
        #[serde(default)]
        pid: Option<i32>,
    }
    let records: Vec<Trace> = tokio::fs::read_to_string(root.join("trace.ndjson"))
        .await
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        records
            .iter()
            .filter(|record| record.method == "_pi_workbench/cancel_fork")
            .count(),
        1,
        "typed cancellation must reach the peer before process exit"
    );
    assert_eq!(
        records
            .iter()
            .filter(|record| record.method == "_pi_workbench/fork")
            .count(),
        1
    );
    for record in records.iter().filter(|record| record.method == "boot") {
        assert_eq!(unsafe { libc::kill(record.pid.unwrap(), 0) }, -1);
    }
    let mut events = app.subscribe();
    prompt(&app, &source, "permission").await;
    wait_interaction(&mut events).await;
    assert!(matches!(
        app.command_durable(operation, command).await,
        Err(DomainError::NativeForkUncertain)
    ));
    assert!(matches!(
        app.command_durable(cancel_id, cancel).await,
        Err(DomainError::NativeForkUncertain)
    ));
    assert!(
        inspect(&app, &source).await.active_turn.is_some(),
        "old cancellation replay must not stop a new prompt"
    );
    app.command(DomainCommand::Cancel { session: source })
        .await
        .unwrap();
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn cancel_admission_persistence_failure_cannot_touch_the_remote_fork() {
    let root = std::env::temp_dir().join(format!(
        "workbench-fork-cancel-persistence-{}",
        uuid::Uuid::new_v4()
    ));
    let app = WorkbenchApp::new(gated(&root)).unwrap();
    let source = setup(&app).await;
    let before = inspect(&app, &source).await;
    let operation = OperationId::generate();
    let ticket = app
        .enqueue_command(Some(operation.clone()), fork(&source, &before))
        .unwrap();
    marker(&root.join("fork-gate.started")).await;
    let cancel_id = OperationId::generate();
    tokio::fs::write(
        root.join("journal").join(format!("{cancel_id}.json")),
        b"fixture corruption",
    )
    .await
    .unwrap();
    assert!(matches!(
        app.command_durable(
            cancel_id,
            DomainCommand::CancelFork {
                session: source,
                operation
            }
        )
        .await,
        Err(DomainError::Persistence(_))
    ));
    assert!(!tokio::fs::read_to_string(root.join("trace.ndjson"))
        .await
        .unwrap()
        .contains("_pi_workbench/cancel_fork"));
    tokio::fs::write(root.join("fork-gate.release"), b"release")
        .await
        .unwrap();
    assert!(matches!(
        ticket.wait().await.unwrap().as_slice(),
        [DomainEvent::SessionCreated(_)]
    ));
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn shutdown_of_a_cancelled_queued_fork_seals_the_original_operation_before_lease_release() {
    let root = std::env::temp_dir().join(format!(
        "workbench-fork-cancel-shutdown-{}",
        uuid::Uuid::new_v4()
    ));
    let app = WorkbenchApp::new(native_config(&root)).unwrap();
    let source = setup(&app).await;
    let before = inspect(&app, &source).await;
    let release = Arc::new(Notify::new());
    let gate = release.clone();
    app.ingress
        .submit(Request::Test {
            lane: Some(source.clone()),
            pool: 0,
            job: Box::pin(async move { gate.notified().await }),
        })
        .unwrap();
    let operation = OperationId::generate();
    let command = fork(&source, &before);
    let ticket = app
        .enqueue_command(Some(operation.clone()), command.clone())
        .unwrap();
    let cancel = {
        let app = app.clone();
        let source = source.clone();
        let operation = operation.clone();
        tokio::spawn(async move {
            app.command(DomainCommand::CancelFork {
                session: source,
                operation,
            })
            .await
        })
    };
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if app
                .core
                .fork_controls
                .get(&source, &operation)
                .is_ok_and(|control| control.stop.is_cancelled())
                || cancel.is_finished()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    app.close_admission();
    release.notify_one();
    app.shutdown_checked().await.unwrap();
    let _ = ticket.wait().await;
    assert!(cancel.await.unwrap().is_ok());
    let app = WorkbenchApp::new(native_config(&root)).unwrap();
    assert!(matches!(
        app.command_durable(operation, command).await,
        Err(DomainError::ForkCancelled)
    ));
    assert!(app.core.adapters.lock().await.is_empty());
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
