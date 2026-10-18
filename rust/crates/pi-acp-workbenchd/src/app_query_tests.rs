use super::*;
use crate::domain::OperationId;

#[tokio::test]
async fn inspect_and_list_return_snapshots_without_broadcasting_query_echoes() {
    let (app, root) = app();
    let session = create(&app).await;
    let mut events = app.subscribe();
    for _ in 0..25 {
        let inspected = app
            .command(DomainCommand::Inspect(session.clone()))
            .await
            .unwrap();
        assert!(
            matches!(&inspected[0], DomainEvent::SessionLoaded(snapshot) if snapshot.id == session)
        );
        let listed = app.command(DomainCommand::ListSessions).await.unwrap();
        assert!(
            matches!(&listed[0], DomainEvent::SessionsListed(snapshots) if snapshots.len() == 1)
        );
    }
    assert!(matches!(
        events.try_recv(),
        Err(broadcast::error::TryRecvError::Empty)
    ));
    // Explicit durable query semantics do not turn its response into a change.
    app.command_durable(
        OperationId::generate(),
        DomainCommand::Inspect(session.clone()),
    )
    .await
    .unwrap();
    assert!(matches!(
        events.try_recv(),
        Err(broadcast::error::TryRecvError::Empty)
    ));
    app.command(DomainCommand::LoadSession(session.clone()))
        .await
        .unwrap();
    assert!(
        matches!(events.recv().await.unwrap(), DomainEvent::SessionLoaded(snapshot) if snapshot.id == session)
    );
    app.shutdown().await;
    std::fs::remove_dir_all(root).unwrap();
}
