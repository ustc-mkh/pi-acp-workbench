//! Typed service request boundary. serde validates shape; bounded strings and
//! prompt sizes are checked before queueing or touching session state.
use crate::error::ServiceError;
use crate::types::Snapshot;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ts_rs::TS;

fn bounded_text<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.is_empty() || value.encode_utf16().count() > 10000 {
        return Err(serde::de::Error::custom("empty or oversized string"));
    }
    Ok(value)
}
macro_rules! text_fields {
    ($($name:ident => $field:literal),*) => { $(fn $name<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
        bounded_text(d).map_err(|e| serde::de::Error::custom(format!("{}: {}", $field, e)))
    })* };
}
text_fields!(cwd_text => "cwd", session_text => "sessionId", permission_text => "permissionId", option_text => "optionId", mode_text => "modeId", config_text => "configId", value_text => "value", entry_text => "entryId", hash_text => "hash");
fn optional_session<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    session_text(d).map(Some)
}
fn optional_option<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    option_text(d).map(Some)
}
fn prompt_source<'de, D: serde::Deserializer<'de>>(d: D) -> Result<PromptSource, D::Error> {
    PromptSource::deserialize(d).map_err(|e| serde::de::Error::custom(format!("source: {e}")))
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(tag = "method", content = "params")]
pub enum AgentRequest {
    #[serde(rename = "_pi_workbench/inspect")]
    Inspect {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        cursor: Option<u64>,
        #[serde(default)]
        #[ts(as = "Option<bool>", optional)]
        force: bool,
    },
    #[serde(rename = "_pi_workbench/fork", rename_all = "camelCase")]
    Fork {
        #[serde(deserialize_with = "entry_text")]
        entry_id: String,
        #[serde(deserialize_with = "hash_text")]
        hash: String,
    },
    #[serde(rename = "_pi_workbench/cancel_fork")]
    CancelFork {},
    #[serde(rename = "session/set_mode", rename_all = "camelCase")]
    SetMode {
        #[serde(deserialize_with = "mode_text")]
        mode_id: String,
    },
    #[serde(rename = "session/set_config_option", rename_all = "camelCase")]
    SetConfig {
        #[serde(deserialize_with = "config_text")]
        config_id: String,
        #[serde(deserialize_with = "value_text")]
        value: String,
    },
}
impl AgentRequest {
    pub fn method(&self) -> &'static str {
        match self {
            Self::Inspect { .. } => "_pi_workbench/inspect",
            Self::Fork { .. } => "_pi_workbench/fork",
            Self::CancelFork {} => "_pi_workbench/cancel_fork",
            Self::SetMode { .. } => "session/set_mode",
            Self::SetConfig { .. } => "session/set_config_option",
        }
    }
    pub fn params(&self) -> Value {
        serde_json::to_value(self).unwrap()["params"].clone()
    }
}
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(
    tag = "method",
    content = "params",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ServiceCommand {
    Hello,
    List,
    Create {
        #[serde(deserialize_with = "cwd_text")]
        cwd: String,
    },
    State {
        #[serde(deserialize_with = "session_text")]
        session_id: String,
    },
    Cancel {
        #[serde(deserialize_with = "session_text")]
        session_id: String,
    },
    Remove {
        #[serde(deserialize_with = "session_text")]
        session_id: String,
    },
    Permission {
        #[serde(deserialize_with = "session_text")]
        session_id: String,
        #[serde(deserialize_with = "permission_text")]
        permission_id: String,
        #[serde(default, deserialize_with = "optional_option")]
        #[ts(optional)]
        option_id: Option<String>,
    },
    Prompt {
        #[serde(deserialize_with = "session_text")]
        session_id: String,
        #[ts(type = "acp.ContentBlock[]")]
        prompt: Vec<Value>,
        #[serde(default, deserialize_with = "prompt_source")]
        #[ts(as = "Option<PromptSource>", optional)]
        source: PromptSource,
    },
    Request {
        #[serde(deserialize_with = "session_text")]
        session_id: String,
        #[serde(flatten)]
        request: AgentRequest,
    },
    HistoryWrite {
        #[ts(type = "Snapshot")]
        snapshot: Box<Snapshot>,
    },
    HistoryRemove {
        #[serde(default, deserialize_with = "optional_session")]
        #[ts(optional)]
        session_id: Option<String>,
    },
}
#[derive(Debug, Clone, Copy, Default, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum PromptSource {
    #[default]
    Desktop,
    Telegram,
}
impl PromptSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Telegram => "telegram",
        }
    }
}
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ServiceState {
    #[ts(type = "Snapshot")]
    pub snapshot: Snapshot,
    pub busy: bool,
    #[ts(type = "ChatState['permissions']")]
    pub permissions: Vec<Value>,
    #[ts(type = "ChatState['commands']")]
    pub commands: Vec<Value>,
    #[ts(type = "ChatState['plan']")]
    pub plan: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

pub fn service_command(method: &str, params: &Value) -> Result<ServiceCommand, ServiceError> {
    if !params.is_object() {
        return Err(ServiceError::InvalidParams("服务参数必须是对象".into()));
    }
    if method == "hello" {
        return Ok(ServiceCommand::Hello);
    }
    if method == "list" {
        return Ok(ServiceCommand::List);
    }
    if ![
        "create",
        "state",
        "cancel",
        "remove",
        "permission",
        "prompt",
        "request",
        "historyWrite",
        "historyRemove",
    ]
    .contains(&method)
    {
        return Err(ServiceError::UnknownMethod);
    }
    // Absent ACP params are an empty object, whereas explicit null is invalid.
    let mut params = params.clone();
    if method == "request" && params.get("params").is_none() {
        params["params"] = json!({});
    }
    let command: ServiceCommand = serde_json::from_value(json!({"method":method,"params":params}))
        .map_err(|e| {
            let detail = e.to_string();
            let known_fields = [
                "cwd",
                "sessionId",
                "permissionId",
                "optionId",
                "modeId",
                "configId",
                "value",
                "entryId",
                "hash",
            ];
            let message = if method == "prompt" && detail.contains("source") {
                "消息来源无效".to_string()
            } else if method == "prompt" && detail.contains("prompt") {
                "消息格式无效".to_string()
            } else if method == "request"
                && ![
                    "_pi_workbench/inspect",
                    "_pi_workbench/fork",
                    "_pi_workbench/cancel_fork",
                    "session/set_mode",
                    "session/set_config_option",
                ]
                .contains(&params["method"].as_str().unwrap_or(""))
            {
                "不支持的 ACP 操作".to_string()
            } else if method == "request" && !params["params"].is_object() {
                "ACP 参数必须是对象".to_string()
            } else {
                format!(
                    "无效参数：{}",
                    known_fields
                        .iter()
                        .find(|field| detail.contains(**field))
                        .copied()
                        .unwrap_or(if method == "historyWrite" {
                            "snapshot"
                        } else {
                            "request"
                        })
                )
            };
            ServiceError::InvalidParams(message)
        })?;
    match &command {
        ServiceCommand::Prompt { prompt, .. } => {
            if prompt.is_empty()
                || !prompt
                    .iter()
                    .all(|b| b.is_object() && b["type"].is_string())
            {
                return Err(ServiceError::InvalidParams("消息格式无效".into()));
            }
            if serde_json::to_vec(prompt).map_or(usize::MAX, |bytes| bytes.len()) > 12 * 1024 * 1024
            {
                return Err(ServiceError::InvalidParams(
                    "消息和附件超过 12 MiB，未发送。请减少输入内容。".into(),
                ));
            }
        }
        ServiceCommand::HistoryWrite { snapshot }
            if snapshot.id.is_empty()
                || snapshot.cwd.is_empty()
                || snapshot.context_complete != Some(true) =>
        {
            return Err(ServiceError::InvalidParams("无效参数：snapshot".into()))
        }
        _ => {}
    }
    Ok(command)
}
pub fn durable_command(command: &ServiceCommand) -> bool {
    matches!(
        command,
        ServiceCommand::Create { .. }
            | ServiceCommand::Prompt { .. }
            | ServiceCommand::Request {
                request: AgentRequest::Fork { .. }
                    | AgentRequest::SetMode { .. }
                    | AgentRequest::SetConfig { .. },
                ..
            }
    )
}
pub fn typescript() -> String {
    let declarations = [
        AgentRequest::decl(),
        PromptSource::decl(),
        ServiceCommand::decl(),
        ServiceState::decl(),
        crate::error::ErrorCode::decl(),
    ]
    .into_iter()
    .map(|decl| format!("export {decl}\n"))
    .collect::<String>();
    format!("// Generated by pi-acp-session-daemon --print-types. Do not edit.\nimport type * as acp from '@agentclientprotocol/sdk';\nimport type {{ ChatState, Snapshot }} from './shared';\n\n{declarations}")
}
