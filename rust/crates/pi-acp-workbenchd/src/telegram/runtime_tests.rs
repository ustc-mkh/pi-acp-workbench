use super::{
    api::*,
    delivery::deliver_once,
    execution::{dispatch, execute_record},
    polling::poll_once,
    runtime::{Context, TelegramAdapter},
    types::*,
};
use crate::{
    app::WorkbenchApp,
    config::{
        Config, LimitsConfig, SessionsConfig, StorageConfig, TelegramConfig, WorkerConfig,
        WorkersConfig,
    },
    domain::{query::CommitBatch, DomainCommand, SessionStatus},
    persistence::outbox::DeliveryFailure,
};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Mutex;
#[derive(Default)]
struct FakeState {
    updates: VecDeque<WireUpdate>,
    sent: Vec<SendMessage>,
    media: Vec<SendMedia>,
    media_attempts: usize,
    sequence: Vec<String>,
    fail_media: bool,
    topics: usize,
    answers: usize,
    lose_topic_response: bool,
    fail_send: bool,
    fail_text: Option<String>,
    fail_poll: bool,
}
#[derive(Clone, Default)]
struct Fake(Arc<Mutex<FakeState>>);
fn user(bot: bool) -> WireUser {
    WireUser {
        id: UserId::new(if bot { 99 } else { 5 }).unwrap(),
        is_bot: bot,
        username: Some(if bot { "fixture_bot" } else { "user" }.into()),
    }
}
fn message(id: i64, thread: Option<TopicId>, text: Option<String>) -> WireMessage {
    WireMessage {
        message_id: MessageId::new(id).unwrap(),
        chat: WireChat {
            id: ChatId::new(-100).unwrap(),
            is_forum: true,
        },
        message_thread_id: thread,
        from: Some(user(false)),
        text,
    }
}
fn update(id: u64, thread: Option<TopicId>, text: &str) -> WireUpdate {
    WireUpdate {
        update_id: UpdateId::new(id).unwrap(),
        message: Some(message(id as i64, thread, Some(text.into()))),
        callback_query: None,
    }
}
impl BotApi for Fake {
    async fn get_me(&self) -> Result<WireUser, ApiError> {
        Ok(user(true))
    }
    async fn get_updates(&self, offset: u64) -> Result<Vec<WireUpdate>, ApiError> {
        let state = self.0.lock().await;
        if state.fail_poll {
            return Err(ApiError::Response {
                code: 401,
                retry_after: None,
            });
        }
        Ok(state
            .updates
            .iter()
            .filter(|update| update.update_id.get() >= offset)
            .cloned()
            .collect())
    }
    async fn send_message(&self, request: &SendMessage) -> Result<WireMessage, ApiError> {
        let mut state = self.0.lock().await;
        let matching_failure = state.fail_text.as_deref() == Some(request.text.as_str());
        if matching_failure {
            state.fail_text = None;
        }
        if matching_failure || std::mem::take(&mut state.fail_send) {
            return Err(ApiError::Response {
                code: 429,
                retry_after: Some(120),
            });
        }
        state.sequence.push(format!("text:{}", request.text));
        state.sent.push(request.clone());
        Ok(message(
            state.sent.len() as i64,
            request.message_thread_id,
            Some(request.text.clone()),
        ))
    }
    async fn send_media(&self, request: &SendMedia) -> Result<WireMessage, ApiError> {
        let mut state = self.0.lock().await;
        state.media_attempts += 1;
        if std::mem::take(&mut state.fail_media) {
            return Err(ApiError::Response {
                code: 429,
                retry_after: Some(120),
            });
        }
        state.sequence.push("image".into());
        state.media.push(request.clone());
        Ok(message(
            1000 + state.media.len() as i64,
            request.message_thread_id,
            None,
        ))
    }
    async fn answer_callback(&self, _: &str, _: &str) -> Result<(), ApiError> {
        self.0.lock().await.answers += 1;
        Ok(())
    }
    async fn create_topic(&self, _: ChatId, _: &str) -> Result<ForumTopic, ApiError> {
        let mut state = self.0.lock().await;
        state.topics += 1;
        if std::mem::take(&mut state.lose_topic_response) {
            return Err(ApiError::Transport);
        }
        Ok(ForumTopic {
            message_thread_id: TopicId::new(100 + state.topics as i64).unwrap(),
        })
    }
}
fn root() -> PathBuf {
    std::env::temp_dir().join(format!("workbench-tg-runtime-{}", uuid::Uuid::new_v4()))
}
#[path = "deleted_delivery_tests.rs"]
mod deleted_delivery_tests;
#[path = "delivery_tests.rs"]
mod delivery_tests;
#[path = "execution_tests.rs"]
mod execution_tests;
#[path = "history_tests.rs"]
mod history_tests;
#[path = "menu_tests.rs"]
mod menu_tests;
#[path = "parallel_delivery_tests.rs"]
mod parallel_delivery_tests;
#[path = "preferences_tests.rs"]
mod preferences_tests;
fn app(root: &Path) -> WorkbenchApp {
    app_with_env(root, Default::default())
}
fn app_with_env(root: &Path, env: std::collections::HashMap<String, String>) -> WorkbenchApp {
    WorkbenchApp::new(Config {
        workers: WorkersConfig {
            pi: Some(WorkerConfig {
                command: "node".into(),
                args: vec![PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../test/contract-agent.mjs")
                    .to_string_lossy()
                    .into_owned()],
                env,
            }),
            ..Default::default()
        },
        sessions: SessionsConfig {
            mailbox: 128,
            max_workers: 16,
        },
        telegram: None,
        storage: StorageConfig { root: root.into() },
        limits: LimitsConfig {
            pending_interactions: 32,
        },
    })
    .unwrap()
}
fn config() -> TelegramConfig {
    TelegramConfig {
        bot_token_env: "TEST_TOKEN".into(),
        workspace: crate::domain::WorkspacePath::new("/tmp").unwrap(),
        allowed_chat_ids: vec![ChatId::new(-100).unwrap()],
        allowed_user_ids: vec![UserId::new(5).unwrap()],
        api_base: "https://api.telegram.org/".into(),
        inbox_capacity: 128,
    }
}
async fn execute(context: &Context<Fake>) {
    for record in context.store.pending(32).await.unwrap() {
        execute_record(context, &record).await.unwrap();
    }
}
async fn finished(events: &mut tokio::sync::broadcast::Receiver<CommitBatch>) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(view) = events.recv().await.unwrap().view {
                match view.status {
                    SessionStatus::Idle if view.active_turn.is_none() => break,
                    SessionStatus::Failed(error) => panic!("{error}"),
                    _ => {}
                }
            }
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn shared_runtime_forum_permission_callback_and_429_retry_never_rerun_agent() {
    let root = root();
    let app = app(&root);
    let api = Fake::default();
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    api.0
        .lock()
        .await
        .updates
        .push_back(update(1, None, "/new"));
    poll_once(&context).await.unwrap();
    execute(&context).await;
    deliver_once(&context).await.unwrap();
    let bindings = context.store.snapshot().await.unwrap().bindings;
    let (topic, session) = bindings.into_iter().next().unwrap();
    assert!(topic.thread.is_some());
    assert_eq!(api.0.lock().await.topics, 1);
    poll_once(&context).await.unwrap();
    execute(&context).await;
    assert_eq!(api.0.lock().await.topics, 1);
    let mut events = app.subscribe();
    api.0
        .lock()
        .await
        .updates
        .push_back(update(2, topic.thread, "permission"));
    poll_once(&context).await.unwrap();
    execute(&context).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if events
                .recv()
                .await
                .unwrap()
                .view
                .is_some_and(|view| !view.pending_interactions.is_empty())
            {
                break;
            }
        }
    })
    .await
    .unwrap();
    deliver_once(&context).await.unwrap();
    let button = api
        .0
        .lock()
        .await
        .sent
        .last()
        .unwrap()
        .reply_markup
        .as_ref()
        .unwrap()
        .inline_keyboard[0][0]
        .callback_data
        .clone();
    api.0.lock().await.updates.push_back(WireUpdate {
        update_id: UpdateId::new(3).unwrap(),
        message: None,
        callback_query: Some(WireCallback {
            id: "query-3".into(),
            from: user(false),
            message: Some(message(3, topic.thread, None)),
            data: Some(button.as_str().into()),
        }),
    });
    poll_once(&context).await.unwrap();
    execute(&context).await;
    finished(&mut events).await;
    let before = context
        .inspect(&session)
        .await
        .unwrap()
        .unwrap()
        .last_entry_seq;
    api.0.lock().await.fail_send = true;
    deliver_once(&context).await.unwrap();
    let pending = app.delivery_store().pending(u64::MAX, 16).await.unwrap();
    assert_eq!(pending.len(), 1);
    assert!(matches!(
        pending[0].last_failure,
        Some(DeliveryFailure::RateLimited)
    ));
    app.delivery_store()
        .fail(&pending[0].event.id, DeliveryFailure::RateLimited, 0)
        .await
        .unwrap();
    deliver_once(&context).await.unwrap();
    assert_eq!(
        context
            .inspect(&session)
            .await
            .unwrap()
            .unwrap()
            .last_entry_seq,
        before
    );
    assert_eq!(api.0.lock().await.answers, 1);
    assert!(api
        .0
        .lock()
        .await
        .sent
        .iter()
        .any(|message| message.text == "Turn completed."));
    api.0
        .lock()
        .await
        .updates
        .push_back(update(4, topic.thread, "plan-report"));
    poll_once(&context).await.unwrap();
    execute(&context).await;
    finished(&mut events).await;
    deliver_once(&context).await.unwrap();
    assert!(!api
        .0
        .lock()
        .await
        .sent
        .iter()
        .any(|message| message.text.contains("Plan:")));
    api.0
        .lock()
        .await
        .updates
        .push_back(update(5, topic.thread, "/status@fixture_bot"));
    poll_once(&context).await.unwrap();
    execute(&context).await;
    deliver_once(&context).await.unwrap();
    assert!(api
        .0
        .lock()
        .await
        .sent
        .last()
        .unwrap()
        .text
        .contains("Plan:"));
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn image_delivery_retries_after_restart_from_immutable_archive_in_order_without_agent_reexecution(
) {
    let root = root();
    let trace = root.with_extension("peer-trace");
    let first = app_with_env(
        &root,
        std::collections::HashMap::from([(
            "WORKBENCH_CONTRACT_TRACE".into(),
            trace.to_string_lossy().into_owned(),
        )]),
    );
    let api = Fake::default();
    let context = Context::new(first.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    api.0
        .lock()
        .await
        .updates
        .push_back(update(1, None, "/new"));
    poll_once(&context).await.unwrap();
    execute(&context).await;
    deliver_once(&context).await.unwrap();
    let (topic, session) = context
        .store
        .snapshot()
        .await
        .unwrap()
        .bindings
        .into_iter()
        .next()
        .unwrap();
    api.0.lock().await.sequence.clear();
    let mut events = first.subscribe();
    api.0
        .lock()
        .await
        .updates
        .push_back(update(2, topic.thread, "image-output"));
    poll_once(&context).await.unwrap();
    execute(&context).await;
    finished(&mut events).await;
    let before = context.inspect(&session).await.unwrap().unwrap();
    let image = first
        .database()
        .history(session.clone(), None, None)
        .await
        .unwrap()
        .entries
        .iter()
        .find_map(|entry| entry.image.clone())
        .unwrap();
    let original = first
        .delivery_payloads()
        .image(&image)
        .await
        .unwrap()
        .bytes()
        .to_vec();
    api.0.lock().await.fail_media = true;
    deliver_once(&context).await.unwrap();
    let pending = first.delivery_store().pending(u64::MAX, 16).await.unwrap();
    assert_eq!(pending.len(), 1);
    assert!(matches!(
        pending[0].last_failure,
        Some(DeliveryFailure::RateLimited)
    ));
    assert_eq!(api.0.lock().await.media_attempts, 1);
    let input_sequence = api.0.lock().await.sequence.clone();
    assert_eq!(input_sequence.len(), 2);
    assert!(input_sequence[0].starts_with("text:User input · session"));
    assert_eq!(input_sequence[1], "text:image-output");
    delivery_tests::notice(&first, &topic, "later notice".into(), 0).await;
    first.shutdown_checked().await.unwrap();
    let peer_before = tokio::fs::read(&trace).await.unwrap();
    let second = app_with_env(
        &root,
        std::collections::HashMap::from([(
            "WORKBENCH_CONTRACT_TRACE".into(),
            trace.to_string_lossy().into_owned(),
        )]),
    );
    let context = Context::new(
        second.clone(),
        api.clone(),
        &root.join("telegram"),
        config(),
    )
    .await
    .unwrap();
    deliver_once(&context).await.unwrap();
    assert_eq!(
        api.0.lock().await.media_attempts,
        1,
        "retry_after survives restart"
    );
    assert!(
        api.0.lock().await.sequence == input_sequence,
        "the deferred session head also blocks a direct Telegram notice to its topic"
    );
    second
        .delivery_store()
        .fail(&pending[0].event.id, DeliveryFailure::RateLimited, 0)
        .await
        .unwrap();
    deliver_once(&context).await.unwrap();
    deliver_once(&context).await.unwrap();
    let state = api.0.lock().await;
    assert_eq!(state.media.len(), 1);
    assert_eq!(state.media_attempts, 2);
    assert_eq!(state.media[0].asset.bytes(), original);
    assert_eq!(state.media[0].message_thread_id, topic.thread);
    assert_eq!(
        &state.sequence[2..],
        ["image", "text:image caption", "text:later notice"]
    );
    drop(state);
    assert!(second
        .delivery_store()
        .pending(u64::MAX, 16)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        serde_json::to_vec(&context.inspect(&session).await.unwrap().unwrap()).unwrap(),
        serde_json::to_vec(&before).unwrap()
    );
    assert_eq!(
        tokio::fs::read(&trace).await.unwrap(),
        peer_before,
        "delivery restart must not spawn ACP"
    );
    poll_once(&context).await.unwrap();
    execute(&context).await;
    assert_eq!(tokio::fs::read(&trace).await.unwrap(), peer_before);
    second.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
    tokio::fs::remove_file(trace).await.unwrap();
}
#[tokio::test]
async fn mixed_unicode_text_image_parts_and_standalone_image_ids_preserve_archive_order() {
    use crate::{
        domain::{
            fork::ContentHash,
            image::ImageAsset,
            query::{ContentKind, ContentRef, SafeInteger},
            transcript::EntryRole,
            transition::{NewContent, NewEntry, Transition},
            ContentId, DeliveryId, EntryId, ProviderMessageId, TurnId,
        },
        persistence::outbox::{DeliveryEvent, DeliveryPayload},
    };
    let root = root();
    let app = app(&root);
    let api = Fake::default();
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    let topic = TopicKey {
        chat: ChatId::new(-100).unwrap(),
        thread: Some(TopicId::new(101).unwrap()),
    };
    let asset = ImageAsset::from_base64("image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=").unwrap();
    app.delivery_payloads().put_image(&asset).await.unwrap();
    let turn = TurnId::generate();
    let group = ProviderMessageId::generate();
    let mut view = crate::domain::tests::state();
    view.cwd = config().workspace;
    app.database().create(view.clone()).await.unwrap();
    context
        .store
        .bind(topic.clone(), view.id.clone())
        .await
        .unwrap();
    let mut append = Vec::new();
    for (text, image, message) in [
        ("前", None, group.clone()),
        ("🌏", None, group.clone()),
        ("", Some(asset.image().clone()), group.clone()),
        ("后🌏", None, group),
        ("next", None, ProviderMessageId::generate()),
    ] {
        let sha256 = ContentHash::of(text);
        append.push(NewEntry {
            id: EntryId::generate(),
            turn: turn.clone(),
            role: EntryRole::Agent,
            message: Some(message),
            text: NewContent {
                content: ContentRef {
                    id: ContentId::new(format!("fixture-{}", sha256.as_str())).unwrap(),
                    sha256,
                    bytes: SafeInteger::new(text.len() as u64).unwrap(),
                    kind: ContentKind::Text,
                },
                text: text.into(),
            },
            image: image.map(|_| asset.clone()),
        });
    }
    view.revision = SafeInteger::new(1).unwrap();
    view.last_entry_seq = SafeInteger::new(5).unwrap();
    app.database()
        .commit(Transition {
            operation: None,
            expected_revision: Default::default(),
            next: view.clone(),
            append,
            contents: vec![],
            tool_updates: vec![],
            deliveries: vec![DeliveryEvent {
                id: DeliveryId::generate(),
                target: crate::domain::transition::DeliveryTarget::Session {
                    session: view.id.clone(),
                    cwd: view.cwd.clone(),
                },
                revision: view.revision,
                payload: DeliveryPayload::Turn {
                    session: view.id,
                    turn,
                    first_seq: SafeInteger::new(1).unwrap(),
                    last_seq: SafeInteger::new(5).unwrap(),
                },
            }],
        })
        .await
        .unwrap();
    deliver_once(&context).await.unwrap();
    assert_eq!(
        api.0.lock().await.sequence,
        ["text:前🌏", "image", "text:后🌏\n\nnext"]
    );
    app.delivery_store()
        .enqueue(DeliveryEvent {
            id: DeliveryId::generate(),
            target: topic.delivery_target(99, config().workspace),
            revision: crate::domain::query::SafeInteger::new(2).unwrap(),
            payload: DeliveryPayload::Image {
                image: asset.image().id().clone(),
            },
        })
        .await
        .unwrap();
    deliver_once(&context).await.unwrap();
    assert_eq!(api.0.lock().await.media.len(), 2);
    assert!(app
        .delivery_store()
        .pending(u64::MAX, 16)
        .await
        .unwrap()
        .is_empty());
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn topic_creation_committed_but_response_lost_never_creates_a_second_topic() {
    let root = root();
    let app = app(&root);
    let api = Fake::default();
    api.0.lock().await.lose_topic_response = true;
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    api.0
        .lock()
        .await
        .updates
        .push_back(update(1, None, "/new"));
    poll_once(&context).await.unwrap();
    let record = context.store.pending(8).await.unwrap().remove(0);
    execute_record(&context, &record).await.unwrap();
    execute_record(&context, &record).await.unwrap();
    assert_eq!(api.0.lock().await.topics, 1);
    assert!(app.list(None, None).await.unwrap().sessions.is_empty());
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn restart_between_side_effect_and_inbox_completion_replays_topic_and_session_receipts() {
    let root = root();
    let first = app(&root);
    let api = Fake::default();
    let context = Context::new(first.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    api.0
        .lock()
        .await
        .updates
        .push_back(update(1, None, "/new"));
    poll_once(&context).await.unwrap();
    let record = context.store.pending(8).await.unwrap().remove(0);
    dispatch(&context, &record).await.unwrap(); // crash window before notice/inbox completion
    first.shutdown().await;
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    sql.execute(
        "UPDATE telegram_effects SET effect_id='hidden-topic-1' WHERE effect_id='topic-1'",
        [],
    )
    .unwrap();
    sql.close().unwrap();
    let second = app(&root);
    let restarted = Context::new(
        second.clone(),
        api.clone(),
        &root.join("telegram"),
        config(),
    )
    .await
    .unwrap();
    assert!(execute_record(&restarted, &record).await.is_err());
    assert_eq!(api.0.lock().await.topics, 1); // missing receipt cannot authorize another effect
    second.shutdown().await;
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    sql.execute(
        "UPDATE telegram_effects SET effect_id='topic-1' WHERE effect_id='hidden-topic-1'",
        [],
    )
    .unwrap();
    sql.close().unwrap();
    let second = app(&root);
    let restarted = Context::new(
        second.clone(),
        api.clone(),
        &root.join("telegram"),
        config(),
    )
    .await
    .unwrap();
    execute(&restarted).await;
    deliver_once(&restarted).await.unwrap();
    assert_eq!(api.0.lock().await.topics, 1);
    assert_eq!(second.list(None, None).await.unwrap().sessions.len(), 1);
    assert_eq!(api.0.lock().await.sent.len(), 1);
    let (topic, session) = restarted
        .store
        .snapshot()
        .await
        .unwrap()
        .bindings
        .into_iter()
        .next()
        .unwrap();
    api.0
        .lock()
        .await
        .updates
        .push_back(update(2, topic.thread, "/remove"));
    poll_once(&restarted).await.unwrap();
    let remove = restarted.store.pending(8).await.unwrap().remove(0);
    dispatch(&restarted, &remove).await.unwrap(); // history is already gone
    execute_record(&restarted, &remove).await.unwrap();
    assert!(restarted.inspect(&session).await.unwrap().is_none());
    assert!(restarted.store.pending(8).await.unwrap().is_empty());
    second.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn fatal_poll_is_reported_and_all_adapter_tasks_are_joined() {
    let root = root();
    let app = app(&root);
    let api = Fake::default();
    api.0.lock().await.fail_poll = true;
    let mut adapter = TelegramAdapter::start(app.clone(), api, &root.join("telegram"), config())
        .await
        .unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(2), adapter.wait())
        .await
        .unwrap()
        .is_err());
    adapter.shutdown().await.unwrap();
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[test]
fn unicode_render_chunks_preserve_every_character_within_telegram_utf16_limit() {
    let text = "你好🙂\n".repeat(5000);
    let chunks = super::render::split_text(&text);
    assert!(chunks
        .iter()
        .all(|chunk| chunk.encode_utf16().count() <= 4000));
    assert_eq!(chunks.concat(), text);
}
