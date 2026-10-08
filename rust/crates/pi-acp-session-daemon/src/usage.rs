//! Normalize the per-turn usage reported by Codex/Claude ACP adapters.
//! Context occupancy is deliberately kept separate from billing counters.
use crate::types::{ChatState, Snapshot};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MAX_SAFE: u64 = 9_007_199_254_740_991;
const PAGE: usize = 500;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    pub id: String,
    pub session_id: String,
    pub model: String,
    pub timestamp: u64,
    pub kind: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}
fn count(v: &Value, key: &str, optional: bool) -> Option<u64> {
    match v.get(key) {
        None | Some(Value::Null) if optional => Some(0),
        Some(n) => n.as_u64().filter(|n| *n <= MAX_SAFE),
        _ => None,
    }
}
fn model_name(value: &str) -> bool {
    !value.is_empty() && value.len() < 300
}
fn selected_model(state: &ChatState) -> String {
    state
        .configs
        .as_ref()
        .into_iter()
        .flatten()
        .find(|c| c["category"] == "model" || c["id"] == "model")
        .and_then(|c| c["currentValue"].as_str())
        .filter(|m| model_name(m))
        .unwrap_or("unknown")
        .to_string()
}
fn record(
    snapshot: &Snapshot,
    turn: &str,
    timestamp: u64,
    model: &str,
    v: &Value,
    quota: bool,
    ordinal: usize,
) -> Option<UsageRecord> {
    if !model_name(model) {
        return None;
    }
    // Both supported adapters already exclude cache reads from inputTokens;
    // reasoning tokens are part of outputTokens, never add them a second time.
    Some(UsageRecord {
        id: format!(
            "acp:{}:{ordinal}",
            pi_acp_core::canonical::sha256_hex(&json!([snapshot.id, turn]).to_string())
        ),
        session_id: snapshot.id.clone(),
        model: model.into(),
        timestamp,
        kind: "acp-turn".into(),
        input: count(v, "inputTokens", false)?,
        output: count(v, "outputTokens", false)?,
        cache_read: count(
            v,
            if quota {
                "cachedInputTokens"
            } else {
                "cachedReadTokens"
            },
            true,
        )?,
        cache_write: count(v, "cachedWriteTokens", true)?,
    })
}
/// Prefer model rows (Claude includes subagents there); never add the aggregate
/// to those rows. If any row is malformed, fall back to the complete aggregate.
pub fn capture(
    snapshot: &Snapshot,
    state: &mut ChatState,
    response: &Value,
    turn: &str,
    timestamp: u64,
) {
    if !matches!(snapshot.harness.as_deref(), Some("codex" | "claude")) {
        return;
    }
    let rows = response
        .pointer("/_meta/quota/model_usage")
        .and_then(Value::as_array)
        .filter(|rows| !rows.is_empty() && rows.len() <= 100)
        .and_then(|rows| {
            rows.iter()
                .enumerate()
                .map(|(i, row)| {
                    record(
                        snapshot,
                        turn,
                        timestamp,
                        row["model"].as_str()?,
                        &row["token_count"],
                        true,
                        i,
                    )
                })
                .collect::<Option<Vec<_>>>()
        });
    let records = rows.unwrap_or_else(|| {
        let model = selected_model(state);
        let usage = response
            .get("usage")
            .and_then(|v| record(snapshot, turn, timestamp, &model, v, false, 0))
            .or_else(|| {
                response
                    .pointer("/_meta/quota/token_count")
                    .and_then(|v| record(snapshot, turn, timestamp, &model, v, true, 0))
            });
        usage.into_iter().collect()
    });
    for r in records {
        if !state.usage_records.iter().any(|old| old.id == r.id) {
            state.usage_records.push(r);
        }
    }
}
pub fn inspect(snapshot: &Snapshot, cursor: Option<u64>) -> Result<Value, String> {
    let start = usize::try_from(cursor.unwrap_or(0)).map_err(|_| "用量分页位置无效")?;
    if start > snapshot.usage_records.len() {
        return Err("用量分页位置无效".into());
    }
    let end = start.saturating_add(PAGE).min(snapshot.usage_records.len());
    let mut result = json!({
        "records": &snapshot.usage_records[start..end],
        "contextWindow": snapshot.usage.as_ref().and_then(|u| u.get("size")).cloned().or_else(|| snapshot.context_window.map(Value::from)),
        "usage": snapshot.usage,
        "note": if snapshot.usage_records.is_empty() {
            "暂无适配器上报的详细用量。仅统计启用此功能后经本服务执行的轮次，不回填原生历史；上下文占用按适配器上报显示。"
        } else {
            "按适配器上报统计；未上报的字段不代表完整账单。仅包含启用此功能后经本服务执行的轮次，不回填原生历史；多模型明细优先于主会话汇总。"
        }
    });
    if end < snapshot.usage_records.len() {
        result["cursor"] = json!(end);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot(harness: &str) -> Snapshot {
        Snapshot {
            id: format!("workbench:{harness}:test"),
            harness: Some(harness.into()),
            ..Default::default()
        }
    }
    #[test]
    fn normalized_cache_and_reasoning_are_not_counted_twice() {
        for harness in ["codex", "claude"] {
            let s = snapshot(harness);
            let mut state = ChatState::default();
            let response = json!({"usage":{"inputTokens":100,"outputTokens":20,"cachedReadTokens":50,"cachedWriteTokens":10,"thoughtTokens":8}});
            capture(&s, &mut state, &response, "one", 1);
            capture(&s, &mut state, &response, "one", 2);
            capture(&s, &mut state, &response, "two", 3);
            assert_eq!(state.usage_records.len(), 2);
            let r = &state.usage_records[0];
            assert_eq!(
                (r.input, r.output, r.cache_read, r.cache_write),
                (100, 20, 50, 10)
            );
            assert_eq!(r.model, "unknown");
        }
    }
    #[test]
    fn model_breakdown_replaces_aggregate_and_invalid_rows_fall_back() {
        let s = snapshot("claude");
        let mut state = ChatState::default();
        let mut response = json!({"usage":{"inputTokens":1,"outputTokens":2},"_meta":{"quota":{"model_usage":[
            {"model":"main","token_count":{"inputTokens":100,"outputTokens":20,"cachedInputTokens":5}},
            {"model":"subagent","token_count":{"inputTokens":200,"outputTokens":30,"cachedWriteTokens":10}}
        ]}}});
        capture(&s, &mut state, &response, "one", 1);
        assert_eq!(state.usage_records.len(), 2);
        assert_eq!(
            state.usage_records.iter().map(|r| r.input).sum::<u64>(),
            300
        );
        assert_eq!(state.usage_records[1].model, "subagent");
        response["_meta"]["quota"]["model_usage"][1]["token_count"]["inputTokens"] = json!(-1);
        capture(&s, &mut state, &response, "two", 2);
        assert_eq!(state.usage_records.len(), 3);
        assert_eq!(state.usage_records[2].input, 1);
    }
    #[test]
    fn missing_and_malformed_usage_do_not_become_zero_records() {
        let s = snapshot("codex");
        let mut state = ChatState::default();
        for response in [
            json!({}),
            json!({"usage":null}),
            json!({"usage":{"inputTokens":-1,"outputTokens":1}}),
            json!({"usage":{"inputTokens":1,"outputTokens":1,"cachedReadTokens":1.5}}),
        ] {
            capture(&s, &mut state, &response, "one", 1);
        }
        capture(
            &snapshot("pi"),
            &mut state,
            &json!({"usage":{"inputTokens":1,"outputTokens":2}}),
            "pi",
            1,
        );
        assert!(state.usage_records.is_empty());
    }
    #[test]
    fn pagination_roundtrip_keeps_context_separate_from_billing() {
        let mut s = snapshot("codex");
        let mut state = ChatState::default();
        for i in 0..501 {
            capture(
                &s,
                &mut state,
                &json!({"usage":{"inputTokens":100,"outputTokens":20}}),
                &i.to_string(),
                1,
            );
        }
        s.usage_records = state.usage_records;
        s.usage = Some(json!({"used":50,"size":1000}));
        let s: Snapshot = serde_json::from_value(serde_json::to_value(s).unwrap()).unwrap();
        let first = inspect(&s, None).unwrap();
        assert_eq!(first["records"].as_array().unwrap().len(), 500);
        assert_eq!(first["cursor"], 500);
        assert_eq!(first["usage"]["used"], 50);
        assert_eq!(first["contextWindow"], 1000);
        let last = inspect(&s, Some(500)).unwrap();
        assert_eq!(last["records"].as_array().unwrap().len(), 1);
        assert!(last.get("cursor").is_none());
        assert!(inspect(&s, Some(u64::MAX)).is_err());
    }
}
