//! Runtime phases keep cancellation and turn resources inside an active operation.
use crate::outbox::TurnPublication;
#[derive(Clone, Copy, PartialEq)]
pub enum Step {
    Preparing,
    Replaying,
    Prompting,
    Finishing,
}
static SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
pub struct Active {
    pub token: u64,
    pub step: Step,
    pub cancelled: bool,
    pub publication: Option<TurnPublication>,
    pub cancel_task: Option<tokio::task::JoinHandle<()>>,
}
pub enum Phase {
    Idle,
    Active(Active),
}
impl Phase {
    pub fn begin() -> Self {
        Self::Active(Active {
            token: SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            step: Step::Preparing,
            cancelled: false,
            publication: None,
            cancel_task: None,
        })
    }
    pub fn token(&self) -> Option<u64> {
        self.active().map(|active| active.token)
    }
    pub fn busy(&self) -> bool {
        matches!(self, Self::Active(_))
    }
    pub fn cancelled(&self) -> bool {
        matches!(
            self,
            Self::Active(Active {
                cancelled: true,
                ..
            })
        )
    }
    pub fn at(&self, step: Step) -> bool {
        matches!(self, Self::Active(active) if active.step == step)
    }
    pub fn active(&self) -> Option<&Active> {
        match self {
            Self::Idle => None,
            Self::Active(active) => Some(active),
        }
    }
    pub fn active_mut(&mut self) -> Option<&mut Active> {
        match self {
            Self::Active(active) => Some(active),
            Self::Idle => None,
        }
    }
    pub fn take_publication(&mut self) -> Option<TurnPublication> {
        match self {
            Self::Active(active) => active.publication.take(),
            Self::Idle => None,
        }
    }
    pub fn stop_cancel_timer(&mut self) {
        if let Self::Active(active) = self {
            if let Some(task) = active.cancel_task.take() {
                task.abort();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_access_and_cleanup_do_not_panic() {
        let mut phase = Phase::Idle;
        assert!(phase.active_mut().is_none());
        assert!(phase.take_publication().is_none());
        phase.stop_cancel_timer();
        phase = Phase::begin();
        phase.active_mut().unwrap().cancelled = true;
        assert!(phase.cancelled());
    }
}
