use super::*;
use serde_json::json;

#[test]
fn fixture_corpus_uses_standard_jsonrpc_envelopes() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../test/fixtures/rewrite/acp-contract.json"
    ))
    .unwrap();
    for frame in fixture["messages"].as_array().unwrap() {
        let decoded: JsonRpcMessage = serde_json::from_value(frame.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), *frame);
    }
}

#[test]
fn string_ids_null_results_and_errors_round_trip() {
    for frame in [
        json!({"jsonrpc":"2.0","id":"perm-1","result":null}),
        json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}),
        json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s"}}),
    ] {
        let decoded: JsonRpcMessage = serde_json::from_value(frame.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), frame);
    }
}

#[test]
fn typed_success_encoding_keeps_decline_and_explicit_null_inside_codec() {
    let response = JsonRpcResponse::success(
        RequestId::String("form-中文".into()),
        crate::acp::interaction::FormResponse::Decline,
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(response).unwrap(),
        json!({"jsonrpc":"2.0","id":"form-中文","result":{"action":"decline"}})
    );
    let response = JsonRpcResponse::success(RequestId::Number(7), ()).unwrap();
    assert_eq!(
        serde_json::to_value(response).unwrap(),
        json!({"jsonrpc":"2.0","id":7,"result":null})
    );
    struct BadResult;
    impl Serialize for BadResult {
        fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
            Err(serde::ser::Error::custom("fixture serializer failed"))
        }
    }
    assert!(JsonRpcResponse::success(RequestId::Number(8), BadResult).is_err());
}

#[test]
fn invalid_envelopes_are_protocol_errors_not_notifications() {
    for frame in [
        json!([]),
        json!({"id":1,"result":{}}),
        json!({"jsonrpc":"1.0","id":1,"result":{}}),
        json!({"jsonrpc":"2.0","id":1}),
        json!({"jsonrpc":"2.0","id":1,"result":{},"error":{"code":1,"message":"bad"}}),
        json!({"jsonrpc":"2.0","result":{}}),
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","result":{}}),
        json!({"jsonrpc":"2.0","method":42}),
        json!({"jsonrpc":"2.0","method":"initialize","params":"not structured"}),
    ] {
        assert!(
            serde_json::from_value::<JsonRpcMessage>(frame.clone()).is_err(),
            "{frame}"
        );
    }
}
