use super::*;
use std::collections::BTreeMap;
use tokio::net::{UnixListener, UnixStream};

struct Fixture {
    root: PathBuf,
    bridge: Bridge,
    _listener: UnixListener,
    _peer: Option<UnixStream>,
    service_task: Option<tokio::task::JoinHandle<()>>,
    requests: Arc<std::sync::Mutex<Vec<Value>>>,
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
                inbox: vec![],
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
            requests: Arc::new(std::sync::Mutex::new(vec![])),
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
        let requests = self.requests.clone();
        self.service_task = Some(tokio::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let item: Value = serde_json::from_str(&line).unwrap();
                seen.fetch_add(1, Ordering::SeqCst);
                requests.lock().unwrap().push(item.clone());
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
    assert!(f.bridge.shared.store.read().await.topics.is_empty());
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
    assert_eq!(f.bridge.shared.store.read().await.topics.len(), 1);
    f.bridge.dispose().await;
}

#[tokio::test]
async fn failed_delivery_ack_retains_the_event_without_rerunning_or_resending_in_process() {
    let mut f = Fixture::new().await;
    let service_calls = f.mock_service();
    f.bridge
        .persist(|s| {
            s.topics.push(Topic {
                session_id: "one".into(),
                thread_id: 101,
            })
        })
        .await
        .unwrap();
    let file = f.bridge.shared.opts.state_file.clone();
    let bot = crate::test_support::Bot::new(move |_, p| {
        if p["text"].as_str().is_some_and(|s| s.contains("任务完成")) {
            // Topic setup now goes through the durable store, so the file already exists.
            std::fs::remove_file(&file).unwrap();
            std::fs::create_dir(&file).unwrap();
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
    assert!(f.bridge.shared.store.read().await.delivered.is_empty());
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
        .store
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
    assert!(f.bridge.shared.store.notifications.load(Ordering::SeqCst));
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
    let before = serde_json::to_value(&*f.bridge.shared.store.read().await).unwrap();
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
        serde_json::to_value(&*f.bridge.shared.store.read().await).unwrap(),
        before
    );
    assert!(f.bridge.shared.store.notifications.load(Ordering::SeqCst));
    assert!(!f.bridge.shared.store.silent.load(Ordering::SeqCst));
    tokio::fs::remove_dir(&f.bridge.shared.opts.state_file)
        .await
        .unwrap();
    f.bridge.persist(changes).await.unwrap();
    let live = serde_json::to_value(&*f.bridge.shared.store.read().await).unwrap();
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
    assert!(!f.bridge.shared.store.notifications.load(Ordering::SeqCst));
    assert!(f.bridge.shared.store.silent.load(Ordering::SeqCst));
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
        serde_json::to_value(&*f.bridge.shared.store.read().await).unwrap()
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

fn incoming(id: i64, text: &str) -> Value {
    json!({"update_id":id,"message":{"chat":{"id":-100},"from":{"id":42},"text":text,"message_thread_id":101}})
}
async fn wait_for(check: impl AsyncFn() -> bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !check().await {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn full_normal_pool_preserves_pending_work_and_stop_uses_reserved_capacity() {
    let mut f = Fixture::new().await;
    let calls = f.mock_service();
    let bot = crate::test_support::Bot::success().await;
    f.use_bot(&bot);
    f.bridge
        .persist(|s| {
            s.topics.push(Topic {
                session_id: "one".into(),
                thread_id: 101,
            })
        })
        .await
        .unwrap();
    let _held = f
        .bridge
        .shared
        .handlers
        .clone()
        .acquire_many_owned(HANDLER_LIMIT as u32)
        .await
        .unwrap();
    f.bridge
        .accept_update(1, incoming(1, "queued"))
        .await
        .unwrap();
    let disk: BridgeState =
        serde_json::from_slice(&std::fs::read(&f.bridge.shared.opts.state_file).unwrap()).unwrap();
    assert_eq!(disk.offset, Some(2));
    assert_eq!(disk.inbox.len(), 1);
    let bridge = f.bridge.clone();
    let run = tokio::spawn(async move { bridge.run_inbox().await });
    f.bridge
        .accept_update(2, incoming(2, "/stop"))
        .await
        .unwrap();
    wait_for(async || f.bridge.shared.store.read().await.inbox.is_empty()).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1); // cancel only, never prompt
    assert!(bot
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|(m, _)| m == "sendMessage"));
    f.bridge.dispose().await;
    run.await.unwrap().unwrap();
}

#[tokio::test]
async fn pending_messages_survive_restart_but_started_work_is_reported_without_replay() {
    let mut f = Fixture::new().await;
    let calls = f.mock_service();
    let bot = crate::test_support::Bot::new(|method, _| {
        if method == "getUpdates" {
            json!({"ok":true,"result":[]})
        } else {
            json!({"ok":true,"result":{"message_id":100}})
        }
    })
    .await;
    f.use_bot(&bot);
    f.bridge
        .persist(|s| {
            s.topics.push(Topic {
                session_id: "one".into(),
                thread_id: 101,
            });
            s.offset = Some(3);
            s.inbox = vec![
                InboxItem {
                    id: 1,
                    update: incoming(1, "uncertain"),
                    phase: InboxPhase::Started,
                    prompt: None,
                },
                InboxItem {
                    id: 2,
                    update: incoming(2, "pending"),
                    phase: InboxPhase::Pending,
                    prompt: None,
                },
            ];
        })
        .await
        .unwrap();
    let bridge = f.bridge.clone();
    let run = tokio::spawn(async move { bridge.poll().await });
    wait_for(async || f.bridge.shared.store.read().await.inbox.is_empty()).await;
    assert_eq!(calls.load(Ordering::SeqCst), 3); // watch, one prompt, unwatch
    assert!(bot
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|(m, p)| m == "sendMessage" && p["text"].as_str().unwrap().contains("未自动重放")));
    f.bridge.dispose().await;
    run.await.unwrap().unwrap();
}

#[tokio::test]
async fn full_inbox_rejects_visibly_and_failed_checkpoint_never_dispatches() {
    let mut f = Fixture::new().await;
    let calls = f.mock_service();
    let bot = crate::test_support::Bot::success().await;
    f.use_bot(&bot);
    f.bridge
        .persist(|s| {
            s.inbox = (0..INBOX_LIMIT as i64)
                .map(|id| InboxItem {
                    id,
                    update: incoming(id, "queued"),
                    phase: InboxPhase::Pending,
                    prompt: None,
                })
                .collect()
        })
        .await
        .unwrap();
    f.bridge
        .accept_update(200, incoming(200, "overflow"))
        .await
        .unwrap();
    assert_eq!(f.bridge.offset().await, 201);
    assert_eq!(f.bridge.shared.store.read().await.inbox.len(), INBOX_LIMIT);
    assert!(bot
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|(m, p)| m == "sendMessage" && p["text"].as_str().unwrap().contains("未执行")));
    let file = &f.bridge.shared.opts.state_file;
    std::fs::remove_file(file).unwrap();
    std::fs::create_dir(file).unwrap();
    assert!(f
        .bridge
        .accept_update(201, incoming(201, "/stop"))
        .await
        .is_err());
    assert_eq!(f.bridge.offset().await, 201);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    f.bridge.dispose().await;
}

#[tokio::test]
async fn interrupt_releases_control_capacity_and_forwards_literal_command_as_prompt() {
    let mut f = Fixture::new().await;
    f.mock_service();
    let bot = crate::test_support::Bot::success().await;
    f.use_bot(&bot);
    f.bridge
        .persist(|s| {
            s.topics.push(Topic {
                session_id: "one".into(),
                thread_id: 101,
            })
        })
        .await
        .unwrap();
    let held = f
        .bridge
        .shared
        .handlers
        .clone()
        .acquire_many_owned(HANDLER_LIMIT as u32)
        .await
        .unwrap();
    f.bridge
        .accept_update(1, incoming(1, "/interrupt /stop"))
        .await
        .unwrap();
    let bridge = f.bridge.clone();
    let run = tokio::spawn(async move { bridge.run_inbox().await });
    wait_for(async || {
        f.bridge.shared.controls.available_permits() == CONTROL_LIMIT
            && f.bridge
                .shared
                .store
                .read()
                .await
                .inbox
                .first()
                .is_some_and(|i| i.prompt.as_deref() == Some("/stop"))
    })
    .await;
    drop(held);
    wait_for(async || f.bridge.shared.store.read().await.inbox.is_empty()).await;
    let requests = f.requests.lock().unwrap().clone();
    assert_eq!(
        requests.iter().filter(|r| r["method"] == "cancel").count(),
        1
    );
    assert_eq!(
        requests.iter().find(|r| r["method"] == "prompt").unwrap()["params"]["prompt"][0]["text"],
        "/stop"
    );
    f.bridge.dispose().await;
    run.await.unwrap().unwrap();
}
