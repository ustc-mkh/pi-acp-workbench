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
