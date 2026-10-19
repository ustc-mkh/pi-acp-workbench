use super::*;

#[tokio::test]
async fn full_session_mailbox_returns_backpressure_without_waiting() {
    let id = SessionId::generate();
    let (sender, _receiver) = mpsc::channel(1);
    let (done, _wait) = oneshot::channel();
    sender
        .try_send(SessionCommand::Shutdown(done))
        .unwrap_or_else(|_| panic!("empty mailbox"));
    let sessions = BTreeMap::from([(id.clone(), sender)]);
    let (reply, wait) = oneshot::channel();
    forward(
        DomainCommand::Inspect(id.clone()),
        None,
        &id,
        reply,
        &sessions,
    );
    assert!(matches!(
        wait.await.unwrap(),
        Err(DomainError::Backpressure)
    ));
}

#[tokio::test]
async fn closed_session_mailbox_reports_missing_actor() {
    let id = SessionId::generate();
    let (sender, receiver) = mpsc::channel(1);
    drop(receiver);
    let sessions = BTreeMap::from([(id.clone(), sender)]);
    let (reply, wait) = oneshot::channel();
    forward(
        DomainCommand::Inspect(id.clone()),
        None,
        &id,
        reply,
        &sessions,
    );
    assert!(matches!(wait.await.unwrap(), Err(DomainError::NotFound(missing)) if missing == id));
}

#[tokio::test]
async fn full_registry_mailbox_returns_backpressure_without_waiting() {
    let (sender, _receiver) = mpsc::channel(1);
    let (reply, _wait) = oneshot::channel();
    sender
        .try_send(RegistryCommand::Shutdown(reply))
        .unwrap_or_else(|_| panic!("empty mailbox"));
    let registry = RegistryHandle { tx: sender };
    assert!(matches!(
        registry.command(DomainCommand::ListSessions).await,
        Err(DomainError::Backpressure)
    ));
}
