//! Catch an unexpected panic at an async worker boundary; never poll it again.
use std::future::{poll_fn, Future};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::task::Poll;
pub async fn run<F: Future>(future: F) -> Result<F::Output, ()> {
    let mut future = std::pin::pin!(future);
    poll_fn(
        |cx| match catch_unwind(AssertUnwindSafe(|| future.as_mut().poll(cx))) {
            Ok(Poll::Ready(value)) => Poll::Ready(Ok(value)),
            Ok(Poll::Pending) => Poll::Pending,
            Err(_) => Poll::Ready(Err(())),
        },
    )
    .await
}
#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn catches_panics_after_a_suspend_and_other_tasks_continue() {
        assert!(super::run(async {
            tokio::task::yield_now().await;
            panic!("worker bug")
        })
        .await
        .is_err());
        assert_eq!(super::run(async { 42 }).await, Ok(42));
    }
}
