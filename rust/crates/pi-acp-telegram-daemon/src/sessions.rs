//! Relay client: the bridge's view of the
//! session service — list/create/run/cancel/permission/history/status over the
//! shared wire client. Telegram turns are the ONLY callers that subscribe to
//! `state` events for permission prompts.
use crate::task_scope::OwnedTask;
use pi_acp_core::wire::{WireClient, WireError};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Debug, Clone)]
pub struct SessionStub {
    pub id: String,
    pub cwd: String,
    pub title: String,
    pub session_number: Option<u64>,
    pub harness: String,
    pub updated: u64,
}

#[derive(Debug)]
pub enum TurnStatus {
    Completed,
    Cancelled,
    Failed,
}

pub struct RunHandle {
    /// Resolves when the prompt returns; the permission stream then closes.
    pub result: OwnedTask<Result<TurnStatus, WireError>>,
    pub permissions: mpsc::Receiver<Value>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventDelivery {
    pub cursor: String,
    pub event: Option<pi_acp_core::turn_event::TurnEvent>,
    pub token: Option<String>,
}

pub struct Sessions {
    client: Arc<WireClient>,
    workspaces: BTreeMap<String, String>,
    restrict_to_workspaces: bool,
}

fn stub(value: &Value) -> Option<SessionStub> {
    Some(SessionStub {
        id: value.get("id")?.as_str()?.to_string(),
        cwd: value.get("cwd")?.as_str()?.to_string(),
        title: value.get("title")?.as_str()?.to_string(),
        session_number: value.get("sessionNumber").and_then(Value::as_u64),
        harness: value
            .get("harness")
            .and_then(Value::as_str)
            .unwrap_or("pi")
            .into(),
        updated: value.get("updated").and_then(Value::as_u64).unwrap_or(0),
    })
}

/// Exact canonical roots only: subdirectories and symlink escapes are excluded.
async fn allowed_workspace(workspaces: &BTreeMap<String, String>, cwd: &str) -> Option<String> {
    let canonical = tokio::fs::canonicalize(cwd).await.ok()?;
    for path in workspaces.values() {
        if tokio::fs::canonicalize(path).await.ok().as_ref() == Some(&canonical) {
            return Some(canonical.to_string_lossy().into_owned());
        }
    }
    None
}

impl Sessions {
    pub async fn connect(
        workspaces: BTreeMap<String, String>,
        socket: &Path,
        restrict_to_workspaces: bool,
    ) -> Result<Self, WireError> {
        Ok(Sessions {
            client: Arc::new(WireClient::connect(socket).await?),
            workspaces,
            restrict_to_workspaces,
        })
    }

    pub async fn list(&self) -> Result<Vec<SessionStub>, WireError> {
        let snapshots = self.client.call("list", json!({})).await?;
        let mut sessions = Vec::new();
        if let Some(snapshots) = snapshots.as_array() {
            for session in snapshots.iter().filter_map(stub) {
                if !self.restrict_to_workspaces
                    || allowed_workspace(&self.workspaces, &session.cwd)
                        .await
                        .is_some()
                {
                    sessions.push(session);
                }
            }
        }
        sessions.sort_by(|a, b| {
            b.updated
                .cmp(&a.updated)
                .then_with(|| b.session_number.cmp(&a.session_number))
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(sessions)
    }

    pub(crate) async fn authorize(&self, id: &str) -> Result<(), WireError> {
        if self.restrict_to_workspaces && !self.list().await?.iter().any(|s| s.id == id) {
            return Err(WireError::Service("会话不在允许的 workspaces 中。".into()));
        }
        Ok(())
    }

    pub async fn next_event(
        &self,
        cursor: Option<&str>,
    ) -> Result<Option<EventDelivery>, WireError> {
        let params = cursor
            .map(|c| json!({ "cursor": c }))
            .unwrap_or_else(|| json!({}));
        let value = self.client.call("events.next", params).await?;
        serde_json::from_value(value).map_err(|_| WireError::Protocol("events.next response"))
    }
    pub async fn ack_event(&self, id: &str, token: &str) -> Result<bool, WireError> {
        let value = self
            .client
            .call("events.ack", json!({ "id": id, "token": token }))
            .await?;
        serde_json::from_value(value).map_err(|_| WireError::Protocol("events.ack response"))
    }
    pub async fn create(&self, workspace: Option<&str>) -> Result<SessionStub, WireError> {
        self.create_with_harness(workspace, "pi").await
    }

    pub async fn resolve_workspace(&self, workspace: Option<&str>) -> Result<String, WireError> {
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
            let names = self
                .workspaces
                .keys()
                .cloned()
                .collect::<Vec<_>>()
                .join(", ");
            return Err(WireError::Service(format!(
                "请指定绝对目录路径或工作区别名：{names}"
            )));
        };
        let cwd = if self.restrict_to_workspaces {
            allowed_workspace(&self.workspaces, &cwd)
                .await
                .ok_or_else(|| WireError::Service("目录不在允许的 workspaces 中。".into()))?
        } else {
            cwd
        };
        let canonical = tokio::fs::canonicalize(&cwd)
            .await
            .map_err(|_| WireError::Service("工作区不是可访问的目录。".into()))?;
        if !canonical.is_dir() {
            return Err(WireError::Service("工作区不是目录。".into()));
        }
        Ok(canonical.to_string_lossy().into_owned())
    }

    pub async fn workspace_choices(&self) -> Result<Vec<(String, String)>, WireError> {
        let mut choices = Vec::new();
        for (name, path) in &self.workspaces {
            if let Ok(cwd) = self.resolve_workspace(Some(path)).await {
                choices.push((name.clone(), cwd));
            }
        }
        for session in self.list().await? {
            if choices.iter().any(|(_, cwd)| cwd == &session.cwd) {
                continue;
            }
            if let Ok(cwd) = self.resolve_workspace(Some(&session.cwd)).await {
                choices.push((cwd.clone(), cwd));
            }
            if choices.len() >= 12 {
                break;
            }
        }
        choices.truncate(12);
        Ok(choices)
    }

    pub async fn create_with_harness(
        &self,
        workspace: Option<&str>,
        harness: &str,
    ) -> Result<SessionStub, WireError> {
        if !matches!(harness, "pi" | "codex" | "claude") {
            return Err(WireError::Service("未知 Harness。".into()));
        }
        let cwd = self.resolve_workspace(workspace).await?;
        let snapshot = self
            .client
            .call_timeout("create", json!({ "cwd": cwd, "harness": harness }), None)
            .await?;
        stub(&snapshot).ok_or(WireError::Protocol("create snapshot"))
    }

    pub async fn set_config(
        &self,
        id: &str,
        config_id: &str,
        value: &str,
    ) -> Result<(), WireError> {
        self.authorize(id).await?;
        self.client.call_timeout("request", json!({"sessionId":id,
            "method":"session/set_config_option","params":{"configId":config_id,"value":value}
        }), None).await?;
        Ok(())
    }

    pub async fn state(&self, id: &str) -> Result<Value, WireError> {
        self.authorize(id).await?;
        self.client.call("state", json!({ "sessionId": id })).await
    }

    pub async fn history(&self, id: &str) -> Result<Vec<Value>, WireError> {
        let state = self.state(id).await?;
        Ok(state
            .pointer("/snapshot/entries")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    /// `{busy, permissions, text, error}` exactly like TelegramSessions.status().
    pub async fn status(&self, id: &str) -> Result<Value, WireError> {
        let state = self.state(id).await?;
        let entries = state
            .pointer("/snapshot/entries")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let last_user = entries
            .iter()
            .rposition(|e| e.get("role").and_then(Value::as_str) == Some("user"));
        let text = entries
            .iter()
            .skip(last_user.map(|i| i + 1).unwrap_or(0))
            .filter(|e| {
                matches!(
                    e.get("role").and_then(Value::as_str),
                    Some("assistant" | "diff")
                )
            })
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
        let forwarding = OwnedTask::spawn(async move {
            let mut events = events_inner;
            loop {
                let event = tokio::select! {
                    _ = tx.closed() => return,
                    event = events.recv() => match event {
                        Ok(event) => event,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                    },
                };
                if event.get("type").and_then(Value::as_str) != Some("state")
                    || event.pointer("/snapshot/id").and_then(Value::as_str)
                        != Some(session.as_str())
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
        let workspaces = self.workspaces.clone();
        let restricted = self.restrict_to_workspaces;
        let id = id.to_string();
        let result = OwnedTask::spawn(async move {
            let _forwarding = forwarding;
            let host = Sessions {
                client: client.clone(),
                workspaces,
                restrict_to_workspaces: restricted,
            };
            host.authorize(&id).await?;
            client
                .call(
                    "_watch",
                    json!({"sessionId":id,"enabled":true,"permissionsOnly":true}),
                )
                .await?;
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
        RunHandle {
            result,
            permissions: rx,
        }
    }

    pub async fn cancel(&self, id: &str) -> Result<bool, WireError> {
        self.authorize(id).await?;
        Ok(self
            .client
            .call("cancel", json!({ "sessionId": id }))
            .await?
            .as_bool()
            .unwrap_or(false))
    }

    pub async fn permission(
        &self,
        id: &str,
        permission_id: &str,
        option_id: Option<&str>,
    ) -> Result<bool, WireError> {
        self.authorize(id).await?;
        let option = option_id.map(Value::from).unwrap_or(Value::Null);
        Ok(self
            .client
            .call(
                "permission",
                json!({ "sessionId": id, "permissionId": permission_id, "optionId": option }),
            )
            .await?
            .as_bool()
            .unwrap_or(false))
    }

    pub async fn dispose(&self) {
        self.client.dispose().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    #[tokio::test]
    async fn restriction_filters_sessions_and_rejects_existing_topic_operations() {
        let root = std::env::temp_dir().join(format!("pi-workspace-{}", uuid::Uuid::new_v4()));
        let allowed = root.join("allowed");
        let outside = root.join("outside");
        std::fs::create_dir_all(allowed.join("child")).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&allowed, root.join("alias")).unwrap();
        std::os::unix::fs::symlink(&outside, allowed.join("escape")).unwrap();
        let workspaces = BTreeMap::from([("work".into(), allowed.to_string_lossy().into_owned())]);
        assert!(
            allowed_workspace(&workspaces, root.join("alias").to_str().unwrap())
                .await
                .is_some()
        );
        for path in [
            allowed.join("child"),
            allowed.join("escape"),
            root.join("missing"),
        ] {
            assert!(allowed_workspace(&workspaces, path.to_str().unwrap())
                .await
                .is_none());
        }
        let socket = root.join("s");
        let listener = UnixListener::bind(&socket).unwrap();
        let snapshots = json!([
            {"id":"allowed","cwd":allowed,"title":"Allowed","sessionNumber":1},
            {"id":"outside","cwd":outside,"title":"Secret","sessionNumber":2},
            {"id":"child","cwd":allowed.join("child"),"title":"Child","sessionNumber":3},
            {"id":"missing","cwd":root.join("missing"),"title":"Missing","sessionNumber":4}
        ]);
        let server = tokio::spawn(async move {
            let (peer, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = peer.into_split();
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let request: Value = serde_json::from_str(&line).unwrap();
                // Forbidden operations must never reach the session service.
                assert_eq!(request["method"], "list");
                writer
                    .write_all(
                        format!("{}\n", json!({"id":request["id"],"value":snapshots})).as_bytes(),
                    )
                    .await
                    .unwrap();
            }
        });
        let host = Sessions::connect(workspaces.clone(), &socket, true)
            .await
            .unwrap();
        let sessions = host.list().await.unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "allowed");
        assert!(host.create(outside.to_str()).await.is_err());
        assert!(host.state("outside").await.is_err());
        assert!(host.cancel("outside").await.is_err());
        assert!(host.permission("outside", "p", Some("yes")).await.is_err());
        assert!(host
            .run("outside", "prompt".into())
            .result
            .await
            .unwrap()
            .is_err());
        host.dispose().await;
        server.await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    #[tokio::test]
    async fn completed_turn_closes_permission_sender() {
        let dir = std::env::temp_dir().join(format!("pi-proof-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let socket = dir.join("s");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let (peer, _) = listener.accept().await.unwrap();
            let (read, mut write) = peer.into_split();
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let req: Value = serde_json::from_str(&line).unwrap();
                let value = if req["method"] == "prompt" {
                    json!({"stopReason":"end_turn"})
                } else {
                    json!(true)
                };
                write
                    .write_all(format!("{}\n", json!({"id":req["id"],"value":value})).as_bytes())
                    .await
                    .unwrap();
            }
        });
        let host = Sessions::connect(BTreeMap::new(), &socket, false)
            .await
            .unwrap();
        let run = host.run("test", "hello".into());
        let mut permissions = run.permissions;
        assert!(matches!(
            run.result.await.unwrap().unwrap(),
            TurnStatus::Completed
        ));
        // Completing a turn releases the broadcast subscriber even without another event.
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), permissions.recv())
                .await
                .unwrap()
                .is_none()
        );
        host.dispose().await;
        server.await.unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
