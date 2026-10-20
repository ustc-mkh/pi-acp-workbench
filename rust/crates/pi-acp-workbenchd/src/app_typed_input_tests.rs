use super::*;
use crate::domain::ids::PromptPart;

#[tokio::test]
async fn cold_typed_settings_are_observed_before_first_prompt_and_only_success_seeds_defaults() {
    let root = std::env::temp_dir().join(format!("wb-p2-settings-{}", uuid::Uuid::new_v4()));
    let env = std::collections::HashMap::from([
        ("WORKBENCH_CONTRACT_TYPED_SETTINGS".into(), "1".into()),
        ("WORKBENCH_CONTRACT_REJECT_MODEL".into(), "high".into()),
    ]);
    let app = app_at_with_env(&root, env);
    let id = create(&app).await;
    let set = |name: &str, value: &str| DomainCommand::SetOption {
        session: id.clone(),
        id: name.into(),
        value: value.into(),
    };
    assert!(app
        .command_durable(
            crate::domain::OperationId::generate(),
            set("thought_level", "high")
        )
        .await
        .is_err());
    assert!(inspect_view(&app, &id).await.config.options.is_empty());
    let fresh = create(&app).await;
    assert!(inspect_view(&app, &fresh).await.config.options.is_empty());
    app.shutdown().await;

    let app = app_at_with_env(
        &root,
        std::collections::HashMap::from([("WORKBENCH_CONTRACT_TYPED_SETTINGS".into(), "1".into())]),
    );
    let operation = crate::domain::OperationId::generate();
    let command = set("thought_level", "high");
    app.command_durable(operation.clone(), command.clone())
        .await
        .unwrap();
    let view = inspect_view(&app, &id).await;
    assert_eq!(view.last_entry_seq.get(), 0);
    assert_eq!(view.config.options.get("thought_level").unwrap(), "high");
    assert_eq!(
        view.catalogue
            .selects
            .iter()
            .find(|s| s.id == "thought_level")
            .unwrap()
            .current_value,
        "high"
    );
    app.command_durable(crate::domain::OperationId::generate(), set("fast", "on"))
        .await
        .unwrap();
    let fresh = create(&app).await;
    let config = inspect_view(&app, &fresh).await.config;
    assert_eq!(config.options.get("thought_level").unwrap(), "high");
    assert!(!config.options.contains_key("fast"));
    let mut events = app.subscribe();
    prompt(&app, &fresh, "first task").await;
    wait_finished(&mut events).await;
    assert_eq!(
        inspect_view(&app, &fresh)
            .await
            .catalogue
            .selects
            .iter()
            .find(|s| s.id == "thought_level")
            .unwrap()
            .current_value,
        "high"
    );
    app.shutdown().await;
    let app = app_at_with_env(
        &root,
        std::collections::HashMap::from([("WORKBENCH_CONTRACT_TYPED_SETTINGS".into(), "1".into())]),
    );
    app.command_durable(operation, command).await.unwrap();
    assert!(app.core.coordinator.adapters.lock().await.is_empty());
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

fn input_image() -> crate::domain::image::ImageAsset {
    let image = image::DynamicImage::new_rgb8(2, 2);
    let mut bytes = std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    crate::domain::image::ImageAsset::new(crate::domain::image::ImageMime::Png, bytes.into_inner())
        .unwrap()
}

#[tokio::test]
async fn typed_context_and_images_archive_in_order_and_unsupported_peer_rejects_before_acceptance()
{
    let root = std::env::temp_dir().join(format!("wb-p2-input-{}", uuid::Uuid::new_v4()));
    let trace = root.join("trace.ndjson");
    let app = app_at_with_env(
        &root,
        std::collections::HashMap::from([(
            "WORKBENCH_CONTRACT_TRACE".into(),
            trace.to_string_lossy().into_owned(),
        )]),
    );
    let id = create(&app).await;
    let asset = input_image();
    let command = DomainCommand::Prompt {
        session: id.clone(),
        prompt: crate::domain::Prompt::from_parts(vec![
            PromptPart::Text {
                text: "look".into(),
            },
            PromptPart::Context {
                id: "selection".into(),
                name: "src/a.rs:1-2".into(),
                text: "chosen only".into(),
            },
            PromptPart::Image {
                asset: asset.clone(),
            },
        ])
        .unwrap(),
    };
    let mut events = app.subscribe();
    let operation = crate::domain::OperationId::generate();
    app.command_durable(operation.clone(), command.clone())
        .await
        .unwrap();
    wait_finished(&mut events).await;
    let records = tokio::fs::read_to_string(&trace).await.unwrap();
    assert!(records.contains("workbench-context:selection"));
    assert!(records.contains("\"type\":\"image\""));
    let count = inspect_view(&app, &id).await.last_entry_seq;
    assert!(count.get() >= 3);
    app.command_durable(operation, command).await.unwrap();
    assert_eq!(inspect_view(&app, &id).await.last_entry_seq, count);
    assert_eq!(
        app.image(asset.image()).await.unwrap().bytes(),
        asset.bytes()
    );
    app.shutdown().await;
    let app = app_at_with_env(
        &root,
        std::collections::HashMap::from([("WORKBENCH_CONTRACT_NO_IMAGE".into(), "1".into())]),
    );
    let fresh = create(&app).await;
    let command = DomainCommand::Prompt {
        session: fresh.clone(),
        prompt: crate::domain::Prompt::from_parts(vec![PromptPart::Image { asset }]).unwrap(),
    };
    assert!(app
        .command_durable(crate::domain::OperationId::generate(), command)
        .await
        .is_err());
    assert_eq!(inspect_view(&app, &fresh).await.last_entry_seq.get(), 0);
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
