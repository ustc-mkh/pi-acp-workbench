//! Worker residency is separate from durable sessions and native history.
const DAY: u64 = 24 * 60 * 60;

pub(super) fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub(super) fn expired(now: u64, resident_since: u64, last_input: u64, recent: bool) -> bool {
    let since = if last_input == 0 {
        resident_since
    } else {
        last_input
    };
    now.saturating_sub(since) >= DAY * if recent { 4 } else { 1 }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expiry_uses_user_input_and_exact_one_or_four_day_boundaries() {
        for (recent, ttl) in [(false, DAY), (true, 4 * DAY)] {
            assert!(!expired(100 + ttl - 1, 1, 100, recent));
            assert!(expired(100 + ttl, 1, 100, recent));
            assert!(expired(100 + ttl + 1, 1, 100, recent));
        }
        assert!(expired(10 + DAY, 10, 0, false));
        assert!(!expired(10, 100, 200, true)); // Clock rollback cannot expire work.
    }
}
