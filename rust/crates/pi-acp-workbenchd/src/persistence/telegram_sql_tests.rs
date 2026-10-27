//! Admission and effect safety across real close/join/reopen boundaries.
use super::{
    database::Database,
    format::StorageLease,
    inbox::{Admission, TelegramStore},
    sqlite_tests::Root,
};
use crate::{
    domain::{
        interaction::{InteractionAnswer, InteractionResponse},
        DeliveryId, InteractionId, SessionId,
    },
    telegram::{
        command::{TelegramAction, TelegramCommand},
        types::{CallbackBinding, CallbackKey, ChatId, TopicKey, UpdateId, UserId},
    },
};
#[tokio::test]
async fn telegram_sql_admission_rolls_back_consumed_callback_offset_and_record_together() {
    let root = Root::new();
    let lease = StorageLease::lock(&root.data()).unwrap();
    let database = Database::open(root.data(), &lease).await.unwrap();
    let store = TelegramStore::new(database.clone(), 8);
    store.claim_bot(UserId::new(1).unwrap()).await.unwrap();
    let topic = TopicKey {
        chat: ChatId::new(-100).unwrap(),
        thread: None,
    };
    let session = SessionId::generate();
    store.bind(topic.clone(), session.clone()).await.unwrap();
    let key = CallbackKey::for_option(&DeliveryId::generate(), 0);
    let answer = InteractionAnswer {
        interaction: InteractionId::generate(),
        response: InteractionResponse::Permission {
            option: "allow".into(),
        },
    };
    store
        .register_callback(
            key.clone(),
            CallbackBinding {
                topic: topic.clone(),
                action: crate::telegram::types::CallbackAction::Answer {
                    session: session.clone(),
                    answer: answer.clone(),
                },
                expires_at: 100,
                used_by: None,
            },
        )
        .await
        .unwrap();
    let original = serde_json::to_vec(&store.snapshot().await.unwrap()).unwrap();
    database.shutdown().await.unwrap();
    let sql = rusqlite::Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    sql.execute_batch("CREATE TRIGGER reject_admission BEFORE INSERT ON telegram_inbox BEGIN SELECT RAISE(ABORT,'test late admission failure'); END").unwrap();
    sql.close().unwrap();
    let database = Database::open(root.data(), &lease).await.unwrap();
    let store = TelegramStore::new(database.clone(), 8);
    let admission = |expected| Admission {
        id: UpdateId::new(10).unwrap(),
        sender: Some(UserId::new(5).unwrap()),
        command: Some(TelegramCommand {
            topic: topic.clone(),
            action: TelegramAction::Answer {
                session: session.clone(),
                answer: answer.clone(),
                card: None,
            },
        }),
        callback: Some(key.clone()),
        callback_query: Some("query-10".into()),
        expected_binding: expected,
    };
    assert!(store.admit(admission(Some(session.clone()))).await.is_err());
    assert_eq!(
        serde_json::to_vec(&store.snapshot().await.unwrap()).unwrap(),
        original
    );
    database.shutdown().await.unwrap();
    let sql = rusqlite::Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    sql.execute_batch("DROP TRIGGER reject_admission").unwrap();
    sql.close().unwrap();
    let database = Database::open(root.data(), &lease).await.unwrap();
    let store = TelegramStore::new(database.clone(), 8);
    // The expected binding is checked in the same transaction as consumption.
    assert!(store.admit(admission(None)).await.is_err());
    assert_eq!(
        serde_json::to_vec(&store.snapshot().await.unwrap()).unwrap(),
        original
    );
    let paused = database.pause_executor().await.unwrap();
    let (reply, observer) = tokio::sync::oneshot::channel();
    database
        .enqueue(super::database::StoreRequest::TelegramInbox(Box::new(
            super::inbox::Request {
                action: super::inbox::Action::Admit(admission(Some(session.clone()))),
                max_pending: 8,
                reply,
            },
        )))
        .await
        .unwrap();
    drop(observer);
    drop(paused);
    // A subsequent typed read is ordered after the accepted request. Losing its
    // observer cannot cancel callback consumption or advance just the offset.
    let state = store.snapshot().await.unwrap();
    assert_eq!(state.offset, 11);
    assert_eq!(
        state.callbacks[&key].used_by,
        Some(UpdateId::new(10).unwrap())
    );
    assert_eq!(state.inbox.len(), 1);
    database.shutdown().await.unwrap();
    let database = Database::open(root.data(), &lease).await.unwrap();
    let store = TelegramStore::new(database.clone(), 8);
    assert_eq!(
        serde_json::to_vec(&store.snapshot().await.unwrap()).unwrap(),
        serde_json::to_vec(&state).unwrap()
    );
    database.shutdown().await.unwrap();
}
