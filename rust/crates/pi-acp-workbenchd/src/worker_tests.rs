use super::*;
use serde_json::json;

#[test]
fn prompt_and_native_fork_do_not_inherit_the_short_control_deadline() {
    let now = Instant::now();
    assert_eq!(request_deadline("session/prompt", now), None);
    assert_eq!(
        request_deadline("_pi_workbench/fork", now),
        Some(now + Duration::from_secs(180))
    );
    assert_eq!(
        request_deadline("session/load", now),
        Some(now + Duration::from_secs(30))
    );
}

// Single synthetic-peer helpers exist only in this cfg(test) module; production
// must select an explicitly configured harness through configured/spawn_for.
impl WorkerSupervisor {
    pub(crate) fn new(
        command: String,
        args: Vec<String>,
        env: HashMap<String, String>,
        max_workers: usize,
    ) -> Self {
        Self::configured(
            crate::config::WorkersConfig {
                pi: Some(crate::config::WorkerConfig { command, args, env }),
                ..Default::default()
            },
            max_workers,
        )
    }
    pub(crate) async fn spawn(
        &self,
        session: SessionId,
        events: mpsc::Sender<WorkerEvent>,
    ) -> Result<WorkerHandle, DomainError> {
        self.spawn_for(session, &crate::domain::Harness::Pi, events)
            .await
    }
}

fn supervisor(command: &str, args: Vec<String>) -> WorkerSupervisor {
    WorkerSupervisor::new(command.into(), args, HashMap::new(), 1)
}

#[tokio::test]
async fn supervisor_shutdown_joins_dropped_and_not_yet_registered_worker_handles() {
    let script = "process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000);process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:String(process.pid)}}}})+'\\n');";
    let supervisor = WorkerSupervisor::new(
        "node".into(),
        vec!["-e".into(), script.into()],
        HashMap::new(),
        2,
    );
    let mut handles = Vec::new();
    let mut pids = Vec::new();
    let mut observers = Vec::new();
    for _ in 0..2 {
        let (tx, mut rx) = mpsc::channel(1);
        let worker = supervisor.spawn(SessionId::generate(), tx).await.unwrap();
        let event = tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .unwrap()
            .unwrap();
        let WorkerEvent::Update(notification) = event else {
            panic!("pid notification")
        };
        let crate::acp::SessionUpdate::AgentMessage { content, .. } = notification.update else {
            panic!("pid text")
        };
        pids.push(content.display_text().unwrap().parse::<i32>().unwrap());
        observers.push(worker.completion());
        handles.push(worker);
    }
    drop(handles.pop()); // no adapter map ever owned either worker
    tokio::time::timeout(Duration::from_secs(3), supervisor.shutdown())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(supervisor.capacity.available_permits(), 2);
    for observer in observers {
        assert!(observer.is_finished());
    }
    for pid in pids {
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    }
    let (tx, _) = mpsc::channel(1);
    assert!(supervisor.spawn(SessionId::generate(), tx).await.is_err());
    handles.pop().unwrap().stop().await;
    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn configured_harnesses_use_distinct_args_env_and_commands_without_leaking_private_env() {
    use crate::{
        config::{WorkerConfig, WorkersConfig},
        domain::Harness,
    };
    let script = "process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:process.argv[1]+':'+process.env.PROVIDER_TAG+':'+typeof process.env.WORKBENCH_FAKE_BOT}}}})+'\\n');process.stdin.resume();";
    let launch = |name: &str| WorkerConfig {
        command: "node".into(),
        args: vec!["-e".into(), script.into(), name.into()],
        env: HashMap::from([
            ("PROVIDER_TAG".into(), name.into()),
            ("WORKBENCH_FAKE_BOT".into(), "fixture-secret".into()),
        ]),
    };
    let mut codex = launch("codex");
    codex.command = "/bin/sh".into();
    codex.args.splice(
        0..0,
        [
            "-c".into(),
            "exec node \"$@\"".into(),
            "fixture-shell".into(),
        ],
    );
    let supervisor = WorkerSupervisor::configured(
        WorkersConfig {
            pi: Some(launch("pi")),
            codex: Some(codex),
            claude: Some(launch("claude")),
        },
        1,
    )
    .without_env("WORKBENCH_FAKE_BOT".into());
    let mut epoch = 0;
    for (harness, name) in [
        (Harness::Pi, "pi"),
        (Harness::Codex, "codex"),
        (Harness::Claude, "claude"),
    ] {
        let (tx, mut rx) = mpsc::channel(1);
        let worker = supervisor
            .spawn_for(SessionId::generate(), &harness, tx)
            .await
            .unwrap();
        assert!(worker.epoch > epoch);
        epoch = worker.epoch;
        let event = tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .unwrap()
            .unwrap();
        let WorkerEvent::Update(notification) = event else {
            panic!("profile notification")
        };
        let crate::acp::SessionUpdate::AgentMessage { content, .. } = notification.update else {
            panic!("profile text")
        };
        assert_eq!(
            content.display_text(),
            Some(format!("{name}:{name}:undefined").as_str())
        );
        worker.stop().await;
    }
}

#[tokio::test]
async fn capacity_and_epochs_are_global_across_harnesses_and_disabled_provider_never_falls_back() {
    use crate::{
        config::{WorkerConfig, WorkersConfig},
        domain::Harness,
    };
    let launch = || WorkerConfig {
        command: "/bin/cat".into(),
        args: vec![],
        env: Default::default(),
    };
    let supervisor = WorkerSupervisor::configured(
        WorkersConfig {
            pi: Some(launch()),
            codex: Some(launch()),
            claude: None,
        },
        2,
    );
    let (tx, _rx) = mpsc::channel(1);
    assert!(matches!(
        supervisor
            .spawn_for(SessionId::generate(), &Harness::Claude, tx)
            .await,
        Err(DomainError::ProviderNotConfigured)
    ));
    let (tx, _rx1) = mpsc::channel(1);
    let first = supervisor
        .spawn_for(SessionId::generate(), &Harness::Pi, tx)
        .await
        .unwrap();
    let (tx, _rx2) = mpsc::channel(1);
    let second = supervisor
        .spawn_for(SessionId::generate(), &Harness::Codex, tx)
        .await
        .unwrap();
    assert!(second.epoch > first.epoch);
    let (tx, _rx3) = mpsc::channel(1);
    assert!(matches!(
        supervisor
            .spawn_for(SessionId::generate(), &Harness::Pi, tx)
            .await,
        Err(DomainError::Backpressure)
    ));
    first.stop().await;
    let (tx, _rx4) = mpsc::channel(1);
    let replacement = supervisor
        .spawn_for(SessionId::generate(), &Harness::Codex, tx)
        .await
        .unwrap();
    assert!(replacement.epoch > second.epoch);
    second.stop().await;
    replacement.stop().await;
}

#[tokio::test]
async fn stop_delivers_flushed_replies_then_eof_before_escalating_to_signals() {
    let marker = std::env::temp_dir().join(format!("workbench-eof-{}", uuid::Uuid::new_v4()));
    let script = r#"
        const fs = require('node:fs'); const lines = [];
        require('node:readline').createInterface({input:process.stdin}).on('line', line => lines.push(JSON.parse(line))).on('close', () => fs.writeFileSync(process.argv[1], JSON.stringify(lines)));
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ready'}}}})+'\n');
    "#;
    let supervisor = supervisor(
        "node",
        vec![
            "-e".into(),
            script.into(),
            marker.to_string_lossy().into_owned(),
        ],
    );
    let (tx, mut rx) = mpsc::channel(1);
    let worker = supervisor.spawn(SessionId::generate(), tx).await.unwrap();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .unwrap(),
        Some(WorkerEvent::Update(_))
    ));
    worker
        .respond(crate::acp::JsonRpcResponse {
            jsonrpc: crate::acp::JsonRpcVersion::V2,
            id: crate::acp::RequestId::String("permission".into()),
            result: Some(json!({"outcome":{"outcome":"cancelled"}})),
            error: None,
        })
        .await
        .unwrap();
    worker.stop().await;
    let observed = tokio::fs::read_to_string(&marker).await.unwrap();
    assert!(observed.contains("permission") && observed.contains("cancelled"));
    tokio::fs::remove_file(marker).await.unwrap();
}

#[tokio::test]
async fn full_event_mailbox_backpressures_stdout_without_blocking_cancel_writes() {
    let marker = std::env::temp_dir().join(format!("workbench-cancel-{}", uuid::Uuid::new_v4()));
    let script = r#"
        const fs = require('node:fs');
        for (let i = 0; i < 40; i++) process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'queued'}}}})+'\n');
        process.stdin.on('data', () => fs.writeFileSync(process.argv[1], 'received'));
    "#;
    let supervisor = supervisor(
        "node",
        vec![
            "-e".into(),
            script.into(),
            marker.to_string_lossy().into_owned(),
        ],
    );
    let (tx, rx) = mpsc::channel(1);
    let worker = supervisor.spawn(SessionId::generate(), tx).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while rx.len() != 1 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    tokio::time::timeout(
        Duration::from_secs(1),
        worker.notify(crate::acp::JsonRpcNotification {
            jsonrpc: crate::acp::JsonRpcVersion::V2,
            method: "session/cancel".into(),
            params: serde_json::to_value(crate::acp::CancelRequest {
                session_id: crate::acp::NativeSessionId::try_from("native".to_owned()).unwrap(),
            })
            .unwrap(),
        }),
    )
    .await
    .unwrap()
    .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !marker.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(rx.len(), 1); // the consumer never drained the mailbox
    worker.stop().await;
    tokio::fs::remove_file(marker).await.unwrap();
}

#[tokio::test]
async fn capacity_is_released_on_stop_and_epochs_advance() {
    let supervisor = supervisor("/bin/sh", vec!["-c".into(), "exec sleep 60".into()]);
    let (events, _rx) = mpsc::channel(8);
    let first = supervisor
        .spawn(SessionId::generate(), events.clone())
        .await
        .unwrap();
    let epoch = first.epoch;
    assert!(matches!(
        supervisor
            .spawn(SessionId::generate(), events.clone())
            .await,
        Err(DomainError::Backpressure)
    ));
    first.stop().await;
    let second = supervisor
        .spawn(SessionId::generate(), events)
        .await
        .unwrap();
    assert!(second.epoch > epoch);
    second.stop().await;
}

#[tokio::test]
async fn shutdown_kills_term_resistant_process_group() {
    let path = std::env::temp_dir().join(format!("workbench-child-{}", uuid::Uuid::new_v4()));
    let script = format!(
        "trap '' TERM; sleep 60 & echo $! > '{}'; wait",
        path.display()
    );
    let supervisor = supervisor("/bin/sh", vec!["-c".into(), script]);
    let (events, _rx) = mpsc::channel(8);
    let worker = supervisor
        .spawn(SessionId::generate(), events)
        .await
        .unwrap();
    let pid: i32 = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Ok(value) = tokio::fs::read_to_string(&path).await {
                if let Ok(pid) = value.trim().parse() {
                    break pid;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(2), worker.stop())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match tokio::fs::read_to_string(format!("/proc/{pid}/stat")).await {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Ok(stat)
                    if stat
                        .rsplit_once(") ")
                        .is_some_and(|(_, rest)| rest.starts_with('Z')) =>
                {
                    break
                }
                _ => tokio::time::sleep(Duration::from_millis(10)).await,
            }
        }
    })
    .await
    .unwrap();
    tokio::fs::remove_file(path).await.unwrap();
    assert_eq!(supervisor.capacity.available_permits(), 1);
}

#[tokio::test]
async fn aborted_worker_task_releases_its_capacity_and_process_guard() {
    let supervisor = supervisor("/bin/sh", vec!["-c".into(), "exec sleep 60".into()]);
    let (events, _rx) = mpsc::channel(8);
    let worker = supervisor
        .spawn(SessionId::generate(), events.clone())
        .await
        .unwrap();
    worker.task.abort().await;
    worker.stop().await;
    let replacement = supervisor
        .spawn(SessionId::generate(), events)
        .await
        .unwrap();
    replacement.stop().await;
}

#[tokio::test]
async fn unsupported_nested_form_is_declined_on_the_wire_without_disconnect() {
    let script = r#"
        const send = x => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
        require('node:readline').createInterface({input:process.stdin}).on('line', line => {
            const r=JSON.parse(line);
            if(r.method==='initialize') {
                send({id:'nested-form',method:'elicitation/create',params:{sessionId:'native',mode:'form',message:'Nested',
                    requestedSchema:{type:'object',properties:{nested:{type:'object',properties:{}}}}}});
            } else if(r.id==='nested-form') {
                send({id:1,result:{declined:r.result?.action==='decline'}});
            }
        });
    "#;
    let supervisor = supervisor("node", vec!["-e".into(), script.into()]);
    let (events, _rx) = mpsc::channel(8);
    let worker = supervisor
        .spawn(SessionId::generate(), events)
        .await
        .unwrap();
    let result = worker
        .request(JsonRpcRequest::new(RequestId::Number(1), "initialize", json!({})).unwrap())
        .await
        .unwrap();
    assert_eq!(result.result.unwrap()["declined"], true);
    worker.stop().await;
}

#[tokio::test]
async fn failed_spawn_does_not_leak_capacity() {
    let mut supervisor = supervisor("/does/not/exist/acp-worker", vec![]);
    let (events, _rx) = mpsc::channel(8);
    assert!(matches!(
        supervisor
            .spawn(SessionId::generate(), events.clone())
            .await,
        Err(DomainError::Worker(_))
    ));
    supervisor.launches.pi.as_mut().unwrap().command = "/bin/cat".into();
    let worker = supervisor
        .spawn(SessionId::generate(), events)
        .await
        .unwrap();
    worker.stop().await;
}

#[tokio::test]
async fn requests_correlate_with_standard_stdio_peer() {
    let peer =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test/contract-agent.mjs");
    let supervisor = supervisor("node", vec![peer.to_string_lossy().into_owned()]);
    let (events, _rx) = mpsc::channel(8);
    let worker = supervisor
        .spawn(SessionId::generate(), events)
        .await
        .unwrap();
    let request = JsonRpcRequest::new(
        RequestId::Number(1),
        "initialize",
        json!({"protocolVersion":1,"clientCapabilities":{}}),
    )
    .unwrap();
    let response = worker.request(request).await.unwrap();
    assert_eq!(response.id, RequestId::Number(1));
    assert_eq!(response.result.unwrap()["protocolVersion"], 1);
    let request = JsonRpcRequest::new(
        RequestId::String("session-new".into()),
        "session/new",
        json!({"cwd":"/tmp","mcpServers":[]}),
    )
    .unwrap();
    let response = worker.request(request).await.unwrap();
    assert_eq!(response.id, RequestId::String("session-new".into()));
    assert!(response.result.unwrap()["sessionId"].is_string());
    worker.stop().await;
}

#[tokio::test]
async fn eof_rejects_pending_requests_and_releases_capacity() {
    let supervisor = supervisor("/bin/sh", vec!["-c".into(), "read line; exit 7".into()]);
    let (events, mut rx) = mpsc::channel(8);
    let worker = supervisor
        .spawn(SessionId::generate(), events)
        .await
        .unwrap();
    let request = JsonRpcRequest::new(RequestId::Number(1), "initialize", json!({})).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(2), worker.request(request))
        .await
        .unwrap();
    assert!(matches!(result, Err(DomainError::Worker(_))));
    assert!(matches!(rx.recv().await, Some(WorkerEvent::Closed(_))));
    worker.stop().await;
    assert_eq!(supervisor.capacity.available_permits(), 1);
}
