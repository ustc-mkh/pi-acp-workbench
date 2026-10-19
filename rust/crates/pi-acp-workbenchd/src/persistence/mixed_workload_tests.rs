//! Versioned storage-only mixed workload oracle. Run explicitly via the script;
//! wall-clock numbers are diagnostics until the reader comparison is completed.
use super::{content, database::Database, format::StorageLease, query, sqlite_tests::Root};
use crate::domain::{
    command::DomainCommand,
    fork::ContentHash,
    image::{ImageAsset, ImageMime},
    query::{ContentKind, ContentRef, SafeInteger, SessionView},
    reducer::{transition, TransitionContext},
    tests::state,
    transcript::EntryRole,
    transition::{DeliveryPayload, DeliveryTarget, NewContent, NewEntry},
    ContentId, EntryId, Prompt, SessionId, TurnId,
};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

#[derive(Serialize)]
struct Sample {
    version: u32,
    scope: &'static str,
    workload: &'static str,
    latencies_ms: BTreeMap<&'static str, Vec<f64>>,
    storage: BTreeMap<&'static str, super::RequestMetrics>,
    wal_bytes: u64,
}
fn text(id: &str, value: String) -> NewContent {
    NewContent {
        content: ContentRef {
            id: ContentId::new(id).unwrap(),
            kind: ContentKind::Text,
            bytes: SafeInteger::new(value.len() as u64).unwrap(),
            sha256: ContentHash::of(&value),
        },
        text: value,
    }
}
fn seed(root: &Root) -> (Vec<SessionId>, SessionId, ContentRef, ImageAsset) {
    let mut db = Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    db.pragma_update(None, "synchronous", "FULL").unwrap();
    db.pragma_update(None, "foreign_keys", true).unwrap();
    let tx = db.transaction().unwrap();
    let mut sessions = Vec::new();
    let mut history = state();
    for i in 0..10000 {
        let mut view = state();
        view.id = SessionId::new(format!("mixed-session-{i}")).unwrap();
        view.revision = SafeInteger::default();
        view.last_entry_seq = SafeInteger::default();
        query::insert_view(&tx, &view).unwrap();
        if i < 16 {
            sessions.push(view.id.clone());
        }
        if i == 16 {
            history = view;
        }
    }
    let body = text("mixed-short", "基线 Unicode 🌏".into());
    for i in 1..=100000 {
        let entry = NewEntry {
            id: EntryId::new(format!("mixed-entry-{i}")).unwrap(),
            turn: TurnId::new("mixed-old-turn").unwrap(),
            role: EntryRole::Agent,
            message: None,
            text: body.clone(),
            image: None,
        };
        content::put_entry(&tx, &entry).unwrap();
        tx.execute(
            "INSERT INTO session_entries VALUES (?1,?2,?3)",
            params![history.id.as_str(), i, entry.id.as_str()],
        )
        .unwrap();
    }
    history.last_entry_seq = SafeInteger::new(100000).unwrap();
    tx.execute(
        "UPDATE sessions SET last_entry_seq=100000,hot_state_json=?2 WHERE id=?1",
        params![
            history.id.as_str(),
            super::database::encode(&history).unwrap()
        ],
    )
    .unwrap();
    let body = text("mixed-long", "a".repeat(1024 * 1024));
    content::put_text(&tx, &body).unwrap();
    let mut bytes = vec![0; 4 * 1024 * 1024];
    bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    bytes[12..16].copy_from_slice(b"IHDR");
    let asset = ImageAsset::new(ImageMime::Png, bytes).unwrap();
    content::put_image(&tx, &asset).unwrap();
    tx.execute("INSERT INTO telegram_meta VALUES (1,0,'1')", [])
        .unwrap();
    for i in 1..=2048 {
        let target = DeliveryTarget::Telegram {
            bot_id: 1,
            chat: -100,
            thread: i,
            cwd: history.cwd.clone(),
        };
        tx.execute("INSERT INTO deliveries(delivery_id,order_seq,revision,target_key,target_json,payload_json,status,next_retry) VALUES (?1,?2,0,?3,?4,?5,'Pending',9007199254740991)", params![format!("mixed-deferred-{i}"), i, super::delivery::target_key(&target), super::database::encode(&target).unwrap(), super::database::encode(&DeliveryPayload::Entry { entry: EntryId::new("mixed-entry-1").unwrap() }).unwrap()]).unwrap();
    }
    tx.execute(
        "UPDATE store_meta SET value=2048 WHERE key='delivery_seq'",
        [],
    )
    .unwrap();
    tx.commit().unwrap();
    (sessions, history.id, body.content, asset)
}
async fn controls(db: Database, sessions: Vec<SessionId>) -> Vec<f64> {
    let mut tasks = tokio::task::JoinSet::new();
    for id in sessions {
        let db = db.clone();
        tasks.spawn(async move {
            let mut view: SessionView = db.view(id.clone()).await.unwrap();
            let mut timings = Vec::new();
            for _ in 0..16 {
                for command in [
                    DomainCommand::Prompt {
                        session: id.clone(),
                        prompt: Prompt::new("mixed workload").unwrap(),
                    },
                    DomainCommand::RequestCancel {
                        session: id.clone(),
                    },
                    DomainCommand::Cancel {
                        session: id.clone(),
                    },
                ] {
                    let started = Instant::now();
                    let change = transition(&view, command, &TransitionContext::default(), 0)
                        .unwrap()
                        .unwrap();
                    view = change.next.clone();
                    db.commit(change).await.unwrap();
                    timings.push(started.elapsed().as_secs_f64() * 1000.0);
                }
            }
            timings
        });
    }
    let mut timings = Vec::new();
    while let Some(result) = tasks.join_next().await {
        timings.extend(result.unwrap());
    }
    timings
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "explicit five-run mixed benchmark; fixture setup is excluded from request timings"]
async fn mixed_storage_workload_v1() {
    let root = Root::new();
    let lease = StorageLease::lock(&root.data()).unwrap();
    let db = Database::open(root.data(), &lease).await.unwrap();
    db.shutdown().await.unwrap();
    let (sessions, history, body, asset) = seed(&root);
    let db = Database::open(root.data(), &lease).await.unwrap();
    let mut latencies = BTreeMap::new();
    latencies.insert(
        "idle_control_commit",
        controls(db.clone(), sessions.clone()).await,
    );
    let stop = Arc::new(AtomicBool::new(false));
    let mut readers = tokio::task::JoinSet::new();
    for kind in ["history", "list", "image", "export_slices", "dispatch"] {
        let db = db.clone();
        let stop = stop.clone();
        let history = history.clone();
        let body = body.clone();
        let asset = asset.clone();
        readers.spawn(async move {
            let mut timings = Vec::new();
            while !stop.load(Ordering::Acquire) || timings.len() < 16 {
                let started = Instant::now();
                match kind {
                    "history" => {
                        assert_eq!(
                            db.history(history.clone(), None, Some(100))
                                .await
                                .unwrap()
                                .entries
                                .len(),
                            100
                        );
                    }
                    "list" => {
                        assert_eq!(db.list(None, Some(100)).await.unwrap().sessions.len(), 100);
                    }
                    "image" => {
                        assert_eq!(
                            db.image(asset.image().clone()).await.unwrap().image(),
                            asset.image()
                        );
                    }
                    "export_slices" => {
                        let mut offset = SafeInteger::default();
                        loop {
                            let page = db.content_slice(body.clone(), offset, None).await.unwrap();
                            if let Some(next) = page.next_offset {
                                offset = next;
                            } else {
                                break;
                            }
                        }
                    }
                    "dispatch" => {
                        assert_eq!(
                            db.dispatch_snapshot(1, super::delivery::MAX_DELIVERY_WINDOW)
                                .await
                                .unwrap()
                                .heads
                                .len(),
                            super::delivery::MAX_DELIVERY_WINDOW
                        );
                    }
                    _ => unreachable!(),
                }
                timings.push(started.elapsed().as_secs_f64() * 1000.0);
            }
            (kind, timings)
        });
    }
    latencies.insert("mixed_control_commit", controls(db.clone(), sessions).await);
    stop.store(true, Ordering::Release);
    while let Some(result) = readers.join_next().await {
        let (kind, times) = result.unwrap();
        latencies.insert(kind, times);
    }
    let wal_bytes =
        std::fs::metadata(root.data().join("workbench.sqlite3-wal")).map_or(0, |m| m.len());
    db.shutdown().await.unwrap();
    let report = Sample { version: 1, scope: "storage enqueue through durable commit; not host admission, physical stop, provider latency, Telegram lanes or full process RSS soak", workload: "10000 sessions/100000 entries/1MiB content/4MiB image/2048 deferred topics/16 synthetic owners", latencies_ms: latencies, storage: db.metrics(), wal_bytes };
    println!(
        "MIXED_WORKLOAD_V1:{}",
        serde_json::to_string(&report).unwrap()
    );
}
