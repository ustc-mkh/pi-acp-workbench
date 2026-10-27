//! Typed ACP boundary and provider-to-domain conversion.
pub mod adapter;
pub mod client;
pub mod codec;
pub mod content;
mod control;
pub mod dto;
#[cfg(test)]
mod extension_tests;
pub mod extensions;
pub mod interaction;
pub mod settings;
pub mod tool;

pub fn decode_request(
    request: JsonRpcRequest,
) -> Result<interaction::InboundRequest, crate::domain::error::DomainError> {
    let id = request.id;
    match request.method.as_str() {
        "session/request_permission" => serde_json::from_value(request.params)
            .map(|request| interaction::InboundRequest::Permission { id, request }),
        "elicitation/create" => serde_json::from_value(request.params)
            .map(|request| interaction::InboundRequest::Form { id, request }),
        _ => {
            return Err(crate::domain::error::DomainError::Protocol(
                "unsupported inbound ACP method".into(),
            ))
        }
    }
    .map_err(|error| crate::domain::error::DomainError::Protocol(error.to_string()))
}
pub use codec::*;
pub use content::ContentBlock;
pub use dto::*;

use crate::domain::error::DomainError;
use serde_json::Value;

/// Consume the opaque permission rawInput at the codec boundary. Ordinary
/// tool inputs remain opaque; only known Pi question display hints leave here.
pub fn decode_question_input<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<interaction::PermissionQuestionInput>, D::Error> {
    use serde::Deserialize;
    let raw = Value::deserialize(deserializer)?;
    let Some(method @ ("select" | "confirm")) = raw.get("method").and_then(Value::as_str) else {
        return Ok(None);
    };
    Ok(Some(interaction::PermissionQuestionInput {
        method: method.into(),
        message: raw
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into(),
    }))
}

/// Keep native session identity until the adapter has validated its owner.
pub fn decode_notification(raw: Value) -> Result<dto::SessionNotification, DomainError> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Envelope {
        session_id: NativeSessionId,
        update: Value,
    }
    let envelope: Envelope =
        serde_json::from_value(raw).map_err(|error| DomainError::Protocol(error.to_string()))?;
    Ok(dto::SessionNotification {
        session_id: envelope.session_id,
        update: decode_update(envelope.update)?,
    })
}

/// Raw JSON is consumed here, never passed to the runtime. Unknown updates are
/// observable; malformed known updates are protocol errors rather than unknown.
pub fn decode_update(raw: Value) -> Result<SessionUpdate, DomainError> {
    let update = raw.get("update").unwrap_or(&raw);
    let name = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .ok_or_else(|| DomainError::Protocol("sessionUpdate missing".into()))?;
    if name == "session_info_update" {
        if let Some(run) = update.pointer("/_meta/pi-workbench-run") {
            return serde_json::from_value(run.clone())
                .map(SessionUpdate::PiRun)
                .map_err(|e| DomainError::Protocol(e.to_string()));
        }
    }
    if let Some(id) = update.pointer("/_meta/pi-workbench-live") {
        let id =
            serde_json::from_value(id.clone()).map_err(|e| DomainError::Protocol(e.to_string()))?;
        let mut unwrapped = update.clone();
        unwrapped["_meta"]
            .as_object_mut()
            .expect("metadata object")
            .remove("pi-workbench-live");
        return Ok(SessionUpdate::PiLive {
            id,
            update: Box::new(decode_update(unwrapped)?),
        });
    }
    if !matches!(
        name,
        "agent_message_chunk"
            | "agent_thought_chunk"
            | "user_message_chunk"
            | "tool_call"
            | "tool_call_update"
            | "plan"
            | "usage_update"
            | "available_commands_update"
            | "config_option_update"
            | "current_mode_update"
    ) {
        return Ok(SessionUpdate::Unknown {
            name: name.to_owned(),
        });
    }
    serde_json::from_value(update.clone()).map_err(|e| DomainError::Protocol(e.to_string()))
}

#[cfg(test)]
#[path = "acp/dto_tests.rs"]
mod dto_tests;
#[cfg(test)]
#[path = "acp/interaction_tests.rs"]
mod interaction_tests;
#[cfg(test)]
#[path = "acp/tool_tests.rs"]
mod tool_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn typed_update_round_trips() {
        let update = SessionUpdate::AgentMessage {
            content: ContentBlock::text("hello"),
            message_id: None,
        };
        let json = serde_json::to_string(&update).unwrap();
        let decoded: SessionUpdate = serde_json::from_str(&json).unwrap();
        assert!(
            matches!(decoded, SessionUpdate::AgentMessage { content, .. } if content.display_text() == Some("hello"))
        );
    }
}
