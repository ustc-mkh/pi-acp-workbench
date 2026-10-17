//! All user requests share the existing bounded pending-request lifecycle.
//! Forms are presented one field at a time to both Telegram and Webview, without
//! changing the public service protocol or encoding user labels into option IDs.
use super::*;
use crate::interaction::{FieldKind, Form, UserRequest};

pub(super) async fn service_interaction(
    rt: &Rt,
    request: UserRequest,
    broadcast: Broadcast,
    closed: &AtomicBool,
    epoch: Option<u64>,
) -> Value {
    let request = match request {
        UserRequest::Permission(request) => {
            return service_permission(rt, request, broadcast, closed, epoch).await;
        }
        UserRequest::Form(request) => request,
    };
    if serde_json::to_vec(&request).map_or(true, |v| v.len() > 256 * 1024) {
        return json!({"action":"cancel"});
    }
    let Some(form) = Form::parse(&request) else {
        return json!({"action":"decline"});
    };
    let mut content = serde_json::Map::new();
    for (index, field) in form.fields.iter().enumerate() {
        let mut selected: Vec<usize> = Vec::new();
        loop {
            let mut options = Vec::new();
            if let FieldKind::Choice {
                options: choices,
                multiple,
            } = &field.kind
            {
                for (i, (_, label)) in choices.iter().enumerate() {
                    let name = if *multiple && selected.contains(&i) {
                        format!("✓ {label}")
                    } else {
                        label.clone()
                    };
                    options.push(json!({"optionId": format!("choice:{i}"), "name": name, "kind":"allow_once"}));
                }
                if *multiple && (!field.required || !selected.is_empty()) {
                    options
                        .push(json!({"optionId":"done", "name":"完成选择", "kind":"allow_once"}));
                }
            } else {
                options.push(json!({"optionId":"submit", "name":"提交文本", "kind":"allow_once"}));
            }
            if !field.required {
                options.push(json!({"optionId":"skip", "name":"跳过", "kind":"reject_once"}));
            }
            options
                .push(json!({"optionId":"decline", "name":"跳过整个表单", "kind":"reject_once"}));
            let is_text = matches!(field.kind, FieldKind::Text);
            let presentation = json!({
                "sessionId": request.get("sessionId"),
                "_meta": {"pi-workbench-input": is_text},
                "toolCall": {
                    "toolCallId": format!("pi-ui-form-{index}"),
                    "title": format!("{} ({}/{}) · {}", form.message, index+1, form.fields.len(), field.title),
                    "status":"pending",
                    "rawInput": {
                        "method": if is_text {"input"} else {"select"},
                        "message": field.description,
                    }
                },
                "options": options,
            });
            let result =
                service_permission(rt, presentation, broadcast.clone(), closed, epoch).await;
            let Some(option) = result.pointer("/outcome/optionId").and_then(Value::as_str) else {
                return json!({"action":"cancel"});
            };
            match option {
                "decline" => return json!({"action":"decline"}),
                "skip" => break,
                "submit" => {
                    let Some(value) = result
                        .pointer("/_meta/pi-workbench-input/value")
                        .and_then(Value::as_str)
                    else {
                        return json!({"action":"cancel"});
                    };
                    content.insert(field.key.clone(), json!(value));
                    break;
                }
                "done" => {
                    if let FieldKind::Choice { options, .. } = &field.kind {
                        content.insert(
                            field.key.clone(),
                            json!(selected
                                .iter()
                                .map(|i| options[*i].0.clone())
                                .collect::<Vec<_>>()),
                        );
                    }
                    break;
                }
                _ => {
                    let Some(i) = option
                        .strip_prefix("choice:")
                        .and_then(|n| n.parse::<usize>().ok())
                    else {
                        return json!({"action":"cancel"});
                    };
                    if let FieldKind::Choice { options, multiple } = &field.kind {
                        let Some((value, _)) = options.get(i) else {
                            return json!({"action":"cancel"});
                        };
                        if !multiple {
                            content.insert(field.key.clone(), value.clone());
                            break;
                        }
                        if let Some(position) = selected.iter().position(|v| *v == i) {
                            selected.remove(position);
                        } else {
                            selected.push(i);
                        }
                    }
                }
            }
        }
    }
    json!({"action":"accept", "content":content})
}
