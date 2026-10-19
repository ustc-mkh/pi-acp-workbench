use crate::{
    domain::{
        interaction::{InteractionAnswer, InteractionResponse},
        DeliveryId, InteractionId, SessionId,
    },
    persistence::{
        database::Database,
        format::StorageLease,
        inbox::{Admission, TelegramStore},
        sqlite_tests::Root,
    },
    telegram::{
        command::{ControlCommand, TelegramAction, TelegramCommand},
        state::InboxOutcome,
        types::{
            CallbackAction, CallbackBinding, CallbackKey, ChatId, TopicId, TopicKey, UpdateId,
            UserId,
        },
    },
};
fn topic() -> TopicKey {
    TopicKey {
        chat: ChatId::new(-100).unwrap(),
        thread: Some(TopicId::new(1).unwrap()),
    }
}
fn menu() -> CallbackBinding {
    CallbackBinding {
        topic: topic(),
        action: CallbackAction::Control {
            command: ControlCommand::Help,
            expected_binding: None,
        },
        expires_at: 100,
        used_by: None,
    }
}

#[tokio::test]
async fn menu_callback_capacity_reserves_authorization_and_reclaims_only_expired_unowned_keys() {
    let root = Root::new();
    let lease = StorageLease::lock(&root.data()).unwrap();
    let database = Database::open(root.data(), &lease).await.unwrap();
    let store = TelegramStore::new(database.clone(), 16);
    store.claim_bot(UserId::new(99).unwrap()).await.unwrap();
    database.shutdown().await.unwrap();
    let event = DeliveryId::generate();
    let keys: Vec<_> = (0..3072)
        .map(|index| CallbackKey::for_option(&event, index))
        .collect();
    let mut sql = rusqlite::Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    let tx = sql.transaction().unwrap();
    for key in &keys {
        tx.execute("INSERT INTO telegram_callbacks(bot_id,key,action_kind,binding_json,expires_at,used_by) VALUES (99,?1,'Control',?2,100,NULL)", rusqlite::params![key.as_str(), serde_json::to_string(&menu()).unwrap()]).unwrap();
    }
    tx.commit().unwrap();
    drop(sql);
    let database = Database::open(root.data(), &lease).await.unwrap();
    let store = TelegramStore::new(database.clone(), 16);
    let extra = CallbackKey::for_option(&event, 3072);
    assert!(store
        .register_menu_callback(extra.clone(), menu(), 10)
        .await
        .is_err());
    let answer_key = CallbackKey::for_option(&event, 4096);
    let answer = CallbackBinding {
        topic: topic(),
        action: CallbackAction::Answer {
            session: SessionId::generate(),
            answer: InteractionAnswer {
                interaction: InteractionId::generate(),
                response: InteractionResponse::Decline,
            },
        },
        expires_at: 100,
        used_by: None,
    };
    store
        .register_callback(answer_key.clone(), answer)
        .await
        .unwrap();
    let admission = |command| Admission {
        id: UpdateId::new(1).unwrap(),
        sender: Some(UserId::new(5).unwrap()),
        command: Some(TelegramCommand {
            topic: topic(),
            action: TelegramAction::Control(command),
        }),
        callback: Some(keys[0].clone()),
        callback_query: Some("q-1".into()),
        expected_binding: None,
    };
    // The transaction validates the exact frozen callback action, not only its key.
    assert!(store
        .admit(admission(ControlCommand::Sync {
            cursor: None,
            recent: 5,
            forum: false
        }))
        .await
        .is_err());
    assert_eq!(store.offset().await.unwrap(), 0);
    assert!(store
        .callback(&keys[0])
        .await
        .unwrap()
        .unwrap()
        .used_by
        .is_none());
    store.admit(admission(ControlCommand::Help)).await.unwrap();
    let fresh = CallbackBinding {
        expires_at: 1000,
        ..menu()
    };
    store
        .register_menu_callback(extra, fresh.clone(), 101)
        .await
        .unwrap();
    assert!(
        store.callback(&keys[0]).await.unwrap().is_some(),
        "expired keys referenced by Pending inbox remain pinned"
    );
    assert!(
        store.callback(&answer_key).await.unwrap().is_some(),
        "menu reclamation must not delete expired authorization keys"
    );
    store
        .complete(UpdateId::new(1).unwrap(), InboxOutcome::Applied)
        .await
        .unwrap();
    for index in 3073..3100 {
        store
            .register_menu_callback(CallbackKey::for_option(&event, index), fresh.clone(), 101)
            .await
            .unwrap();
    }
    for key in keys {
        assert!(store.callback(&key).await.unwrap().is_none());
    }
    assert!(store.callback(&answer_key).await.unwrap().is_some());
    database.shutdown().await.unwrap();
}

#[tokio::test]
async fn pre_menu_callback_schema_is_rejected_without_rewriting_data() {
    let root = Root::new();
    let lease = StorageLease::lock(&root.data()).unwrap();
    let database = Database::open(root.data(), &lease).await.unwrap();
    database.shutdown().await.unwrap();
    let sql = rusqlite::Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    sql.execute_batch("DROP INDEX telegram_callbacks_expiry; ALTER TABLE telegram_callbacks DROP COLUMN action_kind;").unwrap();
    drop(sql);
    assert!(Database::open(root.data(), &lease).await.is_err());
    let sql = rusqlite::Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    assert_eq!(
        sql.query_row(
            "SELECT count(*) FROM pragma_table_info('telegram_callbacks') WHERE name='action_kind'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert!(sql.prepare("SELECT offset FROM telegram_meta").is_ok());
}
