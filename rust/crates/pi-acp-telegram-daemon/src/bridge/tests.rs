use super::*;
use std::collections::BTreeMap;
use tokio::net::{UnixListener, UnixStream};

struct Fixture {
    root: PathBuf,
    bridge: Bridge,
    _listener: UnixListener,
    _peer: UnixStream,
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
            _peer: peer,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
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
