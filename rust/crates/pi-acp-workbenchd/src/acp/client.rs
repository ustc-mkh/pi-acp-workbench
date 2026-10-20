//! Typed request API. JSON conversion is confined to this ACP boundary.
use super::*;
use crate::{domain::error::DomainError, worker::WorkerHandle};
use serde::{de::DeserializeOwned, Serialize};
use std::sync::atomic::{AtomicI64, Ordering};

pub struct AcpClient {
    worker: WorkerHandle,
    next_id: AtomicI64,
}
impl AcpClient {
    pub fn new(worker: WorkerHandle) -> Self {
        Self {
            worker,
            next_id: AtomicI64::new(1),
        }
    }
    pub fn epoch(&self) -> u64 {
        self.worker.epoch
    }
    async fn call<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &str,
        params: P,
    ) -> Result<R, DomainError> {
        let id = RequestId::Number(self.next_id.fetch_add(1, Ordering::Relaxed));
        let request = JsonRpcRequest::new(id, method, params)
            .map_err(|e| DomainError::Protocol(e.to_string()))?;
        let response = self.worker.request(request).await?;
        if let Some(error) = response.error {
            // Provider descriptions may contain upstream URLs/credentials. Only
            // our typed method name and remote code cross into domain/UI errors.
            return Err(DomainError::Protocol(format!(
                "ACP {method} rejected (code {})",
                error.code
            )));
        }
        let result = response
            .result
            .ok_or_else(|| DomainError::Protocol("missing result".into()))?;
        serde_json::from_value(result).map_err(|e| DomainError::Protocol(e.to_string()))
    }
    pub async fn initialize(&self) -> Result<InitializeResponse, DomainError> {
        let response: InitializeResponse = self
            .call(
                "initialize",
                InitializeRequest {
                    protocol_version: 1,
                    client_info: ClientInfo {
                        name: "pi-acp-workbenchd".into(),
                        version: env!("CARGO_PKG_VERSION").into(),
                    },
                    client_capabilities: ClientCapabilities::default(),
                },
            )
            .await?;
        if response.protocol_version != 1 {
            return Err(DomainError::Protocol("unsupported ACP version".into()));
        }
        Ok(response)
    }
    pub async fn new_session(
        &self,
        cwd: &crate::domain::WorkspacePath,
    ) -> Result<NewSessionResponse, DomainError> {
        self.call(
            "session/new",
            NewSessionRequest {
                cwd: cwd.as_str().into(),
                mcp_servers: vec![],
            },
        )
        .await
    }
    pub async fn load_session(
        &self,
        cwd: &crate::domain::WorkspacePath,
        session_id: NativeSessionId,
    ) -> Result<LoadSessionResponse, DomainError> {
        self.call(
            "session/load",
            LoadSessionRequest {
                cwd: cwd.as_str().into(),
                session_id,
                mcp_servers: vec![],
            },
        )
        .await
    }
    pub async fn fork_points(
        &self,
        native: &NativeSessionId,
        metadata: &extensions::ProviderMetadata,
    ) -> Result<Vec<crate::domain::fork::ForkCandidate>, DomainError> {
        if !metadata.supports_inspection() {
            return Err(DomainError::UnsupportedFeature(
                "provider does not negotiate native inspection version 1".into(),
            ));
        }
        let response: extensions::InspectResponse = self
            .call(
                "_pi_workbench/inspect",
                extensions::InspectRequest {
                    session_id: native.clone(),
                    cursor: 0,
                },
            )
            .await?;
        response.candidates()
    }
    pub async fn fork_native(
        &self,
        native: &NativeSessionId,
        target: &crate::domain::fork::ForkTarget,
        metadata: &extensions::ProviderMetadata,
    ) -> Result<crate::domain::ProviderSessionId, DomainError> {
        if !metadata.supports_native_fork() {
            return Err(DomainError::UnsupportedFeature(
                "provider does not negotiate native fork version 1".into(),
            ));
        }
        let response: extensions::ForkResponse = self
            .call(
                "_pi_workbench/fork",
                extensions::ForkRequest {
                    session_id: native.clone(),
                    entry_id: target.entry.clone(),
                    hash: target.prefix.clone(),
                },
            )
            .await
            .map_err(|_| DomainError::NativeForkUncertain)?;
        response
            .independent(native)
            .map_err(|_| DomainError::NativeForkUncertain)
    }
    pub async fn cancel_native_fork(
        &self,
        native: &NativeSessionId,
        metadata: &extensions::ProviderMetadata,
    ) -> Result<(), DomainError> {
        if !metadata.supports_native_fork() {
            return Err(DomainError::UnsupportedFeature(
                "provider does not negotiate native fork version 1".into(),
            ));
        }
        let _: settings::EmptyResponse = self
            .call(
                "_pi_workbench/cancel_fork",
                CancelRequest {
                    session_id: native.clone(),
                },
            )
            .await?;
        Ok(())
    }
    pub async fn models(
        &self,
        native: &NativeSessionId,
        metadata: &extensions::ProviderMetadata,
        action: &crate::domain::management::ManagementAction,
    ) -> Result<crate::domain::management::ProviderModels, DomainError> {
        if !metadata.supports_models() {
            return Err(DomainError::UnsupportedFeature("provider does not negotiate model configuration; its ACP catalogue remains available".into()));
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Params<'a> {
            session_id: &'a NativeSessionId,
            model: Option<&'a str>,
            context_window: Option<u64>,
            set_context: bool,
        }
        let (model, context_window, set_context) = match action {
            crate::domain::management::ManagementAction::Context {
                model,
                context_window,
            } => (Some(model.as_str()), *context_window, true),
            _ => (None, None, false),
        };
        self.call(
            "_pi_workbench/models",
            Params {
                session_id: native,
                model,
                context_window,
                set_context,
            },
        )
        .await
    }
    pub async fn title(
        &self,
        native: &NativeSessionId,
        model: &str,
        text: &str,
    ) -> Result<crate::domain::management::TitleResponse, DomainError> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Params<'a> {
            session_id: &'a NativeSessionId,
            model: &'a str,
            text: &'a str,
        }
        self.call(
            "_pi_workbench/title",
            Params {
                session_id: native,
                model,
                text,
            },
        )
        .await
    }
    pub async fn configure(
        &self,
        native: &NativeSessionId,
        details: &mut settings::SessionDetails,
        config: &crate::domain::session::SessionConfig,
    ) -> Result<(), DomainError> {
        if let Some(model) = &config.model {
            if let Some((id, current, options)) = details.select("model") {
                if !options
                    .values()
                    .iter()
                    .any(|option| option.value == model.as_str())
                {
                    return Err(DomainError::Protocol(
                        "model is not offered by provider".into(),
                    ));
                }
                if current != model.as_str() {
                    let response: settings::SetConfigResponse = self
                        .call(
                            "session/set_config_option",
                            settings::SetConfigRequest {
                                session_id: native.clone(),
                                config_id: id.into(),
                                value: model.as_str().into(),
                            },
                        )
                        .await?;
                    details.config_options = Some(response.config_options);
                }
            } else if let Some(models) = &details.models {
                if !models
                    .available_models
                    .iter()
                    .any(|option| option.model_id == model.as_str())
                {
                    return Err(DomainError::Protocol(
                        "model is not offered by provider".into(),
                    ));
                }
                if models.current_model_id != model.as_str() {
                    let _: settings::EmptyResponse = self
                        .call(
                            "session/set_model",
                            settings::SetModelRequest {
                                session_id: native.clone(),
                                model_id: model.as_str().into(),
                            },
                        )
                        .await?;
                    if let Some(models) = &mut details.models {
                        models.current_model_id = model.as_str().into();
                    }
                }
            } else {
                return Err(DomainError::Protocol(
                    "provider exposes no model configuration".into(),
                ));
            }
        }
        if let Some(mode) = &config.mode {
            if let Some((id, current, options)) = details.select("mode") {
                if !options
                    .values()
                    .iter()
                    .any(|option| option.value == mode.as_str())
                {
                    return Err(DomainError::Protocol(
                        "mode is not offered by provider".into(),
                    ));
                }
                if current != mode.as_str() {
                    let response: settings::SetConfigResponse = self
                        .call(
                            "session/set_config_option",
                            settings::SetConfigRequest {
                                session_id: native.clone(),
                                config_id: id.into(),
                                value: mode.as_str().into(),
                            },
                        )
                        .await?;
                    details.config_options = Some(response.config_options);
                }
            } else if let Some(modes) = &details.modes {
                if !modes
                    .available_modes
                    .iter()
                    .any(|option| option.id == mode.as_str())
                {
                    return Err(DomainError::Protocol(
                        "mode is not offered by provider".into(),
                    ));
                }
                if modes.current_mode_id != mode.as_str() {
                    let _: settings::EmptyResponse = self
                        .call(
                            "session/set_mode",
                            settings::SetModeRequest {
                                session_id: native.clone(),
                                mode_id: mode.as_str().into(),
                            },
                        )
                        .await?;
                    if let Some(modes) = &mut details.modes {
                        modes.current_mode_id = mode.as_str().into();
                    }
                }
            } else {
                return Err(DomainError::Protocol(
                    "provider exposes no mode configuration".into(),
                ));
            }
        }
        for (id, value) in &config.options {
            let observed = details.catalogue_patch()?;
            let setting = observed
                .selects
                .as_ref()
                .and_then(|s| s.iter().find(|s| &s.id == id))
                .ok_or_else(|| {
                    DomainError::Protocol("provider exposes no such select setting".into())
                })?;
            if !setting.choices.iter().any(|c| &c.value == value) {
                return Err(DomainError::Protocol("setting value is not offered".into()));
            }
            if &setting.current_value != value {
                let response: settings::SetConfigResponse = self
                    .call(
                        "session/set_config_option",
                        settings::SetConfigRequest {
                            session_id: native.clone(),
                            config_id: id.clone(),
                            value: value.clone(),
                        },
                    )
                    .await?;
                details.config_options = Some(response.config_options);
            }
            if !details
                .catalogue_patch()?
                .selects
                .unwrap_or_default()
                .iter()
                .any(|s| &s.id == id && &s.current_value == value)
            {
                return Err(DomainError::Protocol(
                    "provider did not confirm requested setting".into(),
                ));
            }
        }
        let observed = details.catalogue_patch()?;
        if config
            .model
            .as_ref()
            .is_some_and(|expected| observed.current_model.as_ref() != Some(expected))
            || config
                .mode
                .as_ref()
                .is_some_and(|expected| observed.current_mode.as_ref() != Some(expected))
        {
            return Err(DomainError::Protocol(
                "provider did not confirm requested settings".into(),
            ));
        }
        Ok(())
    }
    pub async fn prompt(
        &self,
        session_id: NativeSessionId,
        prompt: Vec<ContentBlock>,
    ) -> Result<PromptResponse, DomainError> {
        self.call(
            "session/prompt",
            SessionPromptRequest { session_id, prompt },
        )
        .await
    }
    pub async fn cancel(&self, session_id: NativeSessionId) -> Result<(), DomainError> {
        let notification = JsonRpcNotification {
            jsonrpc: JsonRpcVersion::V2,
            method: "session/cancel".into(),
            params: serde_json::to_value(CancelRequest { session_id })
                .map_err(|e| DomainError::Protocol(e.to_string()))?,
        };
        self.worker.notify(notification).await
    }
    pub async fn answer(
        &self,
        request: &interaction::InboundRequest,
        response: crate::domain::interaction::InteractionResponse,
    ) -> Result<(), DomainError> {
        use crate::domain::interaction::{FieldValue, InteractionResponse};
        use interaction::{
            FormResponse, FormValue, InboundRequest, PermissionOutcome, PermissionResponse,
        };
        let result = match (request, response) {
            (InboundRequest::Permission { .. }, InteractionResponse::Permission { option }) => {
                serde_json::to_value(PermissionResponse {
                    outcome: PermissionOutcome::Selected { option_id: option },
                })
            }
            (
                InboundRequest::Permission { .. },
                InteractionResponse::Cancel | InteractionResponse::Decline,
            ) => serde_json::to_value(PermissionResponse {
                outcome: PermissionOutcome::Cancelled,
            }),
            (InboundRequest::Form { request, .. }, InteractionResponse::Form { fields }) => {
                let content = fields
                    .into_iter()
                    .map(|(name, value)| {
                        (
                            name.clone(),
                            match value {
                                FieldValue::Text(value) => FormValue::Text(value),
                                FieldValue::Selected(mut value)
                                    if matches!(
                                        request.requested_schema.properties.get(&name),
                                        Some(interaction::SchemaField::String { .. })
                                    ) =>
                                {
                                    FormValue::Text(value.pop().unwrap_or_default())
                                }
                                FieldValue::Selected(value) => FormValue::Selected(value),
                                FieldValue::Boolean(value) => FormValue::Boolean(value),
                                FieldValue::Integer(value) => FormValue::Integer(value),
                            },
                        )
                    })
                    .collect();
                serde_json::to_value(FormResponse::Accept { content })
            }
            (InboundRequest::Form { .. }, InteractionResponse::Decline) => {
                serde_json::to_value(FormResponse::Decline)
            }
            (InboundRequest::Form { .. }, InteractionResponse::Cancel) => {
                serde_json::to_value(FormResponse::Cancel)
            }
            _ => return Err(DomainError::InvalidAnswer("unvalidated ACP answer".into())),
        }
        .map_err(|error| DomainError::Protocol(error.to_string()))?;
        self.worker
            .respond(JsonRpcResponse {
                jsonrpc: JsonRpcVersion::V2,
                id: request.id().clone(),
                result: Some(result),
                error: None,
            })
            .await
    }
    pub async fn stop(self) {
        self.worker.stop().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        domain::{SessionId, WorkspacePath},
        worker::WorkerSupervisor,
    };
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn settings_are_applied_to_provider_before_prompt_and_invalid_values_are_rejected() {
        let peer = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test/contract-agent.mjs");
        let supervisor = WorkerSupervisor::new(
            "node".into(),
            vec![peer.to_string_lossy().into_owned()],
            Default::default(),
            1,
        );
        let (tx, _rx) = mpsc::channel(32);
        let client = AcpClient::new(supervisor.spawn(SessionId::generate(), tx).await.unwrap());
        client.initialize().await.unwrap();
        let created = client
            .new_session(&WorkspacePath::new("/tmp").unwrap())
            .await
            .unwrap();
        let mut details = created.details;
        let config = crate::domain::session::SessionConfig {
            options: Default::default(),
            model: Some(crate::domain::ModelId::new("other").unwrap()),
            mode: Some(crate::domain::ModeId::new("high").unwrap()),
        };
        client
            .configure(&created.session_id, &mut details, &config)
            .await
            .unwrap();
        assert_eq!(details.select("model").unwrap().1, "other");
        assert_eq!(details.modes.as_ref().unwrap().current_mode_id, "high");
        let invalid = crate::domain::session::SessionConfig {
            options: Default::default(),
            model: Some(crate::domain::ModelId::new("not-offered").unwrap()),
            mode: None,
        };
        assert!(client
            .configure(&created.session_id, &mut details, &invalid)
            .await
            .is_err());
        assert_eq!(details.select("model").unwrap().1, "other");
        client.stop().await;
    }

    #[tokio::test]
    async fn typed_initialize_new_prompt_cancel_with_independent_peer() {
        let peer = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test/contract-agent.mjs");
        let supervisor = WorkerSupervisor::new(
            "node".into(),
            vec![peer.to_string_lossy().into_owned()],
            Default::default(),
            1,
        );
        let (tx, mut rx) = mpsc::channel(32);
        let worker = supervisor.spawn(SessionId::generate(), tx).await.unwrap();
        let client = AcpClient::new(worker);
        assert!(
            client
                .initialize()
                .await
                .unwrap()
                .agent_capabilities
                .load_session
        );
        let native = client
            .new_session(&WorkspacePath::new("/tmp").unwrap())
            .await
            .unwrap()
            .session_id;
        let result = client
            .prompt(native.clone(), vec![ContentBlock::text("hello")])
            .await
            .unwrap();
        assert!(matches!(result.stop_reason, StopReason::EndTurn));
        assert!(
            matches!(rx.recv().await, Some(crate::worker::WorkerEvent::Update(SessionNotification { update: SessionUpdate::AgentMessage { content, .. }, .. })) if content.display_text() == Some("echo: hello"))
        );
        client.cancel(native).await.unwrap();
        client.stop().await;
    }
}
