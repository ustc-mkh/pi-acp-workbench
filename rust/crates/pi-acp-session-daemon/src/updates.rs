//! initialState / appendText / applyUpdate port (src/state.ts). Operates on the
//! daemon's mutable ChatState; semantics must match the TS switch exactly.
use crate::types::{ChatState, Entry};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static SERIAL: AtomicU64 = AtomicU64::new(0);

/// `entry-${Date.now()}-${++serial}` — same shape as the TS generator.
pub fn next_id() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("entry-{ms}-{}", SERIAL.fetch_add(1, Ordering::SeqCst) + 1)
}

pub fn initial_state() -> ChatState {
    ChatState::default()
}

/// JS falsy for messageId: null/""/0/false mean "no id" (mergeable with a
/// messageId-less last entry), same as TS `!messageId`.
fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// Merge text into the last entry of the same role (except notices), honoring messageId.
pub fn append_text(state: &mut ChatState, role: &str, text: &str, message_id: Option<&Value>) {
    let mergeable = state.entries.last().is_some_and(|last| {
        last.role == role
            && role != "notice"
            // TS: `!messageId || last.messageId===messageId` — a falsy messageId
            // (null/""/0/false) merges into ANY last entry; a truthy one must
            // equal the last entry's id exactly.
            && (message_id.map(|m| !js_truthy(m)).unwrap_or(true) || &last.message_id == &message_id.cloned())
    });
    if mergeable {
        let last = state.entries.last_mut().unwrap();
        let mut text_owned = last.text.take().unwrap_or_default();
        text_owned.push_str(text);
        last.text = Some(text_owned);
    } else {
        state.entries.push(Entry {
            id: next_id(),
            role: role.to_string(),
            text: Some(text.to_string()),
            message_id: message_id.cloned(),
            context_blocks: None,
            tool: None,
            diff: None,
        });
    }
}

/// applyUpdate(state, update, replay): `replay` = session/load reconstruction.
pub fn apply_update(state: &mut ChatState, update: &Value, replay: bool) {
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match kind {
        "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk" => {
            if kind == "user_message_chunk" && !replay {
                return;
            }
            let role = if kind == "user_message_chunk" {
                "user"
            } else if kind == "agent_thought_chunk" {
                "thought"
            } else {
                "assistant"
            };
            let content = update.get("content").cloned().unwrap_or(Value::Null);
            let ctype = content
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let text = match ctype {
                "text" => content
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                "resource_link" => format!(
                    "[{}]({})",
                    content
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    content
                        .get("uri")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                ),
                "resource" => content
                    .pointer("/resource/text")
                    .and_then(Value::as_str)
                    .unwrap_or("[二进制资源]")
                    .to_string(),
                other => format!("[{other} 内容]"),
            };
            append_text(state, role, &text, update.get("messageId"));
            if ctype != "text" {
                if let Some(entry) = state.entries.last_mut() {
                    if matches!(entry.role.as_str(), "user" | "assistant" | "thought") {
                        entry
                            .context_blocks
                            .get_or_insert_with(Vec::new)
                            .push(content);
                    }
                }
            }
        }
        "tool_call" | "tool_call_update" => {
            let tool_call_id = update
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let index = state.entries.iter().position(|e| {
                e.role == "tool"
                    && e.tool
                        .as_ref()
                        .and_then(|t| t.get("toolCallId"))
                        .and_then(Value::as_str)
                        == Some(tool_call_id.as_str())
            });
            let mut fields = update.clone();
            if let Value::Object(map) = &mut fields {
                map.retain(|_, v| !v.is_null());
            }
            match index {
                Some(i) => {
                    let entry = &mut state.entries[i];
                    if let (Some(Value::Object(old)), Value::Object(new)) =
                        (entry.tool.take(), fields)
                    {
                        let mut merged = old;
                        for (k, v) in new {
                            merged.insert(k, v);
                        }
                        entry.tool = Some(Value::Object(merged));
                    }
                }
                None => {
                    let mut tool = serde_json::json!({ "title": "工具调用", "status": "pending" });
                    if let (Value::Object(base), Value::Object(extra)) = (&mut tool, fields) {
                        for (k, v) in extra {
                            base.insert(k, v);
                        }
                    }
                    tool["toolCallId"] = Value::String(tool_call_id);
                    state.entries.push(Entry {
                        id: next_id(),
                        role: "tool".to_string(),
                        text: None,
                        message_id: None,
                        context_blocks: None,
                        tool: Some(tool),
                        diff: None,
                    });
                }
            }
        }
        "plan" => {
            state.plan = update
                .get("entries")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        }
        "available_commands_update" => {
            state.commands = update
                .get("availableCommands")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        }
        "current_mode_update" => {
            // TS writes `currentModeId: update.currentModeId` — undefined is
            // dropped on stringify, so absence must not emit `null`.
            if let (Some(Value::Object(modes)), Some(mode)) =
                (&mut state.modes, update.get("currentModeId"))
            {
                modes.insert("currentModeId".into(), mode.clone());
            }
        }
        "config_option_update" => {
            state.configs = update
                .get("configOptions")
                .and_then(Value::as_array)
                .cloned()
        }
        "usage_update" => {
            // TS {used,size} with undefined keys dropped — same omit rule.
            let mut usage = serde_json::Map::new();
            if let Some(v) = update.get("used") {
                usage.insert("used".into(), v.clone());
            }
            if let Some(v) = update.get("size") {
                usage.insert("size".into(), v.clone());
            }
            state.usage = Some(Value::Object(usage));
        }
        _ => {}
    }
}
