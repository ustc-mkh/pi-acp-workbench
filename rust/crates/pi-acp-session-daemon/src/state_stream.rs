//! Optional delta subscriptions. A bounded shared baseline avoids one history copy per client.
use serde_json::{json, Value};
use std::collections::HashMap;

const CACHE_BYTES: usize = 64 * 1024 * 1024;
const CACHE_SESSIONS: usize = 32;

#[derive(Default)]
pub struct Subscription {
    pub delta: bool,
    pub permissions_only: bool,
    pub revision: Option<u64>,
}

struct Baseline {
    state: Value,
    revision: u64,
    bytes: usize,
}

#[derive(Default)]
pub struct StateStreams {
    states: HashMap<String, Baseline>,
    revision: u64,
    bytes: usize,
}

pub struct Frames {
    pub full: Value,
    pub patch: Option<Value>,
    pub permissions: Value,
    pub previous: Option<u64>,
    pub revision: u64,
}

impl StateStreams {
    pub fn next(&mut self, id: &str, mut state: Value) -> Frames {
        self.revision += 1;
        let revision = self.revision;
        let old = self.states.remove(id);
        if let Some(old) = &old {
            self.bytes -= old.bytes;
        }
        let previous = old.as_ref().map(|b| b.revision);
        let patch = old.as_ref().and_then(|old| {
            let entries = state.pointer("/snapshot/entries")?.as_array()?;
            let previous = old.state.pointer("/snapshot/entries")?.as_array()?;
            let by_id: HashMap<&str, &Value> = previous.iter()
                .filter_map(|e| Some((e.get("id")?.as_str()?, e))).collect();
            let changed: Vec<&Value> = entries.iter().filter(|e| {
                e.get("id").and_then(Value::as_str).and_then(|id| by_id.get(id)).copied() != Some(*e)
            }).collect();
            let order: Vec<&Value> = entries.iter().map(|e| &e["id"]).collect();
            let old_order: Vec<&Value> = previous.iter().map(|e| &e["id"]).collect();
            // Clone metadata only, never clone the full history to remove it afterwards.
            let mut metadata = state.as_object()?.iter()
                .filter(|(k, _)| !matches!(k.as_str(), "snapshot" | "type" | "revision"))
                .map(|(k,v)| (k.clone(),v.clone())).collect::<serde_json::Map<String,Value>>();
            let snapshot = state["snapshot"].as_object()?.iter()
                .filter(|(k, _)| k.as_str() != "entries").map(|(k,v)| (k.clone(),v.clone()))
                .collect::<serde_json::Map<String,Value>>();
            metadata.insert("snapshot".into(), Value::Object(snapshot));
            let mut patch = json!({"type":"statePatch","sessionId":id,
                "baseRevision":old.revision,"revision":revision,"state":metadata,"entries":changed});
            if order != old_order { patch["order"] = json!(order); }
            Some(patch)
        });
        let permissions =
            json!({"type":"state","snapshot":{"id":id},"permissions":state["permissions"]});
        state["revision"] = json!(revision);
        // Bound retained history by serialized size; oversized sessions still receive full frames.
        let bytes = serde_json::to_vec(&state)
            .map(|s| s.len())
            .unwrap_or(usize::MAX);
        if bytes <= CACHE_BYTES {
            while !self.states.is_empty()
                && (self.bytes + bytes > CACHE_BYTES || self.states.len() >= CACHE_SESSIONS)
            {
                let oldest = self
                    .states
                    .iter()
                    .min_by_key(|(_, b)| b.revision)
                    .unwrap()
                    .0
                    .clone();
                self.bytes -= self.states.remove(&oldest).unwrap().bytes;
            }
            self.bytes += bytes;
            self.states.insert(
                id.into(),
                Baseline {
                    state: state.clone(),
                    revision,
                    bytes,
                },
            );
        }
        Frames {
            full: state,
            patch,
            permissions,
            previous,
            revision,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state(entries: Value) -> Value {
        json!({"type":"state","snapshot":{"id":"one","entries":entries},"busy":true,"permissions":[],"commands":[]})
    }
    #[test]
    fn sends_only_changed_entries_and_preserves_unicode_and_removals() {
        let mut stream = StateStreams::default();
        let old = json!({"id":"old","text":"大".repeat(1024*1024)});
        let first = stream.next("one", state(json!([old,{"id":"live","text":"中"}])));
        assert!(first.patch.is_none());
        let second = stream.next("one", state(json!([old,{"id":"live","text":"中文😀"}])));
        let patch = second.patch.unwrap();
        assert_eq!(patch["baseRevision"], first.revision);
        assert_eq!(patch["entries"], json!([{"id":"live","text":"中文😀"}]));
        assert!(patch.get("order").is_none());
        assert!(serde_json::to_vec(&patch).unwrap().len() < 1024);
        assert!(serde_json::to_vec(&second.permissions).unwrap().len() < 200);
        let third = stream.next("one", state(json!([{"id":"live","text":"中文😀"}])));
        assert_eq!(third.patch.unwrap()["order"], json!(["live"]));
    }
    #[test]
    fn evicted_baselines_fall_back_to_full_state() {
        let mut stream = StateStreams::default();
        for i in 0..=CACHE_SESSIONS {
            stream.next(&i.to_string(), state(json!([])));
        }
        assert_eq!(stream.states.len(), CACHE_SESSIONS);
        assert!(stream.next("0", state(json!([]))).patch.is_none());
    }
}
