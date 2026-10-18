use super::*;
use serde_json::{json, Value};

#[test]
fn provider_profiles_parse_initialize_and_standard_messages() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../../test/fixtures/rewrite/acp-contract.json"
    ))
    .unwrap();
    for profile in corpus["providers"].as_array().unwrap() {
        let mut initialized = corpus["messages"][1]["result"].clone();
        initialized["agentInfo"] = profile["agentInfo"].clone();
        let result: InitializeResponse = serde_json::from_value(initialized).unwrap();
        assert_eq!(result.protocol_version, 1);
        assert!(result.agent_capabilities.load_session);
        assert!(result.agent_info.is_some());
    }
    for frame in corpus["messages"].as_array().unwrap() {
        match frame["method"].as_str() {
            Some("initialize") => {
                serde_json::from_value::<InitializeRequest>(frame["params"].clone()).unwrap();
            }
            Some("session/new") => {
                serde_json::from_value::<NewSessionRequest>(frame["params"].clone()).unwrap();
            }
            Some("session/prompt") => {
                serde_json::from_value::<SessionPromptRequest>(frame["params"].clone()).unwrap();
            }
            Some("session/cancel") => {
                serde_json::from_value::<CancelRequest>(frame["params"].clone()).unwrap();
            }
            Some("session/update") => {
                decode_update(frame["params"].clone()).unwrap();
            }
            _ => {}
        }
    }
    let response: PromptResponse =
        serde_json::from_value(corpus["messages"][16]["result"].clone()).unwrap();
    assert!(matches!(response.stop_reason, StopReason::Cancelled));
    assert_eq!(response.usage.unwrap().input_tokens, 100);
}

#[test]
fn malformed_known_updates_are_errors_but_future_updates_are_unknown() {
    assert!(decode_update(
        json!({"sessionUpdate":"agent_message_chunk", "content":{"type":"text"}})
    )
    .is_err());
    assert!(
        decode_update(json!({"sessionUpdate":"plan","entries":[{"status":"pending"}]})).is_err()
    );
    assert!(decode_update(json!({"sessionUpdate":"usage_update","used":-1,"size":100})).is_err());
    assert!(
        matches!(decode_update(json!({"sessionUpdate":"future_update","extra":1})).unwrap(),
        SessionUpdate::Unknown { name } if name == "future_update")
    );
}

#[test]
fn opaque_message_ids_survive_typed_mapping_without_becoming_native_ids() {
    use crate::domain::{command::AgentEvent, TurnId};
    for kind in ["agent_message_chunk", "agent_thought_chunk"] {
        let id = "opaque/stream:uuid-not-a-native-timestamp";
        let update = decode_update(
            json!({"sessionUpdate":kind,"messageId":id,"content":{"type":"text","text":"delta"}}),
        )
        .unwrap();
        assert_eq!(serde_json::to_value(&update).unwrap()["messageId"], id);
        let event = adapter::update_to_agent(TurnId::generate(), update)
            .unwrap()
            .unwrap();
        match event {
            AgentEvent::Text { message, text, .. } | AgentEvent::Thought { message, text, .. } => {
                assert_eq!(message.unwrap().as_str(), id);
                assert_eq!(text, "delta");
            }
            _ => panic!("text/thought mapping"),
        }
        for invalid in [
            json!(""),
            json!(" bad"),
            json!("x\u{0000}"),
            json!("x".repeat(201)),
            json!(42),
        ] {
            assert!(decode_update(json!({"sessionUpdate":kind,"messageId":invalid,"content":{"type":"text","text":"delta"}})).is_err());
        }
    }
}

#[test]
fn content_preserves_opaque_extensions_and_validates_known_variants() {
    let unknown = json!({"type":"provider_future","payload":{"nested":[1,2,3]}});
    let decoded: ContentBlock = serde_json::from_value(unknown.clone()).unwrap();
    assert!(matches!(&decoded, ContentBlock::Unknown(_)));
    assert_eq!(serde_json::to_value(decoded).unwrap(), unknown);
    for raw in [
        json!({"type":"text","text":"你好"}),
        json!({"type":"image","data":"aGVsbG8=","mimeType":"image/png"}),
        json!({"type":"resource","resource":{"uri":"file:///tmp/a","text":"context"}}),
        json!({"type":"resource_link","uri":"file:///tmp/a","name":"a"}),
        json!({"type":"audio","data":"aGVsbG8=","mimeType":"audio/wav"}),
    ] {
        let block: ContentBlock = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(serde_json::to_value(block).unwrap(), raw);
    }
    assert!(
        serde_json::from_value::<ContentBlock>(json!({"type":"image","uri":"missing-data"}))
            .is_err()
    );
}
