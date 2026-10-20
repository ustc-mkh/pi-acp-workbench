use super::*;
#[tokio::test]
async fn inspect_and_list_are_bounded_cold_queries_without_broadcasting_echoes() {
    let (app, root) = app();
    let session = create(&app).await;
    let mut events = app.subscribe();
    for _ in 0..25 {
        assert_eq!(inspect_view(&app, &session).await.id, session);
        assert_eq!(app.list(None, None).await.unwrap().sessions.len(), 1);
        let QueryResult::Attached(attached) = app
            .query(QueryCommand::Attach {
                session: session.clone(),
            })
            .await
            .unwrap()
        else {
            panic!("attach query");
        };
        assert_eq!(attached.view.id, session);
        assert!(attached.recent_page.entries.is_empty());
    }
    assert!(matches!(
        events.try_recv(),
        Err(broadcast::error::TryRecvError::Empty)
    ));
    app.command(DomainCommand::LoadSession(session.clone()))
        .await
        .unwrap();
    // Unchanged hot loads must not manufacture revisions or event echoes.
    assert!(matches!(
        events.try_recv(),
        Err(broadcast::error::TryRecvError::Empty)
    ));
    assert_eq!(inspect_view(&app, &session).await.revision.get(), 0);
    assert!(app.core.coordinator.adapters.lock().await.is_empty());
    app.shutdown().await;
    std::fs::remove_dir_all(root).unwrap();
}
