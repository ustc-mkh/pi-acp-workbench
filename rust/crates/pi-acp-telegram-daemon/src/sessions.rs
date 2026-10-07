//! TelegramSessions port (src/telegram-sessions.ts): the bridge's view of the
//! session service — list/create/run/cancel/permission/history/status over the
//! shared wire client. Telegram turns are the ONLY callers that subscribe to
//! `state` events for permission prompts.
use pi_acp_core::wire::{WireClient, WireError};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

#[derive(Debug, Clone)]
pub struct SessionStub {
    pub id: String,
    pub cwd: String,
    pub title: String,
    pub session_number: Option<u64>,
}

#[derive(Debug)]
pub enum TurnStatus {
    Completed,
    Cancelled,
    Failed,
}

pub struct RunHandle {
    /// Resolves when the prompt returns; the permission stream then closes.
    pub result: JoinHandle<Result<TurnStatus, WireError>>,
    pub permissions: mpsc::Receiver<Value>,
}

pub struct Sessions {
    client: Arc<WireClient>,
    workspaces: BTreeMap<String, String>,
}

fn stub(value: &Value) -> Option<SessionStub> {
    Some(SessionStub {
        id: value.get("id")?.as_str()?.to_string(),
        cwd: value.get("cwd")?.as_str()?.to_string(),
        title: value.get("title")?.as_str()?.to_string(),
        session_number: value.get("sessionNumber").and_then(Value::as_u64),
    })
}

impl Sessions {
    pub async fn connect(workspaces: BTreeMap<String, String>, socket: &Path) -> Result<Self, WireError> {
        Ok(Sessions { client: Arc::new(WireClient::connect(socket).await?), workspaces })
    }

    pub async fn list(&self) -> Result<Vec<SessionStub>, WireError> {
        let snapshots = self.client.call("list", json!({})).await?;
        Ok(snapshots.as_array().map(|a| a.iter().filter_map(stub).collect()).unwrap_or_default())
    }

    pub async fn create(&self, workspace: Option<&str>) -> Result<SessionStub, WireError> {
        let cwd = workspace
            .filter(|w| w.starts_with('/'))
            .map(str::to_string)
            .or_else(|| {
                let name = match workspace {
                    Some(w) => Some(w.to_string()),
                    None if self.workspaces.len() == 1 => self.workspaces.keys().next().cloned(),
                    None => None,
                };
                name.and_then(|n| self.workspaces.get(&n).cloned())
            });
        let Some(cwd) = cwd else {
            let names = self.workspaces.keys().cloned().collect::<Vec<_>>().join(", ");
            return Err(WireError::Service(format!("请指定绝对目录路径或工作区别名：{names}")));
        };
        let snapshot = self.client.call_timeout("create", json!({ "cwd": cwd }), None).await?;
        stub(&snapshot).ok_or(WireError::Protocol("create snapshot"))
    }

    pub async fn state(&self, id: &str) -> Result<Value, WireError> {
        self.client.call("state", json!({ "sessionId": id })).await
    }

    pub async fn history(&self, id: &str) -> Result<Vec<Value>, WireError> {
        let state = self.state(id).await?;
        Ok(state.pointer("/snapshot/entries").and_then(Value::as_array).cloned().unwrap_or_default())
    }

    /// `{busy, permissions, text, error}` exactly like TelegramSessions.status().
    pub async fn status(&self, id: &str) -> Result<Value, WireError> {
        let state = self.state(id).await?;
        let entries = state.pointer("/snapshot/entries").and_then(Value::as_array).cloned().unwrap_or_default();
        let last_user = entries.iter().rposition(|e| e.get("role").and_then(Value::as_str) == Some("user"));
        let text = entries
            .iter()
            .skip(last_user.map(|i| i + 1).unwrap_or(0))
            .filter(|e| matches!(e.get("role").and_then(Value::as_str), Some("assistant" | "diff")))
            .filter_map(|e| e.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n\n");
        Ok(json!({
            "busy": state.get("busy").and_then(Value::as_bool).unwrap_or(false),
            "permissions": state.get("permissions").cloned().unwrap_or(json!([])),
            "text": text,
            "error": state.get("error").cloned().unwrap_or(Value::Null),
        }))
    }

    /// Watch the session, run the prompt to completion, unwatch. Permissions
    /// arriving on `state` events are forwarded on the returned channel.
    pub fn run(&self, id: &str, text: String) -> RunHandle {
        let (tx, rx) = mpsc::channel::<Value>(32);
        let session = id.to_string();
        let events_inner = self.client.events();
        tokio::spawn(async move {
            let mut events = events_inner;
            while let Ok(event) = events.recv().await {
                if event.get("type").and_then(Value::as_str) != Some("state")
                    || event.pointer("/snapshot/id").and_then(Value::as_str) != Some(session.as_str())
                {
                    continue;
                }
                if let Some(perms) = event.get("permissions").and_then(Value::as_array) {
                    for permission in perms {
                        if tx.send(permission.clone()).await.is_err() {
                            return;
                        }
                    }
                }
            }
        });
        let client = self.client.clone();
        let id = id.to_string();
        let result = tokio::spawn(async move {
            client.watch(&id, true).await?;
            let outcome = client
                .call_timeout(
                    "prompt",
                    json!({ "sessionId": id, "prompt": [{ "type": "text", "text": text }], "source": "telegram" }),
                    None,
                )
                .await;
            let _ = client.watch(&id, false).await;
            match outcome {
                Err(e) => Err(e),
                Ok(result) => Ok(match result.get("stopReason").and_then(Value::as_str) {
                    Some("end_turn") => TurnStatus::Completed,
                    Some("cancelled") => TurnStatus::Cancelled,
                    _ => TurnStatus::Failed,
                }),
            }
        });
        RunHandle { result, permissions: rx }
    }

    pub async fn cancel(&self, id: &str) -> Result<bool, WireError> {
        Ok(self.client.call("cancel", json!({ "sessionId": id })).await?.as_bool().unwrap_or(false))
    }

    pub async fn permission(&self, id: &str, permission_id: &str, option_id: Option<&str>) -> Result<bool, WireError> {
        let option = option_id.map(Value::from).unwrap_or(Value::Null);
        Ok(self
            .client
            .call("permission", json!({ "sessionId": id, "permissionId": permission_id, "optionId": option }))
            .await?
            .as_bool()
            .unwrap_or(false))
    }

    pub async fn dispose(&self) {
        self.client.dispose().await;
    }
}
