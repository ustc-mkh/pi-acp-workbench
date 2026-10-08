//! Validate adapter-owned JSON before publishing it or mutating runtime state.
use serde_json::Value;
fn invalid(method: &str) -> String {
    format!("ACP {method} 返回无效数据，未应用会话状态。")
}
fn session_fields(value: &Value, method: &str) -> Result<(), String> {
    if !value.is_object() {
        return Err(invalid(method));
    }
    if let Some(configs) = value.get("configOptions") {
        if !configs
            .as_array()
            .is_some_and(|items| items.iter().all(|item| item.is_object()))
        {
            return Err(invalid(method));
        }
    }
    if let Some(modes) = value.get("modes") {
        if !modes.is_object() {
            return Err(invalid(method));
        }
    }
    Ok(())
}
pub fn response(method: &str, value: &Value) -> Result<(), String> {
    match method {
        "initialize" => {
            if !value.is_object() {
                return Err(invalid(method));
            }
            if let Some(capabilities) = value.get("agentCapabilities") {
                if !capabilities.is_object() {
                    return Err(invalid(method));
                }
                if capabilities
                    .get("_meta")
                    .is_some_and(|meta| !meta.is_object())
                {
                    return Err(invalid(method));
                }
            }
        }
        "session/new" | "session/load" | "session/set_config_option" | "session/set_mode" => {
            session_fields(value, method)?;
            if method == "session/new"
                && !value
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| !id.is_empty())
            {
                return Err(invalid(method));
            }
        }
        "session/prompt" => {
            if !value.get("stopReason").and_then(Value::as_str).is_some() {
                return Err(invalid(method));
            }
        }
        _ => {}
    }
    Ok(())
}
pub fn notification(value: &Value) -> Result<(), String> {
    if !value
        .get("sessionId")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty())
    {
        return Err(invalid("session/update"));
    }
    let update = value
        .get("update")
        .ok_or_else(|| invalid("session/update"))?;
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("session/update"))?;
    match kind {
        "config_option_update" => session_fields(update, "session/update")?,
        "current_mode_update" if !update.get("currentModeId").is_some_and(Value::is_string) => {
            return Err(invalid("session/update"))
        }
        "tool_call" | "tool_call_update"
            if !update.get("toolCallId").is_some_and(Value::is_string) =>
        {
            return Err(invalid("session/update"))
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn malformed_adapter_data_is_rejected_before_json_mutation() {
        for value in [
            json!(null),
            json!({"agentCapabilities":42}),
            json!({"agentCapabilities":{"_meta":[]}}),
        ] {
            assert!(response("initialize", &value).is_err());
        }
        for value in [
            json!(null),
            json!({"sessionId":"x","modes":false}),
            json!({"sessionId":"x","configOptions":[null]}),
            json!({"sessionId":""}),
        ] {
            assert!(response("session/new", &value).is_err());
        }
        assert!(response("session/load", &json!({})).is_ok());
        assert!(response("session/prompt", &json!({"stopReason":"end_turn"})).is_ok());
    }
}
