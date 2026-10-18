use super::delivery_tests::{notice, topic};
use super::*;
use crate::telegram::runtime::AdapterError;
use crate::{
    domain::{image::ImageAsset, DeliveryId},
    persistence::{
        format::StorageLease,
        outbox::{DeliveryEvent, DeliveryPayload},
    },
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::{mpsc, Notify, Semaphore};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct SlowApi {
    base: Fake,
    started: mpsc::Sender<String>,
    release: Arc<Semaphore>,
    panic_release: Arc<Notify>,
    active: Arc<AtomicUsize>,
    maximum: Arc<AtomicUsize>,
}
struct Flight(Arc<AtomicUsize>);
impl Drop for Flight {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
impl SlowApi {
    fn new() -> (Self, mpsc::Receiver<String>) {
        let (started, receiver) = mpsc::channel(32);
        (
            Self {
                base: Fake::default(),
                started,
                release: Arc::new(Semaphore::new(0)),
                panic_release: Arc::new(Notify::new()),
                active: Default::default(),
                maximum: Default::default(),
            },
            receiver,
        )
    }
    async fn enter(&self, tag: String) -> Flight {
        let count = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        let flight = Flight(self.active.clone());
        self.maximum.fetch_max(count, Ordering::SeqCst);
        self.started.send(tag).await.unwrap();
        flight
    }
}
impl BotApi for SlowApi {
    async fn get_me(&self) -> Result<WireUser, ApiError> {
        self.base.get_me().await
    }
    async fn get_updates(&self, offset: u64) -> Result<Vec<WireUpdate>, ApiError> {
        self.base.get_updates(offset).await
    }
    async fn send_message(&self, request: &SendMessage) -> Result<WireMessage, ApiError> {
        if request.text.starts_with("block:") {
            let _flight = self.enter(request.text.clone()).await;
            self.release.acquire().await.unwrap().forget();
            self.base.send_message(request).await
        } else if request.text == "panic" {
            let _flight = self.enter("panic".into()).await;
            self.panic_release.notified().await;
            panic!("synthetic delivery panic");
        } else {
            self.base.send_message(request).await
        }
    }
    async fn send_media(&self, request: &SendMedia) -> Result<WireMessage, ApiError> {
        let _flight = self.enter("media".into()).await;
        self.release.acquire().await.unwrap().forget();
        self.base.send_media(request).await
    }
    async fn answer_callback(&self, query: &str, text: &str) -> Result<(), ApiError> {
        self.base.answer_callback(query, text).await
    }
    async fn create_topic(&self, chat: ChatId, name: &str) -> Result<ForumTopic, ApiError> {
        self.base.create_topic(chat, name).await
    }
}
async fn started(receiver: &mut mpsc::Receiver<String>) -> String {
    tokio::time::timeout(Duration::from_secs(3), receiver.recv())
        .await
        .unwrap()
        .unwrap()
}
async fn wait_for(mut predicate: impl AsyncFnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !predicate().await {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn blocked_media_does_not_block_other_topics_same_topic_stays_fifo_and_cancelled_upload_retries_without_agent(
) {
    let root = root();
    let first = app(&root);
    let (api, mut starts) = SlowApi::new();
    let context = Context::new(first.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    let asset = ImageAsset::from_base64("image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=").unwrap();
    first.delivery_payloads().put_image(&asset).await.unwrap();
    first
        .delivery_store()
        .enqueue(DeliveryEvent {
            id: DeliveryId::generate(),
            revision: crate::domain::query::SafeInteger::new(10).unwrap(),
            target: topic(101).delivery_target(99, config().workspace),
            payload: DeliveryPayload::Image {
                image: asset.image().id().clone(),
            },
        })
        .await
        .unwrap();
    notice(&first, &topic(101), "A:after".into(), 1).await;
    notice(&first, &topic(102), "B:ready".into(), 0).await;
    let stop = CancellationToken::new();
    let task = tokio::spawn(super::super::delivery::run(context, stop.clone()));
    assert_eq!(started(&mut starts).await, "media");
    wait_for(async || api.base.0.lock().await.sequence == ["text:B:ready"]).await;
    assert_eq!(api.active.load(Ordering::SeqCst), 1);
    stop.cancel();
    task.await.unwrap().unwrap();
    assert_eq!(api.active.load(Ordering::SeqCst), 0);
    let pending = first
        .delivery_store()
        .pending(u64::MAX, 1024)
        .await
        .unwrap();
    assert_eq!(pending.len(), 2);
    assert!(pending.iter().all(|record| record.attempt == 0));
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
    api.release.add_permits(1);
    deliver_once(&context).await.unwrap();
    assert_eq!(
        api.base.0.lock().await.sequence,
        ["text:B:ready", "image", "text:A:after"]
    );
    assert_eq!(
        api.base.0.lock().await.media[0].asset.bytes(),
        asset.bytes()
    );
    assert!(second
        .delivery_store()
        .pending(u64::MAX, 1024)
        .await
        .unwrap()
        .is_empty());
    // No sessions exist: delivery recovery has no source/ACP execution to rerun.
    assert!(
        matches!(&second.command(DomainCommand::ListSessions).await.unwrap()[0], DomainEvent::SessionsListed(sessions) if sessions.is_empty())
    );
    second.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn eight_topic_capacity_is_bounded_and_ninth_admits_only_after_physical_completion() {
    let root = root();
    let app = app(&root);
    let (api, mut starts) = SlowApi::new();
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    for i in 0..9 {
        notice(&app, &topic(100 + i), format!("block:{i}"), 9 - i as u64).await;
    }
    let stop = CancellationToken::new();
    let task = tokio::spawn(super::super::delivery::run(context, stop.clone()));
    for _ in 0..8 {
        started(&mut starts).await;
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(80), starts.recv())
            .await
            .is_err()
    );
    assert_eq!(api.active.load(Ordering::SeqCst), 8);
    assert_eq!(api.maximum.load(Ordering::SeqCst), 8);
    api.release.add_permits(1);
    assert_eq!(started(&mut starts).await, "block:8");
    assert_eq!(api.maximum.load(Ordering::SeqCst), 8);
    stop.cancel();
    task.await.unwrap().unwrap();
    assert_eq!(api.active.load(Ordering::SeqCst), 0);
    assert_eq!(
        app.delivery_store()
            .pending(u64::MAX, 1024)
            .await
            .unwrap()
            .len(),
        8
    );
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn a_delivery_job_panic_cancels_other_http_jobs_joins_them_and_keeps_pending_intents() {
    let root = root();
    let app = app(&root);
    let (api, mut starts) = SlowApi::new();
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    notice(&app, &topic(101), "block:A".into(), 10).await;
    notice(&app, &topic(102), "panic".into(), 1).await;
    let stop = CancellationToken::new();
    let task = tokio::spawn(super::super::delivery::run(context.clone(), stop));
    started(&mut starts).await;
    started(&mut starts).await;
    api.panic_release.notify_one();
    assert!(matches!(task.await.unwrap(), Err(AdapterError::Task)));
    context.delivery.drain().await.unwrap();
    assert_eq!(api.active.load(Ordering::SeqCst), 0);
    assert_eq!(
        app.delivery_store()
            .pending(u64::MAX, 1024)
            .await
            .unwrap()
            .len(),
        2
    );
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn driver_abort_cancels_http_but_shared_owner_still_physically_joins_pending_jobs() {
    let root = root();
    let app = app(&root);
    let (api, mut starts) = SlowApi::new();
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    notice(&app, &topic(101), "block:driver-abort".into(), 1).await;
    let task = tokio::spawn(super::super::delivery::run(
        context.clone(),
        CancellationToken::new(),
    ));
    started(&mut starts).await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    tokio::time::timeout(Duration::from_secs(3), context.delivery.drain())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(api.active.load(Ordering::SeqCst), 0);
    let pending = app.delivery_store().pending(u64::MAX, 1024).await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].attempt, 0);
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn supervisor_abort_and_cancelled_wait_observer_retain_ack_job_error_and_storage_lease_until_joined(
) {
    let root = root();
    let app = app(&root);
    let (api, mut starts) = SlowApi::new();
    notice(&app, &topic(101), "block:ack".into(), 1).await;
    let mut adapter =
        TelegramAdapter::start(app.clone(), api.clone(), &root.join("telegram"), config())
            .await
            .unwrap();
    started(&mut starts).await;
    let gate = app.delivery_store().pause_mutations().await;
    api.release.add_permits(1);
    wait_for(async || api.base.0.lock().await.sent.len() == 1).await;
    adapter.abort_supervisor();
    assert!(
        tokio::time::timeout(Duration::from_millis(80), adapter.wait())
            .await
            .is_err(),
        "accepted ack must still be waiting, not aborted/detached"
    );
    assert!(StorageLease::lock(&root).is_err());
    drop(gate);
    assert!(
        matches!(adapter.wait().await, Err(AdapterError::Task)),
        "terminal error survives cancellation of cleanup observer"
    );
    assert!(app
        .delivery_store()
        .pending(u64::MAX, 1024)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(api.active.load(Ordering::SeqCst), 0);
    app.shutdown_checked().await.unwrap();
    drop(StorageLease::lock(&root).unwrap());
    tokio::fs::remove_dir_all(root).await.unwrap();
}
