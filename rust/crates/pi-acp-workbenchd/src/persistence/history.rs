use super::{
    outbox::{DeliveryEvent, DeliveryPayload, DeliveryTarget, OutboxStore},
    payload::{NoticeContent, PayloadStore},
    FORMAT_VERSION,
};
use crate::domain::{
    error::DomainError,
    event::DomainEvent,
    ids::{DeliveryId, NoticeId, SessionId},
    transcript::EntryRole,
    SessionState,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use tokio::fs;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistorySnapshot {
    pub format_version: u32,
    pub session: SessionState,
    pub revision: u64,
    pub checksum: String,
    pub delivery_events: BTreeMap<DeliveryId, DeliveryEvent>,
}
#[derive(Clone)]
pub struct HistoryStore {
    root: PathBuf,
    pub outbox: OutboxStore,
    pub payloads: PayloadStore,
}
impl HistoryStore {
    pub fn new(root: impl Into<PathBuf>, database: super::database::Database) -> Self {
        let root = root.into();
        Self::with_delivery(
            root.clone(),
            OutboxStore::new(database.clone(), 1024),
            PayloadStore::new(database),
        )
    }
    /// Isolated legacy-history fixtures only; production always supplies the
    /// host's existing Database. Removed with the file history store in T04.
    #[cfg(test)]
    pub(crate) fn fixture(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        let data = root.join(".sqlite");
        let lease = super::format::StorageLease::lock(&data).unwrap();
        let database = super::database::Database::open_sync(&data, &lease).unwrap();
        Self::new(root, database)
    }
    pub fn with_delivery(
        root: impl Into<PathBuf>,
        outbox: OutboxStore,
        payloads: PayloadStore,
    ) -> Self {
        Self {
            root: root.into(),
            outbox,
            payloads,
        }
    }
    fn path(&self, id: &str) -> PathBuf {
        self.root.join(format!("{id}.json"))
    }
    async fn snapshot(&self, id: &str) -> Result<Option<HistorySnapshot>, String> {
        SessionId::new(id).map_err(|error| error.to_string())?;
        let bytes = match fs::read(self.path(id)).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        let snapshot: HistorySnapshot =
            serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        if snapshot.format_version != FORMAT_VERSION {
            return Err("unsupported history format".into());
        }
        if snapshot.session.id.as_str() != id || snapshot.revision != snapshot.session.revision {
            return Err("history identity or revision mismatch".into());
        }
        if snapshot.checksum
            != checksum(&snapshot.session, &snapshot.delivery_events)
                .map_err(|error| error.to_string())?
        {
            return Err("history checksum mismatch".into());
        }
        for (id, event) in &snapshot.delivery_events {
            if id != &event.id
                || event.revision.get() > snapshot.revision
                || event.target
                    != (DeliveryTarget::Session {
                        session: snapshot.session.id.clone(),
                        cwd: snapshot.session.cwd.clone(),
                    })
            {
                return Err("history delivery identity mismatch".into());
            }
        }
        Ok(Some(snapshot))
    }
    async fn snapshots(&self) -> Result<Vec<HistorySnapshot>, String> {
        let mut directory = match fs::read_dir(&self.root).await {
            Ok(directory) => directory,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(error) => return Err(error.to_string()),
        };
        let mut snapshots = vec![];
        while let Some(entry) = directory
            .next_entry()
            .await
            .map_err(|error| error.to_string())?
        {
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            let id = path
                .file_stem()
                .and_then(|name| name.to_str())
                .ok_or("invalid history filename")?;
            if let Some(snapshot) = self.snapshot(id).await? {
                snapshots.push(snapshot);
            }
        }
        snapshots.sort_by(|a, b| a.session.id.cmp(&b.session.id));
        Ok(snapshots)
    }
    pub async fn load(&self, id: &str) -> Result<Option<SessionState>, String> {
        Ok(self.snapshot(id).await?.map(|snapshot| snapshot.session))
    }
    pub async fn list(&self) -> Result<Vec<SessionState>, String> {
        Ok(self
            .snapshots()
            .await?
            .into_iter()
            .map(|snapshot| snapshot.session)
            .collect())
    }
    async fn notice(
        &self,
        state: &SessionState,
        session: &SessionId,
        text: String,
    ) -> Result<DeliveryEvent, String> {
        // Content-addressed identity also distinguishes abandoned payload writes
        // when a failed history commit later retries a different event/reason.
        let identity = serde_json::to_vec(&(session, state.revision, &text))
            .map_err(|error| error.to_string())?;
        let id = format!("notice-{:x}", Sha256::digest(identity));
        let notice = NoticeId::new(id.clone()).map_err(|error| error.to_string())?;
        let notice_content = NoticeContent { id: notice, text };
        let content =
            PayloadStore::notice_ref(&notice_content).map_err(|error| error.to_string())?;
        self.payloads
            .put_notice(&notice_content)
            .await
            .map_err(|error| error.to_string())?;
        Ok(DeliveryEvent {
            id: DeliveryId::new(id).map_err(|error| error.to_string())?,
            target: DeliveryTarget::Session {
                session: session.clone(),
                cwd: state.cwd.clone(),
            },
            revision: crate::domain::query::SafeInteger::new(state.revision)
                .map_err(|error| error.to_string())?,
            payload: DeliveryPayload::Notice { content },
        })
    }
    pub async fn save(&self, state: &SessionState) -> Result<(), String> {
        self.commit(state, &[]).await
    }
    pub async fn commit(&self, state: &SessionState, events: &[DomainEvent]) -> Result<(), String> {
        let previous = self.snapshot(state.id.as_str()).await?;
        if let Some(previous) = &previous {
            if state.cwd != previous.session.cwd {
                return Err("history workspace identity changed".into());
            }
            if state.revision < previous.revision {
                return Err("stale history revision".into());
            }
            if state.revision == previous.revision
                && serde_json::to_vec(state).map_err(|error| error.to_string())?
                    != serde_json::to_vec(&previous.session).map_err(|error| error.to_string())?
            {
                return Err("conflicting history revision".into());
            }
        }
        let mut delivery_events = previous
            .map(|snapshot| snapshot.delivery_events)
            .unwrap_or_default();
        for event in events {
            let event = match event {
                DomainEvent::TurnFinished { session, turn } => {
                    let mut entries = vec![];
                    for entry in state.transcript.entries.iter().filter(|entry| {
                        &entry.turn == turn && matches!(entry.role, EntryRole::Agent)
                    }) {
                        self.payloads
                            .put_entry(entry)
                            .await
                            .map_err(|error| error.to_string())?;
                        entries.push(entry.id.clone());
                    }
                    Some(DeliveryEvent {
                        id: DeliveryId::new(format!("turn-{turn}"))
                            .map_err(|error| error.to_string())?,
                        target: DeliveryTarget::Session {
                            session: session.clone(),
                            cwd: state.cwd.clone(),
                        },
                        revision: crate::domain::query::SafeInteger::new(state.revision)
                            .map_err(|error| error.to_string())?,
                        payload: DeliveryPayload::Entries {
                            turn: turn.clone(),
                            entries,
                        },
                    })
                }
                DomainEvent::InteractionRequested {
                    session,
                    interaction,
                } => {
                    self.payloads
                        .put_interaction(interaction)
                        .await
                        .map_err(|error| error.to_string())?;
                    Some(DeliveryEvent {
                        id: DeliveryId::new(format!("interaction-{}", interaction.id))
                            .map_err(|error| error.to_string())?,
                        target: DeliveryTarget::Session {
                            session: session.clone(),
                            cwd: state.cwd.clone(),
                        },
                        revision: crate::domain::query::SafeInteger::new(state.revision)
                            .map_err(|error| error.to_string())?,
                        payload: DeliveryPayload::Interaction {
                            interaction: interaction.id.clone(),
                        },
                    })
                }
                DomainEvent::TurnCancelled { session, turn } => Some(
                    self.notice(state, session, format!("Turn {turn} cancelled."))
                        .await?,
                ),
                DomainEvent::SessionError { session, error } => Some(
                    self.notice(state, session, format!("Session error: {error}"))
                        .await?,
                ),
                _ => None,
            };
            if let Some(event) = event {
                if event.target
                    != (DeliveryTarget::Session {
                        session: state.id.clone(),
                        cwd: state.cwd.clone(),
                    })
                    || delivery_events
                        .get(&event.id)
                        .is_some_and(|existing| existing != &event)
                {
                    return Err("immutable history delivery identity changed".into());
                }
                delivery_events.insert(event.id.clone(), event);
            }
        }
        fs::create_dir_all(&self.root)
            .await
            .map_err(|error| error.to_string())?;
        // Persist the history directory's admission as well as its snapshot files.
        let parent = self
            .root
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        fs::File::open(parent)
            .await
            .map_err(|error| error.to_string())?
            .sync_all()
            .await
            .map_err(|error| error.to_string())?;
        let snapshot = HistorySnapshot {
            format_version: FORMAT_VERSION,
            revision: state.revision,
            checksum: checksum(state, &delivery_events).map_err(|error| error.to_string())?,
            session: state.clone(),
            delivery_events,
        };
        pi_acp_core::atomic::write_atomic_json(&self.path(state.id.as_str()), &snapshot, true)
            .await
            .map_err(|error| error.to_string())
    }
    /// Reconstruct projection after any history-commit/outbox-admission crash point.
    /// A full outbox defers admission; the snapshot ledger remains the durable owner.
    pub async fn project_outbox(&self) -> Result<usize, DomainError> {
        let mut projected = 0;
        for snapshot in self.snapshots().await.map_err(DomainError::Persistence)? {
            let mut events: Vec<_> = snapshot.delivery_events.values().collect();
            events.sort_by_key(|event| event.revision);
            for event in events {
                match self.outbox.enqueue(event.clone()).await {
                    Ok(()) => projected += 1,
                    Err(DomainError::Backpressure) => return Ok(projected),
                    Err(error) => return Err(error),
                }
            }
        }
        Ok(projected)
    }
    pub async fn remove(&self, id: &str) -> Result<(), String> {
        if let Some(snapshot) = self.snapshot(id).await? {
            // Archive payloads already exist. Do not delete the durable ledger if
            // any pending event cannot yet be transferred to the outbox.
            let mut events: Vec<_> = snapshot.delivery_events.values().collect();
            events.sort_by_key(|event| event.revision);
            for event in events {
                self.outbox
                    .enqueue(event.clone())
                    .await
                    .map_err(|error| error.to_string())?;
            }
        }
        super::io::remove(&self.path(id))
            .await
            .map_err(|error| error.to_string())
    }
}
pub(super) fn checksum(
    state: &SessionState,
    deliveries: &BTreeMap<DeliveryId, DeliveryEvent>,
) -> Result<String, serde_json::Error> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(state, deliveries))?)
    ))
}
