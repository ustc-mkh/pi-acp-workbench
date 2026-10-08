//! Short synchronous locks at daemon task boundaries tolerate caught panics.
//! Recovery prevents cascading panics; callers still own their state invariants.
use std::sync::{Mutex, MutexGuard};

pub trait MutexExt<T: ?Sized> {
    fn lock_unpoisoned(&self) -> MutexGuard<'_, T>;
}

impl<T: ?Sized> MutexExt<T> for Mutex<T> {
    fn lock_unpoisoned(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn caught_panic_does_not_poison_subsequent_tasks() {
        let state = Mutex::new(0);
        assert!(crate::panic_guard::run(async {
            *state.lock_unpoisoned() = 1;
            let _guard = state.lock_unpoisoned();
            panic!("worker bug while holding state");
        })
        .await
        .is_err());
        assert!(state.is_poisoned());
        assert_eq!(
            crate::panic_guard::run(async {
                *state.lock_unpoisoned() += 1;
                *state.lock_unpoisoned()
            })
            .await,
            Ok(2)
        );
        assert_eq!(*state.lock_unpoisoned(), 2);
    }
}
