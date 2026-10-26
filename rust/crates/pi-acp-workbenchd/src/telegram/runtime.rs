use super::{
    admission::AdmissionPolicy,
    api::{ApiError, BotApi},
    state::InboxRecord,
    types::TopicKey,
};
use crate::{
    app::WorkbenchApp,
    config::TelegramConfig,
    domain::{
        error::DomainError,
        query::{CommandReceipt, SessionView},
        DomainCommand, SessionId,
    },
    persistence::{inbox::TelegramStore, telegram_effect::TelegramEffects},
};
use std::{
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    task::{JoinHandle, JoinSet},
    time::sleep,
};
use tokio_util::sync::CancellationToken;
#[derive(Debug, thiserror::Error)]
pub enum AdapterError {
    #[error(transparent)]
    Domain(#[from] DomainError),
    #[error(transparent)]
    Api(#[from] ApiError),
    #[error("Telegram task failed")]
    Task,
}
#[derive(Clone)]
pub(crate) struct Context<A: BotApi> {
    pub app: WorkbenchApp,
    pub api: A,
    pub store: TelegramStore,
    pub effects: TelegramEffects,
    pub config: TelegramConfig,
    pub username: Option<String>,
    pub bot_id: i64,
    pub topics: super::topics::Locks,
    pub auto_forum: std::sync::Arc<std::sync::atomic::AtomicI64>,
    pub preview: std::sync::Arc<tokio::sync::Mutex<super::preview::State>>,
    pub delivery: std::sync::Arc<super::delivery_scheduler::DeliveryJobs>,
    pub delivered: std::sync::Arc<
        tokio::sync::Mutex<std::collections::BTreeMap<crate::domain::DeliveryId, TopicKey>>,
    >,
}
impl<A: BotApi> Context<A> {
    pub async fn new(
        app: WorkbenchApp,
        api: A,
        _root: &Path,
        config: TelegramConfig,
    ) -> Result<Self, AdapterError> {
        let bot = api.get_me().await?;
        if !bot.is_bot {
            return Err(ApiError::Protocol.into());
        }
        let store = TelegramStore::new(app.database(), config.inbox_capacity);
        let effects = TelegramEffects::new(app.database());
        store.claim_bot(bot.id).await?;
        Ok(Self {
            app,
            api,
            store,
            effects,
            config,
            bot_id: bot.id.get(),
            username: bot.username,
            topics: Default::default(),
            auto_forum: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(i64::MAX)),
            preview: Default::default(),
            delivery: Default::default(),
            delivered: Default::default(),
        })
    }
    pub fn policy(&self) -> AdmissionPolicy {
        AdmissionPolicy {
            chats: self.config.allowed_chat_ids.iter().copied().collect(),
            users: self.config.allowed_user_ids.iter().copied().collect(),
            cwd: self.config.workspace.clone(),
        }
    }
    pub fn authorized(&self, record: &InboxRecord) -> bool {
        self.config
            .allowed_chat_ids
            .contains(&record.command.topic.chat)
            && (self.config.allowed_user_ids.is_empty()
                || self.config.allowed_user_ids.contains(&record.sender))
    }
    pub async fn inspect(&self, session: &SessionId) -> Result<Option<SessionView>, DomainError> {
        let events = match self
            .app
            .command(DomainCommand::Inspect(session.clone()))
            .await
        {
            Ok(events) => events,
            // Inspect already reads cold history without spawning an actor.
            // A missing/deleted session is not authority to attempt a load or
            // create another durable mutation operation during delivery.
            Err(DomainError::NotFound(_)) => return Ok(None),
            Err(error) => return Err(error),
        };
        match events {
            CommandReceipt::Loaded { view } => Ok(Some(*view)),
            _ => Err(DomainError::Protocol("inspect receipt has no view".into())),
        }
    }
}
pub struct TelegramAdapter {
    app: WorkbenchApp,
    stop: CancellationToken,
    task: Option<JoinHandle<Result<(), AdapterError>>>,
    delivery: std::sync::Arc<super::delivery_scheduler::DeliveryJobs>,
    error: Option<AdapterError>,
    children: std::sync::Arc<tokio::sync::Mutex<JoinSet<Result<(), AdapterError>>>>,
}
impl TelegramAdapter {
    pub async fn start(
        app: WorkbenchApp,
        api: impl BotApi,
        root: &Path,
        config: TelegramConfig,
    ) -> Result<Self, AdapterError> {
        let context = Context::new(app.clone(), api, root, config).await?;
        let stop = CancellationToken::new();
        let delivery = context.delivery.clone();
        let children = std::sync::Arc::new(tokio::sync::Mutex::new(JoinSet::new()));
        let task = tokio::spawn(supervise(context, stop.clone(), children.clone()));
        Ok(Self {
            app,
            stop,
            task: Some(task),
            delivery,
            error: None,
            children,
        })
    }
    pub async fn wait(&mut self) -> Result<(), AdapterError> {
        if let Some(task) = self.task.as_mut() {
            if let Err(error) = task.await.unwrap_or(Err(AdapterError::Task)) {
                self.error = Some(error);
            }
            self.task.take();
        }
        if self.error.is_some() {
            self.app.close_admission();
            self.stop.cancel();
        }
        let mut children = self.children.lock().await;
        while let Some(child) = children.join_next().await {
            if let Err(error) = child.unwrap_or(Err(AdapterError::Task)) {
                if self.error.is_none() {
                    self.error = Some(error);
                }
            }
        }
        drop(children);
        // Also runs after a supervisor abort, and on a second wait if the first
        // cleanup observer was cancelled. Preserve the terminal error until all
        // registered delivery jobs physically join.
        if let Err(error) = self.delivery.drain().await {
            if self.error.is_none() {
                self.error = Some(error);
            }
        }
        self.error.take().map_or(Ok(()), Err)
    }
    #[cfg(test)]
    pub(crate) fn abort_supervisor(&self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
    pub async fn shutdown(mut self) -> Result<(), AdapterError> {
        self.app.close_admission();
        self.stop.cancel();
        self.wait().await
    }
}
impl Drop for TelegramAdapter {
    fn drop(&mut self) {
        self.app.close_admission();
        self.stop.cancel();
    }
}
async fn supervise(
    context: Context<impl BotApi>,
    stop: CancellationToken,
    children: std::sync::Arc<tokio::sync::Mutex<JoinSet<Result<(), AdapterError>>>>,
) -> Result<(), AdapterError> {
    let _cancel_children_on_drop = stop.clone().drop_guard();
    let app = context.app.clone();
    let mut tasks = children.lock().await;
    context
        .auto_forum
        .store(0, std::sync::atomic::Ordering::Release);
    tasks.spawn(super::polling::run(context.clone(), stop.clone()));
    tasks.spawn(super::execution::run(context.clone(), stop.clone()));
    tasks.spawn(super::delivery::run(context.clone(), stop.clone()));
    tasks.spawn(super::preview::observe(context.clone(), stop.clone()));
    tasks.spawn(super::topics::run(context.clone(), stop.clone()));
    let mut result = tokio::select! {
        biased;
        _ = stop.cancelled() => Ok(()),
        result = tasks.join_next() => match result {
            Some(Ok(Err(error))) => Err(error),
            Some(Ok(Ok(()))) if app.is_closing() => Ok(()),
            _ => Err(AdapterError::Task),
        },
    };
    stop.cancel();
    app.close_admission();
    while let Some(joined) = tasks.join_next().await {
        if result.is_ok() {
            result = joined.unwrap_or(Err(AdapterError::Task));
        }
    }
    result.and(context.delivery.drain().await)
}
pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub(crate) async fn pause(stop: &CancellationToken, duration: Duration) -> bool {
    tokio::select! { _ = stop.cancelled() => false, _ = sleep(duration) => true }
}
