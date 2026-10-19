use super::fork_tests::inspect;
use super::*;
use crate::domain::image::ImageMime;
#[tokio::test]
async fn agent_images_are_archived_before_metadata_events_and_survive_restart_and_source_removal() {
    let root = std::env::temp_dir().join(format!("workbench-agent-image-{}", uuid::Uuid::new_v4()));
    let config = config_at(&root, Default::default());
    let app = WorkbenchApp::new(config.clone()).unwrap();
    let id = create(&app).await;
    let mut images = app.subscribe();
    let mut finished = app.subscribe();
    prompt(&app, &id, "image-output").await;
    let (entry, image, message) = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let batch = images.recv().await.unwrap();
            if let Some(entry) = batch
                .entries
                .into_iter()
                .find(|entry| entry.image.is_some())
            {
                break (entry.id, entry.image.unwrap(), entry.message);
            }
        }
    })
    .await
    .unwrap();
    // Publication is after archive AND state commit, before turn completion.
    let bytes = app
        .delivery_payloads()
        .image(&image)
        .await
        .unwrap()
        .bytes()
        .to_vec();
    assert_eq!(image.mime(), ImageMime::Png);
    wait_finished(&mut finished).await;
    let before = inspect(&app, &id).await;
    assert_eq!(before.transcript.entries.len(), 3);
    let row = before
        .transcript
        .entries
        .iter()
        .find(|row| row.id == entry)
        .unwrap();
    assert_eq!(row.image.as_ref(), Some(&image));
    assert!(row.text.is_empty());
    assert_eq!(row.message, before.transcript.entries[2].message);
    assert_eq!(row.message, message);
    assert_eq!(
        app.delivery_payloads().entry(&entry).await.unwrap().image,
        Some(image.clone())
    );
    let snapshot = serde_json::to_vec(&before.transcript).unwrap();
    assert!(!String::from_utf8_lossy(&snapshot).contains("iVBOR"));
    assert!(!String::from_utf8_lossy(&snapshot).contains("never-fetch"));
    app.shutdown_checked().await.unwrap();
    let app = WorkbenchApp::new(config).unwrap();
    assert_eq!(
        serde_json::to_vec(&inspect(&app, &id).await.transcript).unwrap(),
        snapshot
    );
    assert!(app.core.adapters.lock().await.is_empty());
    assert_eq!(
        app.delivery_payloads().image(&image).await.unwrap().bytes(),
        bytes
    );
    app.command(DomainCommand::RemoveSession(id)).await.unwrap();
    assert_eq!(
        app.delivery_payloads().image(&image).await.unwrap().bytes(),
        bytes
    );
    assert_eq!(
        app.delivery_payloads().entry(&entry).await.unwrap().image,
        Some(image)
    );
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn image_query_is_read_only_validates_full_reference_and_corruption_and_never_starts_a_provider(
) {
    use crate::domain::image::{ImageAsset, ImageRef};
    let root = std::env::temp_dir().join(format!("workbench-image-query-{}", uuid::Uuid::new_v4()));
    let app = WorkbenchApp::new(config_at(&root, Default::default())).unwrap();
    let asset = ImageAsset::from_base64("image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=").unwrap();
    app.delivery_payloads().put_image(&asset).await.unwrap();
    let journal = app.journal_snapshot().await.unwrap();
    assert_eq!(
        app.image(asset.image()).await.unwrap().bytes(),
        asset.bytes()
    );
    let mut wrong = serde_json::to_value(asset.image()).unwrap();
    wrong["sha256"] = "0".repeat(64).into();
    let wrong: ImageRef = serde_json::from_value(wrong).unwrap();
    assert!(
        matches!(app.image(&wrong).await, Err(DomainError::Persistence(message)) if message == "image payload identity mismatch")
    );
    app.core
        .database
        .corrupt_image(asset.image().id().clone())
        .await
        .unwrap();
    assert!(matches!(
        app.image(asset.image()).await,
        Err(DomainError::Persistence(_))
    ));
    assert!(app.core.adapters.lock().await.is_empty());
    assert_eq!(app.journal_snapshot().await.unwrap(), journal);
    app.close_admission();
    assert!(matches!(
        app.image(asset.image()).await,
        Err(DomainError::Worker(_))
    ));
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn image_queries_use_bounded_query_reserve_instead_of_session_mutation_slots() {
    use crate::domain::image::ImageAsset;
    let root = std::env::temp_dir().join(format!(
        "workbench-image-query-pool-{}",
        uuid::Uuid::new_v4()
    ));
    let app = WorkbenchApp::new(config_at(&root, Default::default())).unwrap();
    let asset = ImageAsset::from_base64("image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=").unwrap();
    app.delivery_payloads().put_image(&asset).await.unwrap();
    let gate = std::sync::Arc::new(tokio::sync::Notify::new());
    let (starts, mut started) = tokio::sync::mpsc::channel(16);
    for _ in 0..16 {
        let gate = gate.clone();
        let starts = starts.clone();
        app.ingress
            .submit(super::super::ingress::Request::Test {
                lane: None,
                pool: 2,
                job: Box::pin(async move {
                    starts.send(()).await.unwrap();
                    gate.notified().await;
                }),
            })
            .unwrap();
    }
    for _ in 0..16 {
        started.recv().await.unwrap();
    }
    assert!(matches!(
        app.image(asset.image()).await,
        Err(DomainError::Backpressure)
    ));
    gate.notify_waiters();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match app.image(asset.image()).await {
                Ok(image) => {
                    assert_eq!(image.bytes(), asset.bytes());
                    break;
                }
                Err(DomainError::Backpressure) => tokio::task::yield_now().await,
                other => panic!("{other:?}"),
            }
        }
    })
    .await
    .unwrap();
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn malformed_agent_image_fails_the_turn_without_publishing_a_reference_and_replacement_can_prompt(
) {
    let root =
        std::env::temp_dir().join(format!("workbench-invalid-image-{}", uuid::Uuid::new_v4()));
    let app = WorkbenchApp::new(config_at(&root, Default::default())).unwrap();
    let id = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &id, "image-malformed").await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let batch = events.recv().await.unwrap();
            assert!(
                batch.entries.iter().all(|entry| entry.image.is_none()),
                "invalid image reference was published"
            );
            if batch
                .view
                .is_some_and(|view| matches!(view.status, SessionStatus::Failed(_)))
            {
                break;
            }
        }
    })
    .await
    .unwrap();
    let failed = inspect(&app, &id).await;
    assert!(failed
        .transcript
        .entries
        .iter()
        .all(|row| row.image.is_none()));
    assert!(failed.active_turn.is_none());
    prompt(&app, &id, "after invalid image").await;
    wait_finished(&mut events).await;
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
