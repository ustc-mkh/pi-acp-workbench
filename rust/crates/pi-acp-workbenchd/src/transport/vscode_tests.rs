use super::*;
use crate::config::{
    Config, LimitsConfig, SessionsConfig, StorageConfig, WorkerConfig, WorkersConfig,
};

fn app(root: &Path) -> WorkbenchApp {
    app_with_env(root, Default::default())
}
fn app_with_env(root: &Path, env: std::collections::HashMap<String, String>) -> WorkbenchApp {
    let peer = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/contract-agent.mjs");
    WorkbenchApp::new(Config {
        workers: WorkersConfig {
            pi: Some(WorkerConfig {
                command: "node".into(),
                args: vec![peer.to_string_lossy().into_owned()],
                env,
            }),
            ..Default::default()
        },
        sessions: SessionsConfig {
            mailbox: 128,
            max_workers: 16,
        },
        telegram: None,
        storage: StorageConfig {
            root: root.to_owned(),
        },
        limits: LimitsConfig {
            pending_interactions: 32,
        },
    })
    .unwrap()
}
struct Client {
    read: BufReader<tokio::net::unix::OwnedReadHalf>,
    write: tokio::net::unix::OwnedWriteHalf,
}
impl Client {
    async fn open(path: &Path) -> Self {
        let (read, write) = UnixStream::connect(path).await.unwrap().into_split();
        Self {
            read: BufReader::new(read),
            write,
        }
    }
    async fn send(&mut self, id: u64, command: ClientCommand) {
        let mut bytes = serde_json::to_vec(&IpcRequest {
            version: query::ProtocolVersion,
            id: SafeInteger::new(id).unwrap(),
            command,
            operation: None,
        })
        .unwrap();
        bytes.push(b'\n');
        self.write.write_all(&bytes).await.unwrap();
    }
    async fn next(&mut self) -> IpcMessage {
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut line = String::new();
            assert!(self.read.read_line(&mut line).await.unwrap() > 0);
            serde_json::from_str(&line).unwrap()
        })
        .await
        .unwrap()
    }
}

#[tokio::test]
async fn image_queries_return_bounded_verified_binary_responses_without_journal_provider_or_path_authority(
) {
    use crate::domain::image::{ImageAsset, ImageMime};
    let root = std::env::temp_dir().join(format!("workbench-ipc-image-{}", uuid::Uuid::new_v4()));
    let trace = root.join("peer-trace");
    let app = app_with_env(
        &root,
        std::collections::HashMap::from([(
            "WORKBENCH_CONTRACT_TRACE".into(),
            trace.to_string_lossy().into_owned(),
        )]),
    );
    // Transport/signature fixture, not a claim of full PNG decoding.
    let mut bytes = vec![0; crate::domain::image::MAX_IMAGE_BYTES];
    bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    bytes[12..16].copy_from_slice(b"IHDR");
    let asset = ImageAsset::new(ImageMime::Png, bytes).unwrap();
    app.delivery_payloads().put_image(&asset).await.unwrap();
    let journal = app.journal_snapshot().await.unwrap();
    let socket = root.join("workbench.sock");
    let transport = ExternalTransport::bind(&socket, app.clone()).await.unwrap();
    let mut client = Client::open(&socket).await;
    client
        .send(
            1,
            ClientCommand::Image {
                image: asset.image().clone(),
            },
        )
        .await;
    let result = client.next().await;
    assert!(!format!("{result:?}").contains("iVBOR"));
    let IpcMessage::Image { id, asset: read } = result else {
        panic!("image response")
    };
    assert_eq!(id.get(), 1);
    assert_eq!(read.image(), asset.image());
    assert_eq!(read.bytes(), asset.bytes());
    let request = IpcRequest {
        version: query::ProtocolVersion,
        id: SafeInteger::new(2).unwrap(),
        command: ClientCommand::Image {
            image: asset.image().clone(),
        },
        operation: Some(crate::domain::OperationId::new("no-image-journal").unwrap()),
    };
    let mut wire = serde_json::to_vec(&request).unwrap();
    wire.push(b'\n');
    client.write.write_all(&wire).await.unwrap();
    assert!(
        matches!(client.next().await, IpcMessage::Error { id, code, .. } if id.get() == 2 && code == "invalid_input")
    );
    let mut wrong = serde_json::to_value(asset.image()).unwrap();
    wrong["sha256"] = "0".repeat(64).into();
    client
        .send(
            3,
            ClientCommand::Image {
                image: serde_json::from_value(wrong).unwrap(),
            },
        )
        .await;
    assert!(
        matches!(client.next().await, IpcMessage::Error { id, code, .. } if id.get() == 3 && code == "persistence")
    );
    client
        .send(
            4,
            ClientCommand::List {
                cursor: None,
                limit: None,
            },
        )
        .await;
    assert!(
        matches!(client.next().await, IpcMessage::Query { id, result: QueryResult::List(page) } if id.get() == 4 && page.sessions.is_empty())
    );
    assert!(!tokio::fs::try_exists(trace).await.unwrap());
    assert_eq!(app.journal_snapshot().await.unwrap(), journal);
    assert!(serde_json::from_str::<IpcRequest>(
        r#"{"version":2,"id":5,"command":{"method":"image","path":"/etc/passwd"}}"#
    )
    .is_err());
    drop(client);
    transport.shutdown().await.unwrap();
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn external_ipc_creates_prompts_and_streams_the_shared_runtime() {
    let root = std::env::temp_dir().join(format!("workbench-ipc-{}", uuid::Uuid::new_v4()));
    let app = app(&root);
    let socket = root.join("workbench.sock");
    let transport = ExternalTransport::bind(&socket, app.clone()).await.unwrap();
    assert_eq!(
        std::fs::metadata(&socket).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(ExternalTransport::bind(&socket, app.clone()).await.is_err());
    let mut client = Client::open(&socket).await;
    client
        .send(
            1,
            ClientCommand::Create {
                harness: Harness::Pi,
                cwd: WorkspacePath::new("/tmp").unwrap(),
            },
        )
        .await;
    let IpcMessage::Reply {
        receipt: CommandReceipt::Created { summary },
        ..
    } = client.next().await
    else {
        panic!("create receipt")
    };
    let id = summary.id;
    client
        .send(
            2,
            ClientCommand::Attach {
                session: id.clone(),
            },
        )
        .await;
    assert!(matches!(
        client.next().await,
        IpcMessage::Query { id, result: QueryResult::Attached(_) } if id.get() == 2
    ));
    client
        .send(
            3,
            ClientCommand::Prompt {
                session: id.clone(),
                prompt: Prompt::new("IPC hello").unwrap(),
            },
        )
        .await;
    let mut reply = false;
    let mut text = false;
    let mut finished = false;
    while !reply || !finished {
        match client.next().await {
            IpcMessage::Reply { id, .. } if id.get() == 3 => reply = true,
            IpcMessage::Batch { batch } => {
                text |= batch.entries.iter().any(|entry| matches!(&entry.text, query::TextBody::Inline { text } if text == "echo: IPC hello"));
                finished |= batch.view.is_some_and(|view| {
                    view.active_turn.is_none()
                        && matches!(view.status, crate::domain::SessionStatus::Idle)
                });
            }
            IpcMessage::Error { message, .. } => panic!("{message}"),
            _ => {}
        }
    }
    assert!(reply && text);
    let state = app.command(DomainCommand::Inspect(id)).await.unwrap();
    assert_eq!(state.view().unwrap().last_entry_seq.get(), 2);
    transport.shutdown().await.unwrap();
    assert!(!socket.exists());
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn duplicate_pending_ids_close_only_the_socket_and_accepted_work_survives_observer_drop() {
    let root =
        std::env::temp_dir().join(format!("workbench-ipc-duplicate-{}", uuid::Uuid::new_v4()));
    let gate = root.join("gate");
    let app = app_with_env(
        &root,
        std::collections::HashMap::from([(
            "WORKBENCH_CONTRACT_CONFIG_GATE".into(),
            gate.to_string_lossy().into_owned(),
        )]),
    );
    let socket = root.join("workbench.sock");
    let transport = ExternalTransport::bind(&socket, app.clone()).await.unwrap();
    let created = app
        .command(DomainCommand::CreateSession {
            harness: Harness::Pi,
            cwd: WorkspacePath::new("/tmp").unwrap(),
        })
        .await
        .unwrap();
    let CommandReceipt::Created { summary } = created else {
        panic!("created")
    };
    let id = summary.id;
    app.command(DomainCommand::Prompt {
        session: id.clone(),
        prompt: Prompt::new("prime").unwrap(),
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let events = app
                .command(DomainCommand::Inspect(id.clone()))
                .await
                .unwrap();
            if events
                .view()
                .is_some_and(|view| view.active_turn.is_none() && view.provider_session.is_some())
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let mut client = Client::open(&socket).await;
    let operation = crate::domain::OperationId::generate();
    let command = DomainCommand::SetModel {
        session: id.clone(),
        model: ModelId::new("other").unwrap(),
    };
    let mut request = serde_json::to_vec(&IpcRequest {
        version: query::ProtocolVersion,
        id: SafeInteger::new(7).unwrap(),
        command: ClientCommand::SetModel {
            session: id.clone(),
            model: ModelId::new("other").unwrap(),
        },
        operation: Some(operation.clone()),
    })
    .unwrap();
    request.push(b'\n');
    client.write.write_all(&request).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while !gate.with_extension("started").exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    client
        .send(
            7,
            ClientCommand::Inspect {
                session: id.clone(),
            },
        )
        .await;
    let mut line = String::new();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), client.read.read_line(&mut line))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    tokio::fs::write(gate.with_extension("release"), b"release")
        .await
        .unwrap();
    let original = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match app.operation_result(&operation, &command).await {
                Ok(Some(result)) => break result.unwrap(),
                Ok(None) | Err(DomainError::OperationInterrupted) => {}
                Err(error) => panic!("lookup: {error}"),
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let replay = app.command_durable(operation, command).await.unwrap();
    assert_eq!(
        serde_json::to_string(&original).unwrap(),
        serde_json::to_string(&replay).unwrap()
    );
    let mut healthy = Client::open(&socket).await;
    healthy
        .send(1, ClientCommand::Inspect { session: id })
        .await;
    assert!(
        matches!(healthy.next().await, IpcMessage::Query { id, result: QueryResult::View(view) } if id.get() == 1 && view.config.model.as_ref().unwrap().as_str() == "other")
    );
    transport.shutdown().await.unwrap();
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[test]
fn external_protocol_cannot_inject_agent_or_worker_events() {
    for command in [
        r#"{"method":"agent","session":"s","event":{"Crashed":{"reason":"spoof"}}}"#,
        r#"{"method":"worker_started","session":"s","epoch":1}"#,
        r#"{"method":"inspect","session":"s","unexpected":true}"#,
    ] {
        assert!(serde_json::from_str::<ClientCommand>(command).is_err());
    }
}

#[tokio::test]
async fn invalid_connection_is_isolated_and_socket_cleanup_preserves_replacement() {
    let root =
        std::env::temp_dir().join(format!("workbench-ipc-isolation-{}", uuid::Uuid::new_v4()));
    let app = app(&root);
    let socket = root.join("workbench.sock");
    let transport = ExternalTransport::bind(&socket, app.clone()).await.unwrap();
    let mut bad = UnixStream::connect(&socket).await.unwrap();
    bad.write_all(b"{invalid}\n").await.unwrap();
    let mut byte = [0];
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), bad.read(&mut byte))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    let mut client = Client::open(&socket).await;
    client
        .send(
            1,
            ClientCommand::List {
                cursor: None,
                limit: None,
            },
        )
        .await;
    assert!(
        matches!(client.next().await, IpcMessage::Query { id, result: QueryResult::List(_) } if id.get() == 1)
    );
    tokio::fs::remove_file(&socket).await.unwrap();
    tokio::fs::write(&socket, b"replacement owned by operator")
        .await
        .unwrap();
    transport.shutdown().await.unwrap();
    assert_eq!(
        tokio::fs::read(&socket).await.unwrap(),
        b"replacement owned by operator"
    );
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
