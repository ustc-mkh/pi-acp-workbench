use super::*;
use serde_json::{json, Value};

#[test]
fn permission_and_form_fixtures_convert_without_raw_domain_json() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../../test/fixtures/rewrite/acp-contract.json"
    ))
    .unwrap();
    for index in [11, 13] {
        let message: JsonRpcMessage =
            serde_json::from_value(corpus["messages"][index].clone()).unwrap();
        let JsonRpcMessage::Request(request) = message else {
            panic!("request")
        };
        let request = decode_request(request).unwrap();
        let domain = request
            .to_domain(crate::domain::InteractionId::generate())
            .unwrap();
        domain.validate_definition().unwrap();
        assert_eq!(request.session().as_str(), "native-session");
    }
}

#[test]
fn nested_or_constrained_unsupported_form_schemas_are_not_silently_truncated() {
    for schema in [
        json!({"type":"object","properties":{"nested":{"type":"object","properties":{}}}}),
        json!({"type":"object","properties":{"text":{"type":"string","pattern":"secret"}}}),
        json!({"type":"object","properties":{"text":{"type":"string","minLength":5}}}),
    ] {
        let request = JsonRpcRequest::new(RequestId::String("form".into()), "elicitation/create", json!({
            "sessionId":"native-session", "mode":"form", "message":"Question", "requestedSchema":schema,
        })).unwrap();
        assert!(decode_request(request).is_err());
    }
}

#[test]
fn pi_questions_preserve_presentation_and_keep_typed_answer_validation() {
    use crate::domain::interaction::*;
    for method in ["select", "confirm", "input", "editor"] {
        let presentation = json!({"method":method,"title":"Choose a plan","message":"Review it", "placeholder":"Answer here", "prefill":"original\n中文"});
        let (rpc, params) = if matches!(method, "select" | "confirm") {
            (
                "session/request_permission",
                json!({"sessionId":"native-session", "toolCall":{"toolCallId":"pi-ui-1", "title":"Choose a plan", "rawInput":{"method":method,"message":"Review it"}}, "options":[{"optionId":"yes", "name":"Yes", "kind":"allow_once"}]}),
            )
        } else {
            (
                "elicitation/create",
                json!({"sessionId":"native-session", "mode":"form", "message":"Choose a plan", "_meta":{"pi-workbench-question":presentation}, "requestedSchema":{"type":"object","properties":{"value":{"type":"string","maxLength":10000}},"required":[]}}),
            )
        };
        let request = decode_request(
            JsonRpcRequest::new(RequestId::String(method.into()), rpc, params).unwrap(),
        )
        .unwrap();
        let interaction = request
            .to_domain(crate::domain::InteractionId::generate())
            .unwrap();
        let restored: Interaction =
            serde_json::from_value(serde_json::to_value(&interaction).unwrap()).unwrap();
        assert_eq!(restored.question.as_ref().unwrap().message, "Review it");
        if matches!(method, "input" | "editor") {
            assert_eq!(
                restored.question.as_ref().unwrap().prefill,
                "original\n中文"
            );
            let answer = InteractionAnswer {
                interaction: restored.id.clone(),
                response: InteractionResponse::Form {
                    fields: std::collections::BTreeMap::from([(
                        "value".into(),
                        FieldValue::Text(String::new()),
                    )]),
                },
            };
            restored.validate_answer(answer, 0).unwrap();
        } else {
            assert!(restored
                .validate_answer(
                    InteractionAnswer {
                        interaction: restored.id.clone(),
                        response: InteractionResponse::Permission {
                            option: "invented".into()
                        }
                    },
                    0
                )
                .is_err());
        }
    }
}

#[test]
fn question_hints_cannot_change_permission_semantics_or_hide_an_unsupported_form() {
    let params = json!({"sessionId":"native-session", "mode":"form", "message":"Q", "_meta":{"pi-workbench-question":{"method":"select","title":"Q","message":"","placeholder":"","prefill":""}}, "requestedSchema":{"type":"object","properties":{"value":{"type":"string"}},"required":[]}});
    let request = decode_request(
        JsonRpcRequest::new(
            RequestId::String("invalid".into()),
            "elicitation/create",
            params,
        )
        .unwrap(),
    )
    .unwrap();
    assert!(request
        .to_domain(crate::domain::InteractionId::generate())
        .is_err());
}
