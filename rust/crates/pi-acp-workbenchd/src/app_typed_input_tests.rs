use super::*;
use crate::domain::ids::PromptPart;

#[tokio::test]
async fn withdrawn_setting_cannot_block_model_or_thinking_repairs_after_reconnect() {
    for model_first in [false, true] {
        let root =
            std::env::temp_dir().join(format!("wb-withdrawn-settings-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let levels = root.join("levels.json");
        let hidden = root.join("hidden.json");
        tokio::fs::write(&levels, r#"["low","high"]"#)
            .await
            .unwrap();
        tokio::fs::write(&hidden, "[]").await.unwrap();
        let env = std::collections::HashMap::from([
            ("WORKBENCH_CONTRACT_TYPED_SETTINGS".into(), "1".into()),
            (
                "WORKBENCH_CONTRACT_THINKING_LEVELS_FILE".into(),
                levels.to_string_lossy().into_owned(),
            ),
            (
                "WORKBENCH_CONTRACT_HIDDEN_SETTINGS_FILE".into(),
                hidden.to_string_lossy().into_owned(),
            ),
        ]);
        let app = app_at_with_env(&root.join("data"), env.clone());
        let id = create(&app).await;
        for (name, value) in [("thought_level", "high"), ("fast", "on")] {
            app.command(DomainCommand::SetOption {
                session: id.clone(),
                id: name.into(),
                value: value.into(),
            })
            .await
            .unwrap();
        }
        app.command(DomainCommand::ReleaseWorker {
            session: id.clone(),
        })
        .await
        .unwrap();
        app.shutdown().await;
        // Use a fresh host as well as a fresh worker: no cached owner or
        // catalogue can be responsible for the error or the successful repair.
        tokio::fs::write(&levels, r#"["low"]"#).await.unwrap();
        tokio::fs::write(&hidden, r#"["fast"]"#).await.unwrap();
        let mut env = env;
        let thinking_id = if model_first {
            "thinking"
        } else {
            "thought_level"
        };
        env.insert("WORKBENCH_CONTRACT_THINKING_ID".into(), thinking_id.into());
        let app = app_at_with_env(&root.join("data"), env);
        assert!(app.discover_session(id.clone()).await.is_err());
        let before = inspect_view(&app, &id).await;
        assert_eq!(before.config.options.get("fast").unwrap(), "on");
        // An explicitly invalid selection still fails and must not silently
        // persist cleanup of unrelated preferences.
        assert!(app
            .command(DomainCommand::SetOption {
                session: id.clone(),
                id: thinking_id.into(),
                value: "high".into(),
            })
            .await
            .is_err());
        assert_eq!(inspect_view(&app, &id).await.config, before.config);
        let model = DomainCommand::SetModel {
            session: id.clone(),
            model: crate::domain::ModelId::new("other").unwrap(),
        };
        let thinking = DomainCommand::SetOption {
            session: id.clone(),
            id: thinking_id.into(),
            value: "low".into(),
        };
        let commands = if model_first {
            [model, thinking]
        } else {
            [thinking, model]
        };
        for command in commands {
            app.command(command).await.unwrap();
        }
        let repaired = inspect_view(&app, &id).await;
        assert_eq!(repaired.config.options.get(thinking_id).unwrap(), "low");
        assert!(!repaired.config.options.contains_key("fast"));
        assert_eq!(repaired.catalogue.current_model.unwrap().as_str(), "other");
        app.command(DomainCommand::ReleaseWorker {
            session: id.clone(),
        })
        .await
        .unwrap();
        app.discover_session(id.clone()).await.unwrap();
        // Repaired defaults must not keep propagating a withdrawn setting ID
        // into every subsequent new session.
        let fresh = create(&app).await;
        let defaults = inspect_view(&app, &fresh).await.config;
        assert_eq!(defaults.options.len(), 1);
        assert_eq!(defaults.options.get(thinking_id).unwrap(), "low");
        app.discover_session(fresh).await.unwrap();
        app.shutdown().await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}

#[tokio::test]
async fn unsupported_saved_thinking_can_be_corrected_after_worker_release() {
    let root = std::env::temp_dir().join(format!("wb-stale-thinking-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&root).await.unwrap();
    let levels = root.join("thinking-levels.json");
    tokio::fs::write(&levels, r#"["low","high"]"#)
        .await
        .unwrap();
    let app = app_at_with_env(
        &root.join("data"),
        std::collections::HashMap::from([
            ("WORKBENCH_CONTRACT_TYPED_SETTINGS".into(), "1".into()),
            (
                "WORKBENCH_CONTRACT_THINKING_LEVELS_FILE".into(),
                levels.to_string_lossy().into_owned(),
            ),
        ]),
    );
    let id = create(&app).await;
    app.command(DomainCommand::SetOption {
        session: id.clone(),
        id: "thought_level".into(),
        value: "high".into(),
    })
    .await
    .unwrap();
    app.command(DomainCommand::ReleaseWorker {
        session: id.clone(),
    })
    .await
    .unwrap();
    // The next worker no longer offers the persisted preference. Reconnecting
    // must not erase it, but an explicit supported replacement must be usable.
    tokio::fs::write(&levels, r#"["low"]"#).await.unwrap();
    assert!(app.discover_session(id.clone()).await.is_err());
    let stale = inspect_view(&app, &id).await;
    assert_eq!(stale.config.options.get("thought_level").unwrap(), "high");
    app.command(DomainCommand::SetOption {
        session: id.clone(),
        id: "thought_level".into(),
        value: "low".into(),
    })
    .await
    .unwrap();
    app.command(DomainCommand::SetModel {
        session: id.clone(),
        model: crate::domain::ModelId::new("other").unwrap(),
    })
    .await
    .unwrap();
    app.command(DomainCommand::ReleaseWorker {
        session: id.clone(),
    })
    .await
    .unwrap();
    app.discover_session(id.clone()).await.unwrap();
    let recovered = inspect_view(&app, &id).await;
    assert_eq!(
        recovered.config.options.get("thought_level").unwrap(),
        "low"
    );
    assert_eq!(recovered.catalogue.current_model.unwrap().as_str(), "other");
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn discovery_validates_inherited_thinking_after_switching_to_saved_model() {
    let root = std::env::temp_dir().join(format!("wb-dependent-settings-{}", uuid::Uuid::new_v4()));
    let app = app_at_with_env(
        &root,
        std::collections::HashMap::from([
            ("WORKBENCH_CONTRACT_TYPED_SETTINGS".into(), "1".into()),
            ("WORKBENCH_CONTRACT_DEPENDENT_THINKING".into(), "1".into()),
        ]),
    );
    let original = create(&app).await;
    app.command(DomainCommand::SetModel {
        session: original.clone(),
        model: crate::domain::ModelId::new("other").unwrap(),
    })
    .await
    .unwrap();
    app.command(DomainCommand::SetOption {
        session: original,
        id: "thought_level".into(),
        value: "high".into(),
    })
    .await
    .unwrap();
    let fresh = create(&app).await;
    app.discover_session(fresh.clone()).await.unwrap();
    let after = inspect_view(&app, &fresh).await;
    assert_eq!(after.catalogue.current_model.unwrap().as_str(), "other");
    assert_eq!(
        after
            .catalogue
            .selects
            .iter()
            .find(|s| s.id == "thought_level")
            .unwrap()
            .current_value,
        "high"
    );
    // Deferring validation must still reject values the target model does not
    // support, and recovery must leave the session configurable afterwards.
    assert!(app
        .command(DomainCommand::SetModel {
            session: fresh.clone(),
            model: crate::domain::ModelId::new("default").unwrap(),
        })
        .await
        .is_err());
    assert_eq!(
        inspect_view(&app, &fresh)
            .await
            .config
            .model
            .unwrap()
            .as_str(),
        "other"
    );
    app.command(DomainCommand::SetOption {
        session: fresh.clone(),
        id: "thought_level".into(),
        value: "low".into(),
    })
    .await
    .unwrap();
    app.command(DomainCommand::SetModel {
        session: fresh.clone(),
        model: crate::domain::ModelId::new("default").unwrap(),
    })
    .await
    .unwrap();
    assert_eq!(
        inspect_view(&app, &fresh)
            .await
            .catalogue
            .current_model
            .unwrap()
            .as_str(),
        "default"
    );
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn inherited_thinking_allows_cold_model_change_and_discovery() {
    let root = std::env::temp_dir().join(format!("wb-inherited-settings-{}", uuid::Uuid::new_v4()));
    let app = app_at_with_env(
        &root,
        std::collections::HashMap::from([("WORKBENCH_CONTRACT_TYPED_SETTINGS".into(), "1".into())]),
    );
    let original = create(&app).await;
    app.command(DomainCommand::SetOption {
        session: original,
        id: "thought_level".into(),
        value: "high".into(),
    })
    .await
    .unwrap();
    let fresh = create(&app).await;
    let before = inspect_view(&app, &fresh).await;
    assert_eq!(before.config.options.get("thought_level").unwrap(), "high");
    assert!(before.catalogue.selects.is_empty());
    app.command(DomainCommand::SetModel {
        session: fresh.clone(),
        model: crate::domain::ModelId::new("other").unwrap(),
    })
    .await
    .unwrap();
    app.discover_session(fresh.clone()).await.unwrap();
    app.command(DomainCommand::SetOption {
        session: fresh.clone(),
        id: "thought_level".into(),
        value: "low".into(),
    })
    .await
    .unwrap();
    let after = inspect_view(&app, &fresh).await;
    assert_eq!(after.catalogue.current_model.unwrap().as_str(), "other");
    assert_eq!(after.config.options.get("thought_level").unwrap(), "low");
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

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
