use super::*;

#[tokio::test]
async fn local_admission_has_no_started_window_and_receipt_only_commit_is_atomic() {
    let mut fixture = Fixture::new().await;
    let operation = OperationId::generate();
    let command = DomainCommand::SetModel {
        session: SessionId::generate(),
        model: crate::domain::ModelId::new("default").unwrap(),
    };
    let Admission::Execute(ticket) = fixture
        .store()
        .admit_local(operation.clone(), &command)
        .await
        .unwrap()
    else {
        panic!("local ticket")
    };
    assert!(matches!(
        fixture.store().status(operation.clone()).await.unwrap(),
        crate::domain::query::OperationStatus::Unknown
    ));
    // Lost observer / restart before commit is not an uncertain remote effect.
    fixture.restart().await;
    assert!(matches!(
        fixture
            .store()
            .admit_local(operation.clone(), &command)
            .await
            .unwrap(),
        Admission::Execute(_)
    ));
    let receipt = CommandReceipt::Accepted {
        session: SessionId::generate(),
        revision: crate::domain::query::SafeInteger::new(0).unwrap(),
    };
    let db = Connection::open(fixture.path()).unwrap();
    db.execute_batch("CREATE TRIGGER reject_local_receipt BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END;").unwrap();
    assert!(fixture
        .store()
        .finish(ticket.clone(), &Ok(receipt.clone()))
        .await
        .is_err());
    assert!(
        matches!(
            fixture.store().status(operation.clone()).await.unwrap(),
            crate::domain::query::OperationStatus::Unknown
        ),
        "insert and receipt update must roll back together"
    );
    db.execute_batch("DROP TRIGGER reject_local_receipt")
        .unwrap();
    fixture
        .store()
        .finish(ticket, &Ok(receipt.clone()))
        .await
        .unwrap();
    fixture.restart().await;
    let Admission::Replay(replay) = fixture
        .store()
        .admit_local(operation.clone(), &command)
        .await
        .unwrap()
    else {
        panic!("terminal replay")
    };
    assert_eq!(
        serde_json::to_value(replay.unwrap()).unwrap(),
        serde_json::to_value(receipt).unwrap()
    );
    assert_eq!(stored(&fixture.path(), &operation).0, "Completed");
    fixture.close().await;
}
