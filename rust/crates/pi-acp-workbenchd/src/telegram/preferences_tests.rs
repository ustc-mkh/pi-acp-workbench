use super::delivery_tests::{notice, topic};
use super::*;
use crate::{
    domain::{query::CommandReceipt, Harness, SessionId, WorkspacePath},
    telegram::{
        command::{parse_text, ControlCommand, TelegramAction},
        types::TopicPreferences,
    },
};

async fn command(context: &Context<impl BotApi>, api: &Fake, id: u64, thread: i64, text: &str) {
    api.0
        .lock()
        .await
        .updates
        .push_back(update(id, Some(TopicId::new(thread).unwrap()), text));
    poll_once(context).await.unwrap();
    for record in context.store.pending(32).await.unwrap() {
        execute_record(context, &record).await.unwrap();
    }
}
async fn bound(context: &Context<impl BotApi>, destination: &TopicKey) -> SessionId {
    let CommandReceipt::Created { summary } = context
        .app
        .command(DomainCommand::CreateSession {
            harness: Harness::Pi,
            cwd: WorkspacePath::new("/tmp").unwrap(),
        })
        .await
        .unwrap()
    else {
        panic!("create")
    };
    context
        .store
        .bind(destination.clone(), summary.id.clone())
        .await
        .unwrap();
    summary.id
}

#[test]
fn preference_parser_accepts_only_explicit_absolute_values_without_a_session() {
    let cwd = WorkspacePath::new("/tmp").unwrap();
    for (suffix, expected) in [("", None), (" on", Some(true)), (" off", Some(false))] {
        assert!(
            matches!(parse_text(None, &format!("/notifications{suffix}"), &cwd, 1), Ok(TelegramAction::Control(ControlCommand::Notifications { enabled })) if enabled == expected)
        );
        assert!(
            matches!(parse_text(None, &format!("/silent{suffix}"), &cwd, 1), Ok(TelegramAction::Control(ControlCommand::Silent { enabled })) if enabled == expected)
        );
    }
    for text in [
        "/silent toggle",
        "/silent true",
        "/notifications 0",
        "/notifications on off",
        "/silent@unknown on",
    ] {
        assert!(parse_text(None, text, &cwd, 1).is_err(), "{text}");
    }
}

#[tokio::test]
async fn preferences_are_cold_topic_scoped_authorized_and_persist_across_restart() {
    let root = root();
    let trace = root.join("trace");
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
    assert_eq!(
        context.store.preferences(&topic(101)).await.unwrap(),
        TopicPreferences::default()
    );
    let journal = first.journal_snapshot().await.unwrap();
    command(&context, &api, 1, 101, "/notifications off").await;
    command(&context, &api, 2, 101, "/silent on").await;
    command(&context, &api, 3, 101, "/notifications").await;
    let mut denied = update(4, Some(TopicId::new(102).unwrap()), "/notifications off");
    denied.message.as_mut().unwrap().from.as_mut().unwrap().id = UserId::new(6).unwrap();
    api.0.lock().await.updates.push_back(denied);
    poll_once(&context).await.unwrap();
    execute(&context).await;
    assert_eq!(
        context.store.preferences(&topic(101)).await.unwrap(),
        TopicPreferences {
            notifications: false,
            silent: true
        }
    );
    assert_eq!(
        context.store.preferences(&topic(102)).await.unwrap(),
        TopicPreferences::default()
    );
    assert_eq!(first.journal_snapshot().await.unwrap(), journal);
    assert!(!trace.exists(), "settings must not start a provider");
    first.shutdown_checked().await.unwrap();
    let second = app(&root);
    let context = Context::new(
        second.clone(),
        api.clone(),
        &root.join("telegram"),
        config(),
    )
    .await
    .unwrap();
    assert_eq!(
        context.store.preferences(&topic(101)).await.unwrap(),
        TopicPreferences {
            notifications: false,
            silent: true
        }
    );
    // Restoring a topic's defaults does not alter another topic or bind a session.
    command(&context, &api, 5, 101, "/notifications on").await;
    command(&context, &api, 6, 101, "/silent off").await;
    assert_eq!(
        context.store.preferences(&topic(101)).await.unwrap(),
        TopicPreferences::default()
    );
    assert!(context.store.binding(&topic(101)).await.unwrap().is_none());
    command(&context, &api, 7, 101, "/silent toggle").await;
    deliver_once(&context).await.unwrap();
    assert!(api
        .0
        .lock()
        .await
        .sent
        .iter()
        .any(|m| m.text.contains("未执行")));
    assert!(!trace.exists());
    second.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn notifications_off_skips_only_automatic_success_preserving_agent_history_authorization_and_errors(
) {
    let root = root();
    let app = app(&root);
    let api = Fake::default();
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    let session = bound(&context, &topic(101)).await;
    command(&context, &api, 1, 101, "/notifications off").await;
    deliver_once(&context).await.unwrap();
    api.0.lock().await.sent.clear();
    let mut events = app.subscribe();
    command(&context, &api, 2, 101, "image-output").await;
    finished(&mut events).await;
    let snapshot = context.inspect(&session).await.unwrap().unwrap();
    assert!(matches!(snapshot.status, SessionStatus::Idle));
    assert!(snapshot.last_entry_seq.get() >= 3);
    let journal = app.journal_snapshot().await.unwrap();
    deliver_once(&context).await.unwrap();
    assert!(api.0.lock().await.sent.is_empty());
    assert!(api.0.lock().await.media.is_empty());
    assert!(app
        .delivery_store()
        .pending(u64::MAX, 32)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(app.journal_snapshot().await.unwrap(), journal);
    command(&context, &api, 3, 101, "/history").await;
    command(&context, &api, 4, 101, "/status").await;
    deliver_once(&context).await.unwrap();
    assert!(api
        .0
        .lock()
        .await
        .sent
        .iter()
        .any(|m| m.text.contains("image caption")));
    command(&context, &api, 5, 101, "permission").await;
    let interaction = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(interaction) = events
                .recv()
                .await
                .unwrap()
                .view
                .and_then(|v| v.pending_interactions.into_values().next())
            {
                break interaction.id;
            }
        }
    })
    .await
    .unwrap();
    deliver_once(&context).await.unwrap();
    assert!(api
        .0
        .lock()
        .await
        .sent
        .iter()
        .any(|m| m.reply_markup.is_some()));
    assert!(
        context
            .inspect(&session)
            .await
            .unwrap()
            .unwrap()
            .active_turn
            .is_some(),
        "notifications off must not cancel a waiting task"
    );
    command(
        &context,
        &api,
        6,
        101,
        &format!("/answer {interaction} yes"),
    )
    .await;
    finished(&mut events).await;
    deliver_once(&context).await.unwrap();
    command(&context, &api, 7, 101, "crash").await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if events
                .recv()
                .await
                .unwrap()
                .view
                .is_some_and(|v| matches!(v.status, SessionStatus::Failed(_)))
            {
                break;
            }
        }
    })
    .await
    .unwrap();
    deliver_once(&context).await.unwrap();
    assert!(api
        .0
        .lock()
        .await
        .sent
        .iter()
        .any(|m| m.text.starts_with("Session error:")));
    let media_before = api.0.lock().await.media.len();
    command(&context, &api, 8, 101, "/notifications on").await;
    deliver_once(&context).await.unwrap();
    assert_eq!(
        api.0.lock().await.media.len(),
        media_before,
        "re-enable must not replay skipped results"
    );
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn silent_policy_applies_to_text_and_media_retries_without_suppressing_or_reexecuting() {
    let root = root();
    let first = app(&root);
    let api = Fake::default();
    let context = Context::new(first.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    let session = bound(&context, &topic(101)).await;
    command(&context, &api, 1, 101, "/silent on").await;
    deliver_once(&context).await.unwrap();
    let mut events = first.subscribe();
    command(&context, &api, 2, 101, "image-output").await;
    finished(&mut events).await;
    let journal = first.journal_snapshot().await.unwrap();
    api.0.lock().await.fail_media = true;
    deliver_once(&context).await.unwrap();
    let pending = first.delivery_store().pending(u64::MAX, 32).await.unwrap();
    assert_eq!(pending.len(), 1);
    first
        .delivery_store()
        .fail(&pending[0].event.id, DeliveryFailure::RateLimited, 0)
        .await
        .unwrap();
    first.shutdown_checked().await.unwrap();
    let second = app(&root);
    let context = Context::new(
        second.clone(),
        api.clone(),
        &root.join("telegram"),
        config(),
    )
    .await
    .unwrap();
    notice(&second, &topic(102), "other topic".into(), 1).await;
    deliver_once(&context).await.unwrap();
    let state = api.0.lock().await;
    assert!(state.media.iter().all(|m| m.disable_notification));
    assert_eq!(state.media.len(), 1);
    assert!(state
        .sent
        .iter()
        .any(|m| m.text == "image caption" && m.disable_notification));
    assert!(state
        .sent
        .iter()
        .any(|m| m.text == "other topic" && !m.disable_notification));
    drop(state);
    assert_eq!(second.journal_snapshot().await.unwrap(), journal);
    assert!(context
        .inspect(&session)
        .await
        .unwrap()
        .unwrap()
        .active_turn
        .is_none());
    second.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[derive(Clone)]
struct GateApi {
    base: Fake,
    first: Arc<std::sync::atomic::AtomicBool>,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Semaphore>,
}
impl BotApi for GateApi {
    async fn get_me(&self) -> Result<WireUser, ApiError> {
        self.base.get_me().await
    }
    async fn get_updates(&self, offset: u64) -> Result<Vec<WireUpdate>, ApiError> {
        self.base.get_updates(offset).await
    }
    async fn send_message(&self, message: &SendMessage) -> Result<WireMessage, ApiError> {
        if self.first.swap(false, std::sync::atomic::Ordering::SeqCst) {
            self.entered.notify_one();
            self.release.acquire().await.unwrap().forget();
        }
        self.base.send_message(message).await
    }
    async fn answer_callback(&self, query: &str, text: &str) -> Result<(), ApiError> {
        self.base.answer_callback(query, text).await
    }
    async fn create_topic(&self, chat: ChatId, name: &str) -> Result<ForumTopic, ApiError> {
        self.base.create_topic(chat, name).await
    }
}
#[tokio::test]
async fn preference_changes_are_rechecked_between_multipart_sends_not_used_to_recall_inflight_http()
{
    use crate::{
        domain::{
            query::SafeInteger,
            transcript::{EntryRole, TranscriptEntry},
            DeliveryId, EntryId, TurnId,
        },
        persistence::outbox::{DeliveryEvent, DeliveryPayload},
    };
    for mute in [true, false] {
        let root = root();
        let app = app(&root);
        let api = GateApi {
            base: Fake::default(),
            first: Arc::new(true.into()),
            entered: Default::default(),
            release: Arc::new(tokio::sync::Semaphore::new(0)),
        };
        let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
            .await
            .unwrap();
        let session = bound(&context, &topic(101)).await;
        let entry = TranscriptEntry {
            id: EntryId::generate(),
            turn: TurnId::generate(),
            role: EntryRole::Agent,
            text: "🚀".repeat(5000),
            message: None,
            image: None,
        };
        app.delivery_payloads().put_entry(&entry).await.unwrap();
        app.delivery_store()
            .enqueue(DeliveryEvent {
                id: DeliveryId::generate(),
                revision: SafeInteger::new(1).unwrap(),
                target: crate::domain::transition::DeliveryTarget::Session {
                    session,
                    cwd: WorkspacePath::new("/tmp").unwrap(),
                },
                payload: DeliveryPayload::Entry { entry: entry.id },
            })
            .await
            .unwrap();
        let sending = {
            let context = context.clone();
            tokio::spawn(async move { deliver_once(&context).await })
        };
        tokio::time::timeout(Duration::from_secs(3), api.entered.notified())
            .await
            .unwrap();
        command(
            &context,
            &api.base,
            1,
            101,
            if mute {
                "/notifications off"
            } else {
                "/silent on"
            },
        )
        .await;
        api.release.add_permits(1);
        tokio::time::timeout(Duration::from_secs(5), sending)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let state = api.base.0.lock().await;
        let chunks: Vec<_> = state
            .sent
            .iter()
            .filter(|m| m.text.starts_with('🚀'))
            .collect();
        assert_eq!(chunks.len(), if mute { 1 } else { 3 });
        assert!(!chunks[0].disable_notification);
        assert_eq!(chunks[0].text.encode_utf16().count(), 4000);
        if !mute {
            assert!(chunks[1..].iter().all(|m| m.disable_notification));
        }
        drop(state);
        assert!(app
            .delivery_store()
            .pending(u64::MAX, 32)
            .await
            .unwrap()
            .is_empty());
        app.shutdown_checked().await.unwrap();
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
