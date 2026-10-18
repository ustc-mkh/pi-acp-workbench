use super::*;
use crate::{
    domain::{
        interaction::{InteractionAnswer, InteractionResponse},
        DeliveryId, InteractionId, SessionId,
    },
    persistence::inbox::{Admission, TelegramStore},
    telegram::{
        command::{TelegramAction, TelegramCommand},
        state::InboxOutcome,
        types::{CallbackBinding, CallbackKey, ChatId, TopicKey, UpdateId, UserId},
    },
};
fn root() -> PathBuf {
    let root = std::env::temp_dir().join(format!("workbench-maintenance-{}", uuid::Uuid::new_v4()));
    drop(StorageLease::acquire(&root).unwrap());
    root
}
fn args(command: &str, root: &Path) -> Vec<String> {
    vec![
        command.into(),
        "--root".into(),
        root.to_str().unwrap().into(),
        "--confirm".into(),
    ]
}
#[tokio::test]
async fn explicit_gc_atomically_preserves_pending_callbacks_offset_and_replay() {
    let root = root();
    let store = TelegramStore::new(root.join("telegram/state.json"), 16);
    let topic = TopicKey {
        chat: ChatId::new(-100).unwrap(),
        thread: None,
    };
    let session = SessionId::generate();
    store.bind(topic.clone(), session.clone()).await.unwrap();
    let mut keys = vec![];
    for i in 0..4 {
        let key = CallbackKey::for_option(&DeliveryId::generate(), 0);
        keys.push(key.clone());
        let answer = InteractionAnswer {
            interaction: InteractionId::generate(),
            response: InteractionResponse::Permission {
                option: "yes".into(),
            },
        };
        store
            .register_callback(
                key.clone(),
                CallbackBinding {
                    topic: topic.clone(),
                    session: session.clone(),
                    answer: answer.clone(),
                    expires_at: if i == 3 { u64::MAX } else { 0 },
                    used_by: None,
                },
            )
            .await
            .unwrap();
        if i == 2 {
            continue;
        } // unused expired callback
        let id = UpdateId::new(i + 1).unwrap();
        store
            .admit(Admission {
                id,
                sender: Some(UserId::new(5).unwrap()),
                command: Some(TelegramCommand {
                    topic: topic.clone(),
                    action: TelegramAction::Answer {
                        session: session.clone(),
                        answer,
                    },
                }),
                callback: Some(key),
                callback_query: Some(format!("query-{i}")),
                expected_binding: Some(session.clone()),
            })
            .await
            .unwrap();
        if i != 1 {
            store.complete(id, InboxOutcome::Applied).await.unwrap();
        }
    }
    let lease = StorageLease::acquire_existing(&root).unwrap();
    let before = fs::read(root.join("telegram/state.json")).unwrap();
    assert!(run(&args("gc", &root)).await.is_err());
    assert_eq!(fs::read(root.join("telegram/state.json")).unwrap(), before);
    drop(lease);
    run(&args("gc", &root)).await.unwrap();
    let state = store.snapshot().await.unwrap();
    assert_eq!(state.offset, 5);
    assert_eq!(state.inbox.len(), 1);
    assert_eq!(state.callbacks.len(), 2);
    assert!(state.callbacks.contains_key(&keys[1])); // expired, still Pending
    assert!(state.callbacks.contains_key(&keys[3])); // consumed but unexpired
    assert_eq!(
        state.callbacks[&keys[3]].used_by,
        Some(UpdateId::new(4).unwrap())
    );
    run(&args("gc", &root)).await.unwrap();
    assert_eq!(store.snapshot().await.unwrap().offset, 5);
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn reset_retains_lock_inode_so_waiting_hosts_cannot_obtain_a_second_lease() {
    use std::os::unix::fs::MetadataExt;
    let root = root();
    let inode = fs::metadata(root.join(".workbench.lock")).unwrap().ino();
    run(&args("reset", &root)).await.unwrap();
    assert!(!root.join("storage-format.json").exists());
    assert!(StorageLease::acquire_existing(&root).is_err());
    let host = StorageLease::acquire(&root).unwrap();
    assert_eq!(
        fs::metadata(root.join(".workbench.lock")).unwrap().ino(),
        inode
    );
    assert!(StorageLease::acquire_existing(&root).is_err());
    drop(host);
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn maintenance_never_initializes_unversioned_storage_or_follows_symlinks() {
    let root = root();
    fs::remove_file(root.join("storage-format.json")).unwrap();
    fs::write(root.join("legacy"), b"retain").unwrap();
    for command in ["gc", "reset"] {
        assert!(run(&args(command, &root)).await.is_err());
    }
    assert_eq!(fs::read(root.join("legacy")).unwrap(), b"retain");
    assert!(!root.join("storage-format.json").exists());
    fs::remove_dir_all(root).unwrap();
}
