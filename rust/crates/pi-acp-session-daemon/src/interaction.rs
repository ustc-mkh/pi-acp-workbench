//! ACP user-request boundary. Transport dispatch is typed; the public permission
//! envelope remains a compatibility surface for existing workbench clients.
use serde_json::{json, Value};

pub enum UserRequest {
    Permission(Value),
    Form(Value),
}
impl UserRequest {
    pub fn cancelled(&self) -> Value {
        match self {
            Self::Permission(_) => json!({"outcome": {"outcome": "cancelled"}}),
            Self::Form(_) => json!({"action": "cancel"}),
        }
    }
}

/// One supported, flat ACP form field. Nested schemas are rejected, never
/// silently flattened or partially answered.
pub struct FormField {
    pub key: String,
    pub title: String,
    pub description: String,
    pub kind: FieldKind,
    pub required: bool,
}
pub enum FieldKind {
    Text,
    Choice {
        options: Vec<(Value, String)>,
        multiple: bool,
    },
}
pub struct Form {
    pub message: String,
    pub fields: Vec<FormField>,
}
impl Form {
    pub fn parse(request: &Value) -> Option<Self> {
        if request.get("mode").and_then(Value::as_str) != Some("form") {
            return None;
        }
        let schema = request.get("requestedSchema")?;
        let properties = schema.get("properties")?.as_object()?;
        if properties.len() > 64 {
            return None;
        }
        let mut fields = Vec::new();
        for (key, property) in properties {
            let required = schema
                .get("required")
                .and_then(Value::as_array)
                .is_some_and(|keys| keys.iter().any(|v| v.as_str() == Some(key)));
            let multiple = property.get("type").and_then(Value::as_str) == Some("array");
            let source = if multiple {
                property.get("items")?
            } else {
                property
            };
            let values = source.get("oneOf").or_else(|| source.get("anyOf"));
            let options = if let Some(values) = values {
                values
                    .as_array()?
                    .iter()
                    .map(|v| {
                        let value = v.get("const")?.clone();
                        let label = v
                            .get("title")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_else(|| display_value(&value));
                        Some((value, label))
                    })
                    .collect::<Option<Vec<_>>>()?
            } else if let Some(values) = source.get("enum") {
                values
                    .as_array()?
                    .iter()
                    .map(|v| (v.clone(), display_value(v)))
                    .collect()
            } else {
                Vec::new()
            };
            let kind = if !options.is_empty() && options.len() <= 64 {
                FieldKind::Choice { options, multiple }
            } else if !multiple && property.get("type").and_then(Value::as_str) == Some("string") {
                FieldKind::Text
            } else {
                return None;
            };
            fields.push(FormField {
                key: key.clone(),
                title: property
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or(key)
                    .to_string(),
                description: property
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                kind,
                required,
            });
        }
        Some(Self {
            message: request.get("message")?.as_str()?.to_string(),
            fields,
        })
    }
}
fn display_value(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

/// Decode a workbench answer once, at the service boundary. Empty submit buttons
/// cannot bypass text validation; choices never carry incidental editor text.
pub fn permission_response(
    request: &Value,
    option: Option<&str>,
    text: Option<&str>,
) -> Option<Value> {
    let Some(option) = option else {
        return text
            .is_none()
            .then(|| json!({"outcome": {"outcome": "cancelled"}}));
    };
    if !request
        .get("options")?
        .as_array()?
        .iter()
        .any(|v| v.get("optionId").and_then(Value::as_str) == Some(option))
    {
        return None;
    }
    let input = request.pointer("/_meta/pi-workbench-input") == Some(&Value::Bool(true))
        && matches!(
            request
                .pointer("/toolCall/rawInput/method")
                .and_then(Value::as_str),
            Some("input" | "editor")
        );
    let mut response = json!({"outcome": {"outcome": "selected", "optionId": option}});
    match text {
        Some(text) if input && option == "submit" && text.encode_utf16().count() <= 10000 => {
            response["_meta"] = json!({"pi-workbench-input": {"value": text}});
        }
        Some(_) => return None,
        None if input && option == "submit" => return None,
        None => {}
    }
    Some(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_claude_fields_without_losing_custom_or_multiselect() {
        let form = Form::parse(&json!({"mode":"form", "message":"Q", "requestedSchema": {
            "properties": {
                "question_0": {"type":"array", "items":{"anyOf":[{"const":"a:b"}]}},
                "question_0_custom": {"type":"string"}
            }
        }}))
        .unwrap();
        assert_eq!(form.fields.len(), 2);
        assert!(matches!(
            form.fields[0].kind,
            FieldKind::Choice { multiple: true, .. }
        ));
    }
    #[test]
    fn rejects_unsupported_forms_instead_of_answering_partially() {
        assert!(Form::parse(&json!({"mode":"url"})).is_none());
        assert!(Form::parse(&json!({"mode":"form","message":"Q","requestedSchema":{"properties":{"x":{"type":"object"}}}})).is_none());
    }
    #[test]
    fn validates_text_and_button_answers() {
        let request = json!({"_meta":{"pi-workbench-input":true},"toolCall":{"rawInput":{"method":"input"}},"options":[{"optionId":"submit"},{"optionId":"choice:0"}]});
        assert!(permission_response(&request, Some("submit"), None).is_none());
        assert!(permission_response(&request, Some("submit"), Some("answer")).is_some());
        assert!(permission_response(&request, Some("choice:0"), None).is_some());
        assert!(permission_response(&request, Some("choice:0"), Some("wrong")).is_none());
        assert!(permission_response(&request, Some("unknown"), None).is_none());
        assert!(permission_response(&request, None, None).is_some());
    }
}
