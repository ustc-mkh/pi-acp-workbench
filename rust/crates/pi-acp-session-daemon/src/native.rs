//! native-branch.ts port — fork-point hashing and UI↔native binding.
//! Verify with test/fixtures/native-branch/*.json (scripts/export-fixtures.mjs):
//! each fixture is {name, kind, description, entries, uiEntries?, previous?, expected}.
//! Write `#[cfg(test)]` tests in this file loading every fixture via include_str!:
//! kind 'points' → fork points + prefixHash must equal expected byte-for-byte
//! (or expected.error must occur); kind 'bind' → bound map equality.
//!
//! Semantics (src/native-branch.ts):
//! - canonicalEntries(path): drop 'label' entries; strip `parentId` from every
//!   kept entry; record each label's id→following kept entry id; a 'compaction'
//!   entry whose firstKeptEntryId was labelled gets it remapped to the kept id.
//! - nativePrefixHash(path) = sha256(JSON.stringify(kept entries array)) — the
//!   serialization is JS-style compact JSON with each entry's own key order —
//!   use serde_json::to_string on a Value built by deleting `parentId` keys, NOT
//!   a struct (entry field order is whatever the file had).
//! - nativeForkPoints(path): stream entries; incremental prefix hash = sha256 of
//!   '[' + joined canonical entry serializations + ']' — equivalent to hashing
//!   the whole array; emits {entryId,hash,role,key,timestamp,safe} for user and
//!   assistant messages only. `safe` requires every toolCall id to have a
//!   toolResult and vice versa, and stopReason not in {error,aborted,pending}.
//!   'compaction' truncates tracked message/tool state to firstKeptEntryId
//!   (boundary missing or >i → '原生压缩边界无效，无法安全分支。');
//!   'context_edit' with replacement:null deletes the message, otherwise
//!   replaces its content (only when target ≥ last compaction boundary).
//! - nativeTextKey(role,text) = `${role}:${sha256(text)}`; textOf(content):
//!   string → itself; array → text-type parts joined.
//! - bindNativeForks(entries, points, previous={}): build sha256 keys from UI
//!   entries using uiText() (contextBlocks → embedded-context reconstruction,
//!   see uiText in the TS file); ambiguous keys (count>1) bind only via
//!   previous-verified {entryId,hash} or unique timestamp match (entry.messageId
//!   == String(point.timestamp)) or unique key+unique point; only `safe` points.
use crate::types::{Entry, NativeBranchTarget};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeForkPoint {
    pub entry_id: String,
    pub hash: String,
    pub role: String,
    pub key: String,
    // JSON.stringify drops `undefined` — None must omit the key on the wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<f64>,
    pub safe: bool,
}

fn digest(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

/// Compact JSON.stringify equivalent for parsed Values — full ECMAScript key
/// order: integer-index keys ("0","1",… < 2^32-1) ascending FIRST, then string
/// keys in document order (preserve_order gives us the latter). Without this,
/// nested objects containing numeric-looking keys would hash differently from
/// TS (serde preserve_order alone keeps insertion order).
fn stringify(value: &Value) -> String {
    let mut out = String::new();
    js_write(&mut out, value);
    out
}

/// JS array-index rule: ToString(ToUint32(key)) === key && key !== "4294967295".
fn array_index(key: &str) -> Option<u64> {
    if key.is_empty() || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u64 = key.parse().ok()?;
    if n < u32::MAX as u64 && n.to_string() == key {
        Some(n)
    } else {
        None
    }
}

fn js_write(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&pi_acp_core::canonical::js_number_string(n)),
        Value::String(t) => pi_acp_core::canonical::js_escape_string(out, t),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                js_write(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut indexed: Vec<(u64, &String)> = map.keys().filter_map(|k| array_index(k).map(|n| (n, k))).collect();
            indexed.sort_by_key(|(n, _)| *n);
            let rest = map.keys().filter(|k| array_index(k).is_none());
            out.push('{');
            let mut first = true;
            for key in indexed.iter().map(|(_, k)| *k).chain(rest) {
                if !first {
                    out.push(',');
                }
                first = false;
                pi_acp_core::canonical::js_escape_string(out, key);
                out.push(':');
                js_write(out, &map[key]);
            }
            out.push('}');
        }
    }
}

/// Canonical JSON form of a toolCall/toolResult id used as a set key — the
/// SameValueZero stand-in for JS `Set` semantics.
fn set_key(value: Option<&Value>) -> String {
    value.map(stringify).unwrap_or_else(|| "undefined".into())
}

/// Walk parents from leaf to root; duplicates → '原生历史包含重复节点，无法安全分支。';
/// missing/cyclic → '原生历史链不完整，无法安全分支。'.
#[allow(dead_code)] // used by the fork path / tests; wired by service integration
pub fn native_path(entries: &[Value], leaf_id: Option<&str>) -> Result<Vec<Value>, String> {
    let mut by_id: HashMap<&str, &Value> = HashMap::new();
    for entry in entries {
        // Missing ids collapse onto "" — two such entries read as duplicates,
        // exactly like two `undefined` keys in the TS Map.
        by_id.insert(entry.get("id").and_then(Value::as_str).unwrap_or(""), entry);
    }
    if by_id.len() != entries.len() {
        return Err("原生历史包含重复节点，无法安全分支。".into());
    }
    let mut seen: HashSet<&str> = HashSet::new();
    let mut path: Vec<Value> = Vec::new();
    let mut current = leaf_id;
    while let Some(id) = current {
        let Some(entry) = by_id.get(id) else {
            return Err("原生历史链不完整，无法安全分支。".into());
        };
        if !seen.insert(id) {
            return Err("原生历史链不完整，无法安全分支。".into());
        }
        path.push((*entry).clone());
        current = match entry.get("parentId") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.as_str()),
            // JS would Map.get() a non-string parentId and miss → chain error.
            Some(_) => return Err("原生历史链不完整，无法安全分支。".into()),
        };
    }
    path.reverse();
    Ok(path)
}

/// Labels are UI metadata and Pi re-creates them when forking. Context payloads stay byte-equivalent.
fn canonical_entries(path: &[Value]) -> Vec<Option<Value>> {
    let mut next: HashMap<String, String> = HashMap::new();
    let mut labels: Vec<String> = Vec::new();
    for entry in path {
        if entry.get("type").and_then(Value::as_str) == Some("label") {
            labels.push(entry.get("id").and_then(Value::as_str).unwrap_or("").to_string());
        } else {
            for id in labels.drain(..) {
                next.insert(id, entry.get("id").and_then(Value::as_str).unwrap_or("").to_string());
            }
        }
    }
    path.iter()
        .map(|entry| {
            if entry.get("type").and_then(Value::as_str) == Some("label") {
                return None;
            }
            let mut data = entry.clone();
            if let Some(object) = data.as_object_mut() {
                // preserve_order Map::remove is swap_remove — it would move the
                // last key into the hole. JS `{parentId, ...rest}` keeps order,
                // so shift_remove is required for byte-identical hashing.
                object.shift_remove("parentId");
                if object.get("type").and_then(Value::as_str) == Some("compaction") {
                    if let Some(kept) = object.get("firstKeptEntryId").and_then(Value::as_str) {
                        if let Some(remapped) = next.get(kept) {
                            object.insert("firstKeptEntryId".into(), Value::String(remapped.clone()));
                        }
                    }
                }
            }
            Some(data)
        })
        .collect()
}

#[allow(dead_code)] // used by the fork path / tests; wired by service integration
pub fn native_prefix_hash(path: &[Value]) -> String {
    // sha256(JSON.stringify(kept array)) — '[' + joined serializations + ']'.
    let mut body = String::from("[");
    let mut comma = false;
    for entry in canonical_entries(path).into_iter().flatten() {
        if comma {
            body.push(',');
        }
        body.push_str(&stringify(&entry));
        comma = true;
    }
    body.push(']');
    digest(&body)
}

/// textOf(content): string → itself; array → text-type parts joined.
fn text_of(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|c| c.get("type").and_then(Value::as_str) == Some("text"))
            .map(|c| c.get("text").and_then(Value::as_str).unwrap_or("").to_string())
            .collect(),
        _ => String::new(),
    }
}

pub fn native_text_key(role: &str, text: &str) -> String {
    format!("{role}:{}", digest(text))
}

/// Rebuild tool pairing state from the tracked messages map.
fn rebuild(messages: &HashMap<String, Value>, calls: &mut HashSet<String>, results: &mut HashSet<String>) {
    calls.clear();
    results.clear();
    for message in messages.values() {
        if message.get("role").and_then(Value::as_str) == Some("assistant") {
            if let Some(content) = message.get("content").and_then(Value::as_array) {
                for c in content {
                    if c.get("type").and_then(Value::as_str) == Some("toolCall") {
                        calls.insert(set_key(c.get("id")));
                    }
                }
            }
        }
        if message.get("role").and_then(Value::as_str) == Some("toolResult") {
            results.insert(set_key(message.get("toolCallId")));
        }
    }
}

#[allow(dead_code)] // used by the fork path / tests; wired by service integration
pub fn native_fork_points(path: &[Value]) -> Result<Vec<NativeForkPoint>, String> {
    let mut points: Vec<NativeForkPoint> = Vec::new();
    let mut messages: HashMap<String, Value> = HashMap::new();
    let mut calls: HashSet<String> = HashSet::new();
    let mut results: HashSet<String> = HashSet::new();
    let canonical = canonical_entries(path);
    let mut prefix = Sha256::new();
    prefix.update(b"[");
    let mut comma = false;
    let mut context_start = 0usize;
    let positions: HashMap<String, usize> = path
        .iter()
        .enumerate()
        .map(|(i, e)| (e.get("id").and_then(Value::as_str).unwrap_or("").to_string(), i))
        .collect();
    for (i, e) in path.iter().enumerate() {
        if let Some(c) = &canonical[i] {
            if comma {
                prefix.update(b",");
            }
            prefix.update(stringify(c).as_bytes());
            comma = true;
        }
        let ty = e.get("type").and_then(Value::as_str).unwrap_or("");
        let message = e.get("message").filter(|m| !m.is_null());
        let id = e.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        if ty == "message" {
            if let Some(m) = message {
                messages.insert(id.clone(), m.clone());
                if m.get("role").and_then(Value::as_str) == Some("assistant") {
                    if let Some(content) = m.get("content").and_then(Value::as_array) {
                        for c in content {
                            if c.get("type").and_then(Value::as_str) == Some("toolCall") {
                                calls.insert(set_key(c.get("id")));
                            }
                        }
                    }
                }
                if m.get("role").and_then(Value::as_str) == Some("toolResult") {
                    results.insert(set_key(m.get("toolCallId")));
                }
            }
        }
        if ty == "compaction" {
            let boundary = e
                .get("firstKeptEntryId")
                .and_then(Value::as_str)
                .and_then(|k| positions.get(k))
                .copied();
            match boundary {
                Some(boundary) if boundary <= i => {
                    context_start = boundary;
                    let drop_ids: Vec<String> = messages
                        .keys()
                        .filter(|k| positions.get(*k).copied().unwrap_or(usize::MAX) < boundary)
                        .cloned()
                        .collect();
                    for key in drop_ids {
                        messages.remove(&key);
                    }
                    rebuild(&messages, &mut calls, &mut results);
                }
                _ => return Err("原生压缩边界无效，无法安全分支。".into()),
            }
        }
        if ty == "context_edit" {
            let position = e
                .get("targetId")
                .and_then(Value::as_str)
                .and_then(|t| positions.get(t))
                .copied();
            let old = position.and_then(|p| path[p].get("message"));
            if let Some(p) = position {
                if p >= context_start {
                    if e.get("replacement") == Some(&Value::Null) {
                        let target = e.get("targetId").and_then(Value::as_str).unwrap_or("").to_string();
                        messages.remove(&target);
                    } else if let Some(old) = old {
                        // {...old, content: replacement} — missing `replacement`
                        // reads as JS `undefined`, scanned the same as null.
                        let mut updated = old.clone();
                        let replacement = e.get("replacement").cloned().unwrap_or(Value::Null);
                        if let Some(object) = updated.as_object_mut() {
                            object.insert("content".into(), replacement);
                        }
                        let target = e.get("targetId").and_then(Value::as_str).unwrap_or("").to_string();
                        messages.insert(target, updated);
                    }
                    rebuild(&messages, &mut calls, &mut results);
                }
            }
        }
        let Some(m) = message else { continue };
        if ty != "message" {
            continue;
        }
        let role = m.get("role").and_then(Value::as_str).unwrap_or("");
        if role != "user" && role != "assistant" {
            continue;
        }
        let stop_reason = m.get("stopReason").and_then(Value::as_str).unwrap_or("");
        let safe = calls.iter().all(|c| results.contains(c))
            && results.iter().all(|r| calls.contains(r))
            && !matches!(stop_reason, "error" | "aborted" | "pending");
        let hash = if safe {
            let mut full = prefix.clone();
            full.update(b"]");
            hex::encode(full.finalize())
        } else {
            String::new()
        };
        points.push(NativeForkPoint {
            entry_id: id,
            hash,
            role: role.to_string(),
            key: native_text_key(role, &text_of(m.get("content"))),
            timestamp: m.get("timestamp").and_then(Value::as_f64),
            safe,
        });
    }
    Ok(points)
}

/// JS `String(number)` for bind timestamps: Rust `{}` on f64 prints "10" for
/// 10.0 like JS; only NaN/Infinity need explicit spelling.
fn js_number_string(value: Option<f64>) -> String {
    match value {
        None => "undefined".into(),
        Some(v) if v.is_nan() => "NaN".into(),
        Some(v) if v.is_infinite() => {
            if v > 0.0 { "Infinity".into() } else { "-Infinity".into() }
        }
        Some(v) => format!("{v}"),
    }
}

/// Same text encoding as the pinned pi-acp promptToPiMessage; no model or image transformations.
fn ui_text(entry: &Entry) -> String {
    if entry.role != "user" {
        return entry.text().to_string();
    }
    let Some(blocks) = &entry.context_blocks else {
        return entry.text().to_string();
    };
    blocks
        .iter()
        .map(|b| match b.get("type").and_then(Value::as_str) {
            Some("text") => b.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
            Some("resource_link") => {
                let uri = b.get("uri").and_then(Value::as_str).unwrap_or("undefined");
                format!("\n[Context] {uri}")
            }
            Some("resource") => {
                let resource = b.get("resource");
                let has_text = resource.and_then(Value::as_object).is_some_and(|r| r.contains_key("text"));
                if has_text {
                    let uri = resource
                        .and_then(|r| r.get("uri"))
                        .and_then(Value::as_str)
                        .unwrap_or("undefined");
                    let mime = resource
                        .and_then(|r| r.get("mimeType"))
                        .and_then(Value::as_str)
                        .filter(|m| !m.is_empty())
                        .unwrap_or("text/plain");
                    let text = resource
                        .and_then(|r| r.get("text"))
                        .and_then(Value::as_str)
                        .unwrap_or("undefined");
                    format!("\n[Embedded Context] {uri} ({mime})\n{text}")
                } else {
                    String::new()
                }
            }
            _ => String::new(),
        })
        .collect()
}

/// Ambiguous old display rows fail closed instead of guessing a native cut point.
pub fn bind_native_forks(
    entries: &[Entry],
    points: &[NativeForkPoint],
    previous: &BTreeMap<String, NativeBranchTarget>,
) -> BTreeMap<String, NativeBranchTarget> {
    let mut out: BTreeMap<String, NativeBranchTarget> = BTreeMap::new();
    let mut keys: HashMap<String, usize> = HashMap::new();
    for e in entries {
        if e.role == "user" || e.role == "assistant" {
            *keys.entry(native_text_key(&e.role, &ui_text(e))).or_default() += 1;
        }
    }
    for e in entries {
        if e.role != "user" && e.role != "assistant" {
            continue;
        }
        let key = native_text_key(&e.role, &ui_text(e));
        let matches: Vec<&NativeForkPoint> = points.iter().filter(|p| p.key == key).collect();
        let saved = previous.get(&e.id).and_then(|prev| {
            matches
                .iter()
                .find(|p| p.entry_id == prev.entry_id && p.hash == prev.hash)
        });
        let timed: Vec<&&NativeForkPoint> = match e.message_id.as_ref().and_then(Value::as_str) {
            Some(message_id) if !message_id.is_empty() => matches
                .iter()
                .filter(|p| js_number_string(p.timestamp) == message_id)
                .collect(),
            _ => Vec::new(),
        };
        let point = saved
            .copied()
            .or_else(|| (timed.len() == 1).then(|| *timed[0]))
            .or_else(|| (matches.len() == 1 && keys.get(&key) == Some(&1)).then(|| matches[0]));
        if let Some(point) = point {
            if point.safe {
                out.insert(
                    e.id.clone(),
                    NativeBranchTarget { entry_id: point.entry_id.clone(), hash: point.hash.clone() },
                );
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fixture {
        kind: String,
        entries: Vec<Value>,
        ui_entries: Vec<Entry>,
        previous: BTreeMap<String, NativeBranchTarget>,
        expected: Value,
    }

    fn load(source: &str) -> Fixture {
        let fixture: Value = serde_json::from_str(source).unwrap();
        Fixture {
            kind: fixture["kind"].as_str().unwrap().to_string(),
            entries: fixture["entries"].as_array().cloned().unwrap_or_default(),
            ui_entries: serde_json::from_value(fixture.get("uiEntries").cloned().unwrap_or(json!([])))
                .unwrap_or_default(),
            previous: serde_json::from_value(fixture.get("previous").cloned().unwrap_or(json!({})))
                .unwrap_or_default(),
            expected: fixture["expected"].clone(),
        }
    }

    fn check(name: &str, source: &str) {
        let fixture = load(source);
        match fixture.kind.as_str() {
            "points" => {
                if let Some(error) = fixture.expected.get("error").and_then(Value::as_str) {
                    let result = native_fork_points(&fixture.entries);
                    assert!(
                        result.as_ref().err().is_some_and(|e| e.contains(error)),
                        "{name}: expected error containing {error:?}, got {result:?}"
                    );
                    return;
                }
                let points = native_fork_points(&fixture.entries).unwrap_or_else(|e| panic!("{name}: {e}"));
                let expected_points = fixture.expected["forkPoints"].as_array().unwrap();
                assert_eq!(points.len(), expected_points.len(), "{name}: forkPoints length");
                for (i, (point, expected)) in points.iter().zip(expected_points.iter()).enumerate() {
                    let field = |k: &str| expected.get(k);
                    assert_eq!(Some(&point.entry_id), field("entryId").and_then(Value::as_str).map(|s| s.to_string()).as_ref(), "{name}: point {i} entryId");
                    assert_eq!(point.hash, field("hash").and_then(Value::as_str).unwrap_or(""), "{name}: point {i} hash");
                    assert_eq!(point.role, field("role").and_then(Value::as_str).unwrap_or(""), "{name}: point {i} role");
                    assert_eq!(point.key, field("key").and_then(Value::as_str).unwrap_or(""), "{name}: point {i} key");
                    assert_eq!(point.safe, field("safe").and_then(Value::as_bool).unwrap_or(false), "{name}: point {i} safe");
                    match field("timestamp") {
                        Some(t) => assert_eq!(point.timestamp, t.as_f64(), "{name}: point {i} timestamp"),
                        None => assert_eq!(point.timestamp, None, "{name}: point {i} timestamp"),
                    }
                }
                assert_eq!(
                    native_prefix_hash(&fixture.entries),
                    fixture.expected["prefixHash"].as_str().unwrap(),
                    "{name}: prefixHash"
                );
            }
            "bind" => {
                let points = native_fork_points(&fixture.entries).unwrap_or_else(|e| panic!("{name}: {e}"));
                let bound = bind_native_forks(&fixture.ui_entries, &points, &fixture.previous);
                let expected: BTreeMap<String, NativeBranchTarget> =
                    serde_json::from_value(fixture.expected["bound"].clone()).unwrap();
                assert_eq!(bound.len(), expected.len(), "{name}: bound size");
                for (key, target) in &expected {
                    let actual = bound.get(key).unwrap_or_else(|| panic!("{name}: missing bound[{key}]"));
                    assert_eq!(&actual.entry_id, &target.entry_id, "{name}: bound[{key}].entryId");
                    assert_eq!(&actual.hash, &target.hash, "{name}: bound[{key}].hash");
                }
            }
            other => panic!("{name}: unknown fixture kind {other}"),
        }
    }

    macro_rules! fixture {
        ($name:literal) => {
            check($name, include_str!(concat!("../../../../test/fixtures/native-branch/", $name, ".json")));
        };
    }

    #[test]
    fn native_branch_fixtures() {
        fixture!("compaction-boundary");
        fixture!("duplicate-text-previous");
        fixture!("duplicate-text-timestamp");
        fixture!("embedded-context-image");
        fixture!("error-and-context-edit");
        fixture!("invalid-compaction-boundary");
        fixture!("label-rechaining");
        fixture!("numeric-keys");
        fixture!("orphaned-result");
        fixture!("tool-pairing");
    }

    #[test]
    fn native_path_validates_chain() {
        let entries: Vec<Value> = serde_json::from_str(
            r#"[
                {"type":"message","id":"0","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"a"}]}},
                {"type":"message","id":"1","parentId":"0","message":{"role":"assistant","content":[{"type":"text","text":"b"}]}},
                {"type":"message","id":"2","parentId":"0","message":{"role":"user","content":[{"type":"text","text":"abandoned"}]}}
            ]"#,
        )
        .unwrap();
        let path = native_path(&entries, Some("1")).unwrap();
        assert_eq!(path.iter().map(|e| e["id"].as_str().unwrap()).collect::<Vec<_>>(), ["0", "1"]);
        assert!(native_path(&entries, Some("missing")).unwrap_err().contains("不完整"));
        // Cyclic parent chain fails closed.
        let cyclic: Vec<Value> = serde_json::from_str(
            r#"[{"type":"message","id":"0","parentId":"0","message":{"role":"user","content":[]}}]"#,
        )
        .unwrap();
        assert!(native_path(&cyclic, Some("0")).unwrap_err().contains("不完整"));
        // Duplicate ids fail closed.
        let dup: Vec<Value> = serde_json::from_str(
            r#"[
                {"type":"message","id":"0","parentId":null,"message":{"role":"user","content":[]}},
                {"type":"message","id":"0","parentId":null,"message":{"role":"user","content":[]}}
            ]"#,
        )
        .unwrap();
        assert!(native_path(&dup, Some("0")).unwrap_err().contains("重复节点"));
    }
}

