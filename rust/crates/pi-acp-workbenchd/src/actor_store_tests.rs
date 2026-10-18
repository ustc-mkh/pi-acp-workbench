use crate::{
    actor::Runtime,
    domain::{
        command::DomainCommand, event::DomainEvent, Harness, Prompt, SessionId, SessionState,
        SessionStatus, WorkspacePath,
    },
    persistence::interface::SessionPersistence,
};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc,
    },
};
use tokio::sync::Mutex;
type Records = BTreeMap<SessionId, (SessionState, Vec<crate::domain::query::CommitBatch>)>;
#[derive(Clone, Default)]
struct MemoryStore {
    records: Arc<Mutex<Records>>,
    next_failure: Arc<AtomicU8>,
    next_image_failure: Arc<AtomicU8>,
    images: Arc<Mutex<Vec<crate::domain::image::ImageAsset>>>,
}
impl SessionPersistence for MemoryStore {
    async fn load(&self, id: &str) -> Result<Option<SessionState>, String> {
        Ok(self
            .records
            .lock()
            .await
            .iter()
            .find(|(key, _)| key.as_str() == id)
            .map(|(_, (state, _))| state.clone()))
    }
    async fn list(&self) -> Result<Vec<SessionState>, String> {
        Ok(self
            .records
            .lock()
            .await
            .values()
            .map(|(state, _)| state.clone())
            .collect())
    }
    async fn save(&self, state: &SessionState) -> Result<(), String> {
        self.records
            .lock()
            .await
            .insert(state.id.clone(), (state.clone(), vec![]));
        Ok(())
    }
    async fn commit(
        &self,
        change: crate::persistence::database::SessionCommit,
    ) -> Result<crate::domain::query::CommitBatch, String> {
        match self.next_failure.swap(0, Ordering::SeqCst) {
            1 => return Err("injected commit failure".into()),
            2 => panic!("injected session store panic"),
            _ => {}
        }
        if self.next_image_failure.swap(0, Ordering::SeqCst) == 1 {
            return Err("injected image archive failure".into());
        }
        if !change.tool_updates.is_empty() {
            return Err("MemoryStore tool fixture is unavailable".into());
        }
        let mut records = self.records.lock().await;
        let (old, ledger) = records.get(&change.next.id).ok_or("missing session")?;
        if old.revision != change.expected_revision.get()
            || change.next.revision.get() != old.revision + 1
        {
            return Err("revision conflict".into());
        }
        let batch = change
            .batch(
                crate::domain::query::SafeInteger::new(old.transcript.entries.len() as u64)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        let mut transcript = old.transcript.clone();
        let mut assets = self.images.lock().await;
        let mut new_assets = Vec::new();
        for entry in change.append {
            entry.text.validate().map_err(|e| e.to_string())?;
            transcript
                .entries
                .push(crate::domain::transcript::TranscriptEntry {
                    id: entry.id,
                    turn: entry.turn,
                    role: entry.role,
                    text: entry.text.text,
                    message: entry.message,
                    image: entry.image.as_ref().map(|asset| asset.image().clone()),
                });
            if let Some(asset) = entry.image {
                new_assets.push(asset);
            }
        }
        let view = change.next;
        let state = SessionState {
            id: view.id,
            provider_session: view.provider_session,
            harness: view.harness,
            cwd: view.cwd,
            status: view.status,
            transcript,
            plan: view.plan,
            active_turn: view.active_turn,
            pending_interactions: view.pending_interactions,
            usage: view.usage,
            config: view.config,
            configuration_intent: view.configuration_intent,
            catalogue: view.catalogue,
            revision: view.revision.get(),
        };
        let mut ledger = ledger.clone();
        ledger.push(batch.clone());
        assets.extend(new_assets);
        records.insert(state.id.clone(), (state, ledger));
        Ok(batch)
    }
    async fn remove(&self, id: &str) -> Result<(), String> {
        self.records
            .lock()
            .await
            .retain(|key, _| key.as_str() != id);
        Ok(())
    }
}
async fn create(runtime: &Runtime) -> SessionId {
    let result = runtime
        .registry
        .command(DomainCommand::CreateSession {
            harness: Harness::Pi,
            cwd: WorkspacePath::new("/tmp").unwrap(),
        })
        .await
        .unwrap();
    let DomainEvent::SessionCreated(snapshot) = &result[0] else {
        panic!("created");
    };
    snapshot.id.clone()
}
fn prompt(id: &SessionId) -> DomainCommand {
    DomainCommand::Prompt {
        session: id.clone(),
        prompt: Prompt::new("test").unwrap(),
    }
}
#[tokio::test]
async fn actor_commits_through_trait_and_failed_commit_keeps_state_and_intent_unchanged() {
    let store = MemoryStore::default();
    let runtime = Runtime::start(store.clone(), 8);
    let id = create(&runtime).await;
    store.next_failure.store(1, Ordering::SeqCst);
    assert!(runtime.registry.command(prompt(&id)).await.is_err());
    let events = runtime
        .registry
        .command(DomainCommand::Inspect(id.clone()))
        .await
        .unwrap();
    assert!(
        matches!(&events[0], DomainEvent::SessionLoaded(snapshot) if matches!(snapshot.status, SessionStatus::Idle) && snapshot.transcript.entries.is_empty())
    );
    assert!(store.records.lock().await[&id].1.is_empty());
    runtime.registry.command(prompt(&id)).await.unwrap();
    assert!(!store.records.lock().await[&id].1.is_empty());
    runtime.registry.shutdown().await;
}
#[tokio::test]
async fn image_archive_failure_never_commits_or_publishes_a_dangling_reference() {
    use crate::domain::{command::AgentEvent, image::ImageAsset};
    let store = MemoryStore::default();
    let runtime = Runtime::start(store.clone(), 8);
    let id = create(&runtime).await;
    let started = runtime.registry.command(prompt(&id)).await.unwrap();
    let DomainEvent::TurnStarted { turn, .. } = &started[0] else {
        panic!("turn")
    };
    let before = serde_json::to_vec(&store.records.lock().await[&id].0).unwrap();
    let asset = ImageAsset::from_base64("image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=").unwrap();
    store.next_image_failure.store(1, Ordering::SeqCst);
    let result = runtime
        .registry
        .command(DomainCommand::Agent {
            session: id.clone(),
            event: AgentEvent::Image {
                turn: turn.clone(),
                asset,
                message: None,
            },
        })
        .await;
    assert!(matches!(
        result,
        Err(crate::domain::error::DomainError::Persistence(_))
    ));
    let inspected = runtime
        .registry
        .command(DomainCommand::Inspect(id.clone()))
        .await
        .unwrap();
    let DomainEvent::SessionLoaded(snapshot) = &inspected[0] else {
        panic!("inspect")
    };
    assert!(snapshot
        .transcript
        .entries
        .iter()
        .all(|entry| entry.image.is_none()));
    assert_eq!(
        serde_json::to_vec(&store.records.lock().await[&id].0).unwrap(),
        before
    );
    assert!(!store.records.lock().await[&id]
        .1
        .iter()
        .any(|batch| batch.entries.iter().any(|entry| entry.image.is_some())));
    assert!(store.images.lock().await.is_empty());
    let asset = ImageAsset::from_base64("image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=").unwrap();
    store.next_failure.store(1, Ordering::SeqCst);
    assert!(runtime
        .registry
        .command(DomainCommand::Agent {
            session: id.clone(),
            event: AgentEvent::Image {
                turn: turn.clone(),
                asset: asset.clone(),
                message: None
            }
        })
        .await
        .is_err());
    assert_eq!(
        store.images.lock().await.len(),
        0,
        "failed transaction must roll back the image and state together"
    );
    assert_eq!(
        serde_json::to_vec(&store.records.lock().await[&id].0).unwrap(),
        before
    );
    let committed = runtime
        .registry
        .command(DomainCommand::Agent {
            session: id.clone(),
            event: AgentEvent::Image {
                turn: turn.clone(),
                asset: asset.clone(),
                message: None,
            },
        })
        .await
        .unwrap();
    assert!(matches!(&committed[0], DomainEvent::AgentImage { .. }));
    let archived = store.images.lock().await.len();
    let late = runtime
        .registry
        .command(DomainCommand::Agent {
            session: id,
            event: AgentEvent::Image {
                turn: crate::domain::TurnId::generate(),
                asset,
                message: None,
            },
        })
        .await
        .unwrap();
    assert!(late.is_empty());
    assert_eq!(
        store.images.lock().await.len(),
        archived,
        "turn fencing must precede image archive I/O"
    );
    runtime.registry.shutdown().await;
}
#[tokio::test]
async fn session_actor_panic_is_isolated_and_committed_state_can_be_reloaded() {
    let store = MemoryStore::default();
    let runtime = Runtime::start(store.clone(), 8);
    let first = create(&runtime).await;
    let second = create(&runtime).await;
    store.next_failure.store(2, Ordering::SeqCst);
    assert!(runtime.registry.command(prompt(&first)).await.is_err());
    runtime
        .registry
        .command(DomainCommand::Inspect(second))
        .await
        .unwrap();
    let reloaded = runtime
        .registry
        .command(DomainCommand::LoadSession(first))
        .await
        .unwrap();
    assert!(
        matches!(&reloaded[0], DomainEvent::SessionLoaded(snapshot) if matches!(snapshot.status, SessionStatus::Idle) && snapshot.active_turn.is_none())
    );
    runtime.registry.shutdown().await;
}
