//! Bounded workflow metadata, not session state. Register synchronously at host
//! admission so cancellation also identifies a fork queued behind slow work.
use super::*;
use crate::domain::{fork::ForkRequest, OperationId};
use std::sync::{atomic::AtomicUsize, Weak};
use tokio::sync::{watch, Notify};

#[derive(Default)]
pub(super) struct ForkControls {
    active: std::sync::Mutex<HashMap<(SessionId, OperationId), Weak<ForkControl>>>,
    pub(super) changed: Notify,
}
pub(super) struct ForkControl {
    pub(super) stop: CancellationToken,
    session: SessionId,
    operation: OperationId,
    request: ForkRequest,
    leases: AtomicUsize,
    finished: watch::Sender<bool>,
}
pub(super) struct ForkLease(Arc<ForkControl>);
impl ForkLease {
    pub(super) fn is_cancelled(&self) -> bool {
        self.0.stop.is_cancelled()
    }
}
impl Drop for ForkLease {
    fn drop(&mut self) {
        if self.0.leases.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.finished.send_replace(true);
        }
    }
}
impl ForkControls {
    pub(super) fn register(
        &self,
        session: &SessionId,
        operation: &OperationId,
        request: &ForkRequest,
    ) -> ForkLease {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        // Ordinary admission permits bound live leases; control permits bound
        // cancellation observers. Dead weak entries cannot accumulate forever.
        active.retain(|_, control| control.strong_count() != 0);
        let key = (session.clone(), operation.clone());
        let control = active.get(&key).and_then(Weak::upgrade).unwrap_or_else(|| {
            let (finished, _) = watch::channel(false);
            let control = Arc::new(ForkControl {
                stop: CancellationToken::new(),
                session: session.clone(),
                operation: operation.clone(),
                request: request.clone(),
                leases: AtomicUsize::new(0),
                finished,
            });
            active.insert(key, Arc::downgrade(&control));
            control
        });
        if control.leases.fetch_add(1, Ordering::AcqRel) == 0 {
            control.finished.send_replace(false);
        }
        ForkLease(control)
    }
    pub(super) fn get(
        &self,
        session: &SessionId,
        operation: &OperationId,
    ) -> Result<Arc<ForkControl>, DomainError> {
        self.active
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&(session.clone(), operation.clone()))
            .and_then(Weak::upgrade)
            .ok_or(DomainError::NoActiveFork)
    }
}
impl CommandCore {
    pub(super) async fn cancel_fork(
        &self,
        session: &SessionId,
        operation: &OperationId,
    ) -> Result<CommandReceipt, DomainError> {
        let control = self.coordinator.forks.get(session, operation)?;
        // execute_journaled has already persisted this cancellation's Started.
        control.stop.cancel();
        self.coordinator.forks.changed.notify_one();
        let mut finished = control.finished.subscribe();
        while !*finished.borrow_and_update() {
            finished
                .changed()
                .await
                .map_err(|_| DomainError::NativeForkUncertain)?;
        }
        let original = DomainCommand::Fork {
            session: control.session.clone(),
            request: control.request.clone(),
        };
        let outcome = match self.journal.lookup(&control.operation, &original).await {
            Ok(Some(outcome)) => outcome,
            Ok(None) => {
                // Shutdown may reject an admitted queued envelope before its
                // Started. Seal its cancellation now, rather than allowing a
                // later retry/restart to execute the cancelled remote effect.
                match self
                    .journal
                    .begin(control.operation.clone(), &original)
                    .await?
                {
                    Admission::Replay(outcome) => outcome,
                    Admission::Execute(ticket) => {
                        let outcome = Err(DomainError::ForkCancelled);
                        self.journal.finish(ticket, &outcome).await?;
                        outcome
                    }
                }
            }
            Err(DomainError::OperationInterrupted) => return Err(DomainError::NativeForkUncertain),
            Err(error) => return Err(error),
        };
        match outcome {
            Ok(receipt) => Ok(receipt), // Confirmed success won the cancellation race.
            Err(DomainError::ForkCancelled) => Ok(CommandReceipt::ForkCancelRequested {
                source: session.clone(),
                operation: operation.clone(),
            }),
            Err(error) => Err(error), // Never claim cancellation of an uncertain effect.
        }
    }
}
