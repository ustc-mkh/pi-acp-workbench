//! Bounded transcript windows shared by initial state and explicit older-page reads.
use crate::types::Entry;
use serde_json::{json, Value};
const PAGE_ENTRIES: usize = 100;
const PAGE_BYTES: usize = 16 * 1024 * 1024;
pub fn window(entries: &[Entry], end: usize) -> (Vec<Entry>, usize) {
    let mut start = end.min(entries.len());
    let mut bytes = 0;
    while start > 0 && end - start < PAGE_ENTRIES {
        let size = serde_json::to_vec(&entries[start - 1]).map_or(PAGE_BYTES, |v| v.len());
        if start < end && bytes + size > PAGE_BYTES {
            break;
        }
        bytes += size;
        start -= 1;
    }
    (entries[start..end.min(entries.len())].to_vec(), start)
}
pub fn page(entries: &[Entry], before_id: &str) -> Result<Value, String> {
    let end = entries
        .iter()
        .position(|entry| entry.id == before_id)
        .ok_or("历史分页锚点不存在，请刷新会话")?;
    let (page, remaining) = window(entries, end);
    Ok(json!({"entries":page,"remaining":remaining}))
}
pub fn trim(snapshot: &mut crate::types::Snapshot) {
    let (entries, before) = window(&snapshot.entries, snapshot.entries.len());
    snapshot.entries = entries;
    snapshot.extra.insert("historyBefore".into(), json!(before));
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pages_backwards_without_gaps_while_new_entries_are_appended() {
        let mut entries: Vec<_> = (0..350)
            .map(|i| Entry::text_entry(i.to_string(), "user", "text".into()))
            .collect();
        let (latest, remaining) = window(&entries, entries.len());
        assert_eq!(remaining, 250);
        entries.push(Entry::text_entry("new".into(), "assistant", "new".into()));
        let older = page(&entries, &latest[0].id).unwrap();
        assert_eq!(older["remaining"], 150);
        assert_eq!(older["entries"][99]["id"], "249");
    }
    #[test]
    fn byte_budget_bounds_large_histories() {
        let entries: Vec<_> = (0..70)
            .map(|i| Entry::text_entry(i.to_string(), "assistant", "x".repeat(1024 * 1024)))
            .collect();
        let (latest, remaining) = window(&entries, entries.len());
        assert!(latest.len() < 16);
        assert!(remaining > 50);
        assert!(serde_json::to_vec(&latest).unwrap().len() < PAGE_BYTES);
    }
}
