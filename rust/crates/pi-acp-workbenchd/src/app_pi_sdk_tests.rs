//! Opt-in, credential-free real Pi SDK/native-format integration. Its fixture
//! driver creates all paths/environment and keeps the native files alive until
//! this host has joined. Default workspace tests must not count it as executed.
use super::*;
use crate::domain::{
    fork::ForkRequest,
    transcript::{EntryRole, Transcript, TranscriptEntry},
    EntryId, OperationId, ProviderSessionId, SessionState, TurnId,
};
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    root: PathBuf,
    cwd: PathBuf,
    source: PathBuf,
    native: ProviderSessionId,
    adapter: String,
    node: String,
    store: String,
    source_model: crate::domain::ModelId,
    rows: Vec<Row>,
}
#[derive(serde::Deserialize)]
struct Row {
    role: EntryRole,
    text: String,
}
#[tokio::test]
#[ignore = "requires the isolated real Pi fixture: npm run test:native-fork:offline"]
async fn real_pi_sdk_native_fork_restores_prefix_settings_and_receipts() {
    let fixture_path = std::env::var("PI_OFFLINE_HOST_FIXTURE")
        .expect("run the isolated native-fork offline driver");
    let fixture: Fixture =
        serde_json::from_slice(&tokio::fs::read(&fixture_path).await.unwrap()).unwrap();
    assert!(
        fixture.root.starts_with(std::env::temp_dir()),
        "fixture must be inside its independent temporary root"
    );
    assert!(
        !fixture.root.exists(),
        "offline host bootstrap requires a fresh directory"
    );
    assert!(
        fixture.source.starts_with(std::env::temp_dir())
            && fixture.cwd.starts_with(std::env::temp_dir())
            && PathBuf::from(&fixture.store).starts_with(std::env::temp_dir()),
        "native paths must belong to the isolated driver"
    );
    let original = tokio::fs::read(&fixture.source).await.unwrap();
    let source = SessionId::generate();
    let mut transcript = Transcript::default();
    let mut turn = TurnId::generate();
    let mut grouped_target = None;
    for row in fixture.rows {
        if matches!(row.role, EntryRole::User) {
            turn = TurnId::generate();
        }
        if matches!(row.role, EntryRole::Agent) && row.text.chars().count() > 1 {
            // Synthetic display deltas, backed by a real SDK native message.
            // This does not claim to record live model streaming.
            let message = crate::domain::ProviderMessageId::generate();
            let boundary = row.text.char_indices().nth(1).unwrap().0;
            let start = transcript.entries.len();
            for text in [&row.text[..boundary], &row.text[boundary..]] {
                transcript.entries.push(TranscriptEntry {
                    id: EntryId::generate(),
                    turn: turn.clone(),
                    role: EntryRole::Agent,
                    text: text.into(),
                    message: Some(message.clone()),
                    image: None,
                });
            }
            if grouped_target.is_none() {
                grouped_target = Some((transcript.entries[start + 1].id.clone(), start + 2));
            }
        } else {
            transcript.entries.push(TranscriptEntry {
                id: EntryId::generate(),
                turn: turn.clone(),
                role: row.role,
                text: row.text,
                message: None,
                image: None,
            });
        }
    }
    let entry = transcript.entries[0].id.clone();
    let state = SessionState {
        id: source.clone(),
        provider_session: Some(fixture.native.clone()),
        harness: Harness::Pi,
        cwd: WorkspacePath::new(fixture.cwd.to_string_lossy()).unwrap(),
        status: SessionStatus::Idle,
        transcript,
        plan: Default::default(),
        active_turn: None,
        pending_interactions: Default::default(),
        usage: Default::default(),
        config: crate::domain::session::SessionConfig {
            model: Some(fixture.source_model),
            mode: Some(crate::domain::ModeId::new("low").unwrap()),
        },
        configuration_intent: None,
        catalogue: Default::default(),
        revision: 0,
    };
    // Initial cold bootstrap fixture only: no live actor or real data is edited,
    // no old snapshot is mixed with another revision's delivery ledger.
    let lease = StorageLease::acquire(&fixture.root).unwrap();
    HistoryStore::new(fixture.root.join("history"))
        .save(&state)
        .await
        .unwrap();
    drop(lease);
    let mut config = config_at(
        &fixture.root,
        std::collections::HashMap::from([("PI_ACP_WORKBENCH_STATE_DIR".into(), fixture.store)]),
    );
    let worker = config.workers.pi.as_mut().unwrap();
    worker.command = fixture.node;
    worker.args = vec![fixture.adapter];
    config.sessions.max_workers = 1;
    let app = WorkbenchApp::new(config.clone()).unwrap();
    let command = DomainCommand::Fork {
        session: source.clone(),
        request: ForkRequest {
            entry: entry.clone(),
        },
    };
    let operation = OperationId::generate();
    let receipt = app
        .command_durable(operation.clone(), command.clone())
        .await
        .unwrap();
    let [DomainEvent::SessionCreated(branch)] = receipt.as_slice() else {
        panic!("native branch")
    };
    let branch = branch.clone();
    assert_ne!(branch.provider_session, state.provider_session);
    assert_eq!(branch.transcript.entries.len(), 1);
    assert!(branch.config.model.is_none() && branch.config.mode.is_none());
    let loaded = super::fork_tests::inspect(&app, &source).await;
    assert_eq!(
        serde_json::to_vec(&loaded.transcript).unwrap(),
        serde_json::to_vec(&state.transcript).unwrap()
    );
    assert_eq!(
        serde_json::to_vec(&loaded.config).unwrap(),
        serde_json::to_vec(&state.config).unwrap()
    );
    assert_eq!(
        loaded.catalogue.current_model.as_ref().unwrap(),
        state.config.model.as_ref().unwrap()
    );
    assert_eq!(
        loaded.catalogue.current_mode.as_ref().unwrap().as_str(),
        "low"
    );
    assert_eq!(tokio::fs::read(&fixture.source).await.unwrap(), original);
    assert!(
        app.core.adapters.lock().await.is_empty(),
        "source peer/capacity is joined before adoption"
    );
    let (grouped_entry, grouped_end) = grouped_target.unwrap();
    let grouped_receipt = app
        .command(DomainCommand::Fork {
            session: source.clone(),
            request: ForkRequest {
                entry: grouped_entry,
            },
        })
        .await
        .unwrap();
    let [DomainEvent::SessionCreated(grouped_branch)] = grouped_receipt.as_slice() else {
        panic!("grouped native branch")
    };
    assert_eq!(
        serde_json::to_vec(&grouped_branch.transcript.entries).unwrap(),
        serde_json::to_vec(&state.transcript.entries[..grouped_end]).unwrap()
    );
    assert_eq!(
        grouped_branch
            .transcript
            .origin
            .as_ref()
            .unwrap()
            .target
            .entry
            .as_str(),
        "a1"
    );
    assert_ne!(grouped_branch.provider_session, state.provider_session);
    assert_eq!(tokio::fs::read(&fixture.source).await.unwrap(), original);
    assert!(app.core.adapters.lock().await.is_empty());
    app.command(DomainCommand::RemoveSession(source.clone()))
        .await
        .unwrap();
    app.shutdown_checked().await.unwrap();
    let app = WorkbenchApp::new(config).unwrap();
    let replay = app.command_durable(operation, command).await.unwrap();
    assert_eq!(
        serde_json::to_vec(&replay).unwrap(),
        serde_json::to_vec(&receipt).unwrap()
    );
    assert!(
        app.core.adapters.lock().await.is_empty(),
        "replay must not spawn a peer or repeat native fork"
    );
    app.command(DomainCommand::LoadSession(branch.id.clone()))
        .await
        .unwrap();
    // A second fork loads the first branch through the real ACP adapter without
    // issuing any model prompt. Its confirmed historical catalogue must be the
    // original Sonnet/high, not the source's later Opus/low preferences.
    let second = app
        .command(DomainCommand::Fork {
            session: branch.id.clone(),
            request: ForkRequest { entry },
        })
        .await
        .unwrap();
    let [DomainEvent::SessionCreated(second)] = second.as_slice() else {
        panic!("independent nested branch")
    };
    assert_ne!(second.provider_session, branch.provider_session);
    let loaded_branch = super::fork_tests::inspect(&app, &branch.id).await;
    assert_eq!(
        loaded_branch
            .catalogue
            .current_model
            .as_ref()
            .unwrap()
            .as_str(),
        "anthropic/claude-sonnet-4-5"
    );
    assert_eq!(
        loaded_branch
            .catalogue
            .current_mode
            .as_ref()
            .unwrap()
            .as_str(),
        "high"
    );
    assert!(loaded_branch.config.model.is_none() && loaded_branch.config.mode.is_none());
    assert_eq!(loaded_branch.provider_session, branch.provider_session);
    assert_eq!(tokio::fs::read(&fixture.source).await.unwrap(), original);
    app.shutdown_checked().await.unwrap();
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Report {
        first: ProviderSessionId,
        second: ProviderSessionId,
        source_unchanged: bool,
        historical_settings: bool,
        durable_restart_replay: bool,
        grouped_native_prefix: bool,
        model_prompts: u32,
    }
    let report = Report {
        first: branch.provider_session.unwrap(),
        second: second.provider_session.clone().unwrap(),
        source_unchanged: true,
        historical_settings: true,
        durable_restart_replay: true,
        grouped_native_prefix: true,
        model_prompts: 0,
    };
    use tokio::io::AsyncWriteExt;
    let mut output = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(format!("{fixture_path}.result"))
        .await
        .unwrap();
    output
        .write_all(&serde_json::to_vec(&report).unwrap())
        .await
        .unwrap();
    output.sync_all().await.unwrap();
}
