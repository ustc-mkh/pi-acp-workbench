//! serviceCommand + durableCommand port (src/session-protocol.ts) — the single
//! validation boundary. Error messages must match byte-for-byte.
use serde_json::Value;

pub const AGENT_METHODS: &[&str] = &[
    "_pi_workbench/inspect",
    "_pi_workbench/fork",
    "_pi_workbench/cancel_fork",
    "session/set_mode",
    "session/set_config_option",
];

#[derive(Debug, Clone)]
pub enum ServiceCommand {
    Hello,
    List,
    Create { cwd: String },
    State { session_id: String },
    Cancel { session_id: String },
    Remove { session_id: String },
    Permission { session_id: String, permission_id: String, option_id: Option<String> },
    Prompt { session_id: String, prompt: Vec<Value>, source: String },
    Request { session_id: String, method: String, params: Value },
    HistoryWrite { id: String, snapshot: Value },
    HistoryRemove { session_id: Option<String> },
}

fn text(value: Option<&Value>, name: &str) -> Result<String, String> {
    match value.and_then(Value::as_str) {
        // JS String.length counts UTF-16 code units — CJK/supplementary chars
        // weigh differently than byte length (frozen wire boundary).
        Some(s) if !s.is_empty() && s.encode_utf16().count() <= 10000 => Ok(s.to_string()),
        _ => Err(format!("无效参数：{name}")),
    }
}

/// checkPromptSize: JSON.stringify(prompt) must stay under 12 MiB.
fn check_prompt_size(prompt: &[Value]) -> Result<(), String> {
    let bytes = serde_json::to_vec(prompt).map(|v| v.len()).unwrap_or(usize::MAX);
    if bytes > 12 * 1024 * 1024 {
        return Err("消息和附件超过 12 MiB，未发送。请减少输入内容。".into());
    }
    Ok(())
}

pub fn service_command(method: &str, params: &Value) -> Result<ServiceCommand, String> {
    let obj = params.as_object().ok_or("服务参数必须是对象")?;
    let get = |key: &str| obj.get(key);
    if method == "hello" {
        return Ok(ServiceCommand::Hello);
    }
    if method == "list" {
        return Ok(ServiceCommand::List);
    }
    if method == "create" {
        return Ok(ServiceCommand::Create { cwd: text(get("cwd"), "cwd")? });
    }
    if method == "historyWrite" {
        let snapshot = get("snapshot").cloned().unwrap_or(Value::Null);
        let id = snapshot.get("id").and_then(Value::as_str).unwrap_or("");
        if !snapshot.is_object() || id.is_empty() {
            return Err("无效参数：snapshot".into());
        }
        return Ok(ServiceCommand::HistoryWrite { id: id.to_string(), snapshot });
    }
    if method == "historyRemove" {
        // sessionId optional: absent = clear all; explicit null is invalid
        // (TS `=== undefined` convention).
        return Ok(ServiceCommand::HistoryRemove {
            session_id: match get("sessionId") {
                None => None,
                v => Some(text(v, "sessionId")?),
            },
        });
    }
    let session_id = text(get("sessionId"), "sessionId")?;
    match method {
        "state" => Ok(ServiceCommand::State { session_id }),
        "cancel" => Ok(ServiceCommand::Cancel { session_id }),
        "remove" => Ok(ServiceCommand::Remove { session_id }),
        "permission" => Ok(ServiceCommand::Permission {
            session_id,
            permission_id: text(get("permissionId"), "permissionId")?,
            // TS: `=== undefined` only — explicit null hits text() → 无效参数.
            option_id: match get("optionId") {
                None => None,
                v => Some(text(v, "optionId")?),
            },
        }),
        "prompt" => {
            let prompt = get("prompt").and_then(Value::as_array).filter(|a| {
                !a.is_empty() && a.iter().all(|b| b.is_object() && b.get("type").and_then(Value::as_str).is_some())
            });
            let Some(prompt) = prompt else { return Err("消息格式无效".into()) };
            check_prompt_size(prompt)?;
            let source = match get("source") {
                None => "desktop".to_string(),
                Some(v) => match v.as_str() {
                    Some(s @ ("desktop" | "telegram")) => s.to_string(),
                    _ => return Err("消息来源无效".into()),
                },
            };
            Ok(ServiceCommand::Prompt { session_id, prompt: prompt.clone(), source })
        }
        "request" => {
            let agent_method = get("method").and_then(Value::as_str).filter(|m| AGENT_METHODS.contains(m));
            let Some(agent_method) = agent_method else { return Err("不支持的 ACP 操作".into()) };
            let args = match get("params") {
                None => Value::Object(Default::default()),
                Some(v) if v.is_object() => v.clone(),
                _ => return Err("ACP 参数必须是对象".into()),
            };
            match agent_method {
                "session/set_mode" => {
                    text(args.get("modeId"), "modeId")?;
                }
                "session/set_config_option" => {
                    text(args.get("configId"), "configId")?;
                    text(args.get("value"), "value")?;
                }
                "_pi_workbench/fork" => {
                    text(args.get("entryId"), "entryId")?;
                    text(args.get("hash"), "hash")?;
                }
                _ => {}
            }
            Ok(ServiceCommand::Request { session_id, method: agent_method.to_string(), params: args })
        }
        _ => Err("未知服务操作".into()),
    }
}

pub fn durable_command(command: &ServiceCommand) -> bool {
    match command {
        ServiceCommand::Create { .. } | ServiceCommand::Prompt { .. } => true,
        ServiceCommand::Request { method, .. } => {
            matches!(method.as_str(), "_pi_workbench/fork" | "session/set_mode" | "session/set_config_option")
        }
        _ => false,
    }
}
