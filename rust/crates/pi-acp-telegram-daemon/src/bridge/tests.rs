use super::*;
use std::collections::BTreeMap;
use tokio::net::{UnixListener, UnixStream};

struct Fixture {
    root: PathBuf,
    bridge: Bridge,
    _listener: UnixListener,
    _peer: Option<UnixStream>,
    service_task: Option<tokio::task::JoinHandle<()>>,
}
impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!("pi-relay-unit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let socket = root.join("s");
        let listener = UnixListener::bind(&socket).unwrap();
        let host = Sessions::connect(BTreeMap::new(), &socket, false)
            .await
            .unwrap();
        let (peer, _) = listener.accept().await.unwrap();
        let stop = CancellationToken::new();
        // No API requests are made by these state/cleanup tests.
        let api = Arc::new(TelegramApi::new(
            "synthetic",
            Duration::from_secs(3600),
            stop.clone(),
        ));
        let bridge = Bridge::new(
            api,
            host,
            BridgeState {
                version: 1,
                bot_id: 7,
                chat_id: -100,
                offset: Some(1),
                topics: vec![],
                delivered: vec![],
                notifications: Some(true),
                silent: Some(false),
                history_sent: None,
            },
            Options {
                chat_id: -100,
                allowed_user_ids: vec![42],
                stream_interval: Duration::from_secs(3600),
                state_file: root.join("state.json"),
                report: Arc::new(|_| {}),
                stop,
            },
        );
        Self {
            root,
            bridge,
            _listener: listener,
            _peer: Some(peer),
            service_task: None,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(task) = &self.service_task {
            task.abort();
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
impl Fixture {
    fn mock_service(&mut self) -> Arc<std::sync::atomic::AtomicUsize> {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let (reader, mut writer) = self._peer.take().unwrap().into_split();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = calls.clone();
        self.service_task = Some(tokio::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let item: Value = serde_json::from_str(&line).unwrap();
                seen.fetch_add(1, Ordering::SeqCst);
                let value = match item["method"].as_str().unwrap() {
                    "list" => json!([{"id":"one","cwd":"/work","title":"One","sessionNumber":1}]),
                    "permission" => json!(true),
                    _ => {
                        json!({"snapshot":{"id":"one","entries":[]},"busy":false,"permissions":[]})
                    }
                };
                if writer
                    .write_all(format!("{}\n", json!({"id":item["id"],"value":value})).as_bytes())
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }));
        calls
    }
    fn use_bot(&mut self, bot: &crate::test_support::Bot) {
        Arc::get_mut(&mut self.bridge.shared).unwrap().api = bot.api.clone();
    }
}

#[tokio::test]
async fn topic_write_failure_does_not_publish_or_poison_the_topic_cache() {
    let mut f = Fixture::new().await;
    f.mock_service();
    let file = f.bridge.shared.opts.state_file.clone();
    let first = Arc::new(AtomicBool::new(true));
    let fault = first.clone();
    let bot = crate::test_support::Bot::new(move |method, _| {
        if method == "createForumTopic" && fault.swap(false, Ordering::SeqCst) {
            std::fs::create_dir(&file).unwrap();
        }
        json!({"ok":true,"result":{"message_id":100,"message_thread_id":201}})
    })
    .await;
    f.use_bot(&bot);
    let session = SessionStub {
        id: "one".into(),
        cwd: "/work".into(),
        title: "One".into(),
        session_number: Some(1),
    };
    assert!(f.bridge.ensure_topic(&session).await.is_err());
    assert!(f.bridge.shared.data.read().await.topics.is_empty());
    tokio::fs::remove_dir(&f.bridge.shared.opts.state_file)
        .await
        .unwrap();
    assert_eq!(f.bridge.ensure_topic(&session).await.unwrap(), 201);
    assert_eq!(f.bridge.ensure_topic(&session).await.unwrap(), 201);
    assert_eq!(
        bot.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _)| m == "createForumTopic")
            .count(),
        2
    );
    assert_eq!(f.bridge.shared.data.read().await.topics.len(), 1);
    f.bridge.dispose().await;
}

#[tokio::test]
async fn failed_delivery_ack_retains_the_event_without_rerunning_or_resending_in_process() {
    let mut f = Fixture::new().await;
    let service_calls = f.mock_service();
    f.bridge.shared.data.write().await.topics.push(Topic {
        session_id: "one".into(),
        thread_id: 101,
    });
    let file = f.bridge.shared.opts.state_file.clone();
    let bot = crate::test_support::Bot::new(move |_, p| {
        if p["text"].as_str().is_some_and(|s| s.contains("任务完成")) {
            let _ = std::fs::create_dir(&file);
        }
        json!({"ok":true,"result":{"message_id":100}})
    })
    .await;
    f.use_bot(&bot);
    let event = TurnEvent {
        id: "event".into(),
        session_id: "one".into(),
        cwd: "/work".into(),
        title: "One".into(),
        session_number: Some(1),
        input_text: None,
        text: "answer".into(),
        status: "completed".into(),
        error: None,
        updated: 1,
        pending_permissions: 0,
        non_text_blocks: 0,
    };
    let mut wrong = event.clone();
    wrong.cwd = "/forbidden".into();
    assert!(!f.bridge.consume(&wrong).await);
    assert!(bot.calls.lock().unwrap().is_empty());
    assert!(!f.bridge.consume(&event).await);
    assert!(f.bridge.shared.data.read().await.delivered.is_empty());
    let sent = bot.calls.lock().unwrap().len();
    tokio::fs::remove_dir(&f.bridge.shared.opts.state_file)
        .await
        .unwrap();
    assert!(f.bridge.consume(&event).await);
    assert!(f.bridge.consume(&event).await);
    assert_eq!(bot.calls.lock().unwrap().len(), sent);
    assert!(f
        .bridge
        .shared
        .data
        .read()
        .await
        .delivered
        .contains(&event.id));
    assert_eq!(service_calls.load(Ordering::SeqCst), 3); // list only, never prompt
    f.bridge.dispose().await;
}

#[tokio::test]
async fn failed_switch_dispatch_has_no_menu_or_live_side_effects_and_expired_ticket_never_reaches_service(
) {
    let mut f = Fixture::new().await;
    let calls = f.mock_service();
    let bot = crate::test_support::Bot::success().await;
    f.use_bot(&bot);
    tokio::fs::create_dir(&f.bridge.shared.opts.state_file)
        .await
        .unwrap();
    let update = json!({"callback_query":{"id":"toggle","from":{"id":42},"data":"notify:off","message":{"chat":{"id":-100},"message_thread_id":101}}});
    assert!(f.bridge.dispatch(&update).await.is_err());
    assert!(f.bridge.shared.notifications_on.load(Ordering::SeqCst));
    assert!(bot.calls.lock().unwrap().is_empty());
    f.bridge.shared.tickets.lock().await.insert(
        "a".repeat(20),
        Ticket {
            session_id: "one".into(),
            permission_id: "permission".into(),
            thread_id: 101,
            options: vec![Some("yes".into())],
            expires: 0,
        },
    );
    f.bridge
        .answer_permission("callback", &format!("p:{}:0", "a".repeat(20)), Some(101))
        .await;
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        bot.calls.lock().unwrap()[0].1["text"],
        "授权已失效或不属于此话题。"
    );
    f.bridge.dispose().await;
}

fn changes(s: &mut BridgeState) {
    s.offset = Some(99);
    s.notifications = Some(false);
    s.silent = Some(true);
    s.topics.push(Topic {
        session_id: "one".into(),
        thread_id: 101,
    });
    s.delivered.push("event".into());
    s.history_sent = Some(HashMap::from([("one".into(), vec!["entry".into()])]));
}
#[tokio::test]
async fn failed_durable_transactions_publish_neither_data_nor_live_switches() {
    let f = Fixture::new().await;
    let before = serde_json::to_value(&*f.bridge.shared.data.read().await).unwrap();
    // Rename over a directory fails even under root; do not depend on chmod/EACCES.
    tokio::fs::create_dir(&f.bridge.shared.opts.state_file)
        .await
        .unwrap();
    assert!(f
        .bridge
        .persist(changes)
        .await
        .unwrap_err()
        .contains("无法保存"));
    assert_eq!(
        serde_json::to_value(&*f.bridge.shared.data.read().await).unwrap(),
        before
    );
    assert!(f.bridge.shared.notifications_on.load(Ordering::SeqCst));
    assert!(!f.bridge.shared.silent_on.load(Ordering::SeqCst));
    tokio::fs::remove_dir(&f.bridge.shared.opts.state_file)
        .await
        .unwrap();
    f.bridge.persist(changes).await.unwrap();
    let live = serde_json::to_value(&*f.bridge.shared.data.read().await).unwrap();
    let disk: Value = serde_json::from_slice(
        &tokio::fs::read(&f.bridge.shared.opts.state_file)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(disk, live);
    assert_eq!(disk["offset"], 99);
    assert_eq!(disk["topics"][0]["sessionId"], "one");
    assert_eq!(disk["historySent"]["one"][0], "entry");
    assert!(!f.bridge.shared.notifications_on.load(Ordering::SeqCst));
    assert!(f.bridge.shared.silent_on.load(Ordering::SeqCst));
    f.bridge.dispose().await;
}
#[tokio::test]
async fn concurrent_transactions_do_not_overwrite_each_others_checkpoints() {
    let f = Fixture::new().await;
    let (a, b) = tokio::join!(
        f.bridge.persist(|s| s.delivered.push("one".into())),
        f.bridge.persist(|s| s.offset = Some(55))
    );
    a.unwrap();
    b.unwrap();
    let disk: Value = serde_json::from_slice(
        &tokio::fs::read(&f.bridge.shared.opts.state_file)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(disk["offset"], 55);
    assert_eq!(disk["delivered"], json!(["one"]));
    assert_eq!(
        disk,
        serde_json::to_value(&*f.bridge.shared.data.read().await).unwrap()
    );
    f.bridge.dispose().await;
}
#[tokio::test]
async fn previews_are_bounded_and_abandoned_streams_and_tickets_expire() {
    let f = Fixture::new().await;
    for i in 0..40 {
        f.bridge.stream(&format!("event-{i}"), 101).await;
    }
    assert!(f.bridge.shared.streams.lock().await.len() <= 32);
    assert!(f.bridge.shared.touched.lock().await.len() <= 32);
    for time in f.bridge.shared.touched.lock().await.values_mut() {
        *time = now_ms() - STREAM_IDLE_MS - 1;
    }
    for (id, expires) in [("expired", 0), ("live", now_ms() + 60000)] {
        f.bridge.shared.tickets.lock().await.insert(
            id.into(),
            Ticket {
                session_id: "one".into(),
                permission_id: "permission".into(),
                thread_id: 101,
                options: vec![Some("yes".into())],
                expires,
            },
        );
    }
    f.bridge.prune().await;
    assert!(f.bridge.shared.streams.lock().await.is_empty());
    assert!(f.bridge.shared.touched.lock().await.is_empty());
    assert!(!f.bridge.shared.tickets.lock().await.contains_key("expired"));
    assert!(f.bridge.shared.tickets.lock().await.contains_key("live"));
    f.bridge.dispose().await;
    assert!(f.bridge.shared.tickets.lock().await.is_empty());
}
