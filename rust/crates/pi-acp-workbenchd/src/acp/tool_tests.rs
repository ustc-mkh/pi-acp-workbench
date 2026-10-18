use super::*;
use crate::domain::{command::AgentEvent, tool as domain, TurnId};
use serde_json::json;

fn map(raw: serde_json::Value) -> domain::ToolCallUpdate {
    let update = decode_update(raw.clone()).unwrap();
    let encoded = serde_json::to_value(&update).unwrap();
    for field in ["rawInput", "rawOutput"] {
        if let Some(value) = raw.get(field) {
            assert_eq!(&encoded[field], value);
        }
    }
    let Some(AgentEvent::ToolCall(update)) =
        adapter::update_to_agent(TurnId::generate(), update).unwrap()
    else {
        panic!("tool update")
    };
    update
}
#[test]
fn standard_tool_metadata_maps_content_diff_resource_locations_and_terminal_without_raw_json() {
    let update = map(json!({
        "sessionUpdate":"tool_call", "toolCallId":"call:1", "title":"Edit file",
        "status":"in_progress", "kind":"edit", "name":"apply_patch",
        "locations":[{"path":"/display/only.rs","line":0}],
        "content":[
            {"type":"content","content":{"type":"text","text":"progress"}},
            {"type":"diff","path":"/display/only.rs","oldText":"old","newText":"new"},
            {"type":"diff","path":"new.rs","newText":"created"},
            {"type":"terminal","terminalId":"terminal:1"},
            {"type":"content","content":{"type":"resource","resource":{"uri":"file:///display/only.rs","text":"context","mimeType":"text/plain"}}},
            {"type":"content","content":{"type":"resource_link","uri":"https://example.invalid/resource","name":"reference"}},
            {"type":"content","content":{"type":"image","data":"PRIVATE_BINARY","mimeType":"image/png"}},
            {"type":"future_tool_item","opaque":"PRIVATE_UNKNOWN"},
            {"type":"content","content":{"type":"future_block","opaque":"PRIVATE_OPAQUE"}}
        ],
        "rawInput":{"secret":"PRIVATE_INPUT"}, "rawOutput":{"secret":"PRIVATE_OUTPUT"}
    }));
    let details = &update.details;
    assert_eq!(details.kind, Some(domain::ToolKind::Edit));
    assert_eq!(details.name.as_deref(), Some("apply_patch"));
    assert_eq!(details.locations.as_ref().unwrap()[0].line, Some(0));
    let content = details.content.as_ref().unwrap();
    assert!(matches!(&content[0], domain::ToolContent::Text { text } if text == "progress"));
    assert!(
        matches!(&content[1], domain::ToolContent::Diff { old_text: Some(old), new_text, .. } if old == "old" && new_text == "new")
    );
    assert!(matches!(
        &content[2],
        domain::ToolContent::Diff { old_text: None, .. }
    ));
    assert!(
        matches!(&content[3], domain::ToolContent::TerminalReference { id } if id.as_str() == "terminal:1")
    );
    assert!(
        matches!(&content[4], domain::ToolContent::ResourceText { text, .. } if text == "context")
    );
    assert!(
        matches!(&content[5], domain::ToolContent::ResourceLink { name, .. } if name == "reference")
    );
    assert!(matches!(
        &content[6],
        domain::ToolContent::Unsupported {
            kind: domain::UnsupportedToolContent::Image
        }
    ));
    assert!(matches!(
        &content[7],
        domain::ToolContent::Unsupported {
            kind: domain::UnsupportedToolContent::Unknown
        }
    ));
    let serialized = serde_json::to_string(&update).unwrap();
    assert!(
        !serialized.contains("PRIVATE_"),
        "opaque/raw/binary payload must stay out of domain"
    );
}
#[test]
fn tool_v1_patch_semantics_distinguish_empty_from_omitted_or_null_and_ignore_unknown_kind() {
    let mut details = domain::ToolDetails::default();
    map(json!({"sessionUpdate":"tool_call_update","toolCallId":"call","kind":"read","name":"read_file","content":[{"type":"content","content":{"type":"text","text":"retained"}}],"locations":[{"path":"/display/file","line":7}]})).details.apply(&mut details);
    let original = details.clone();
    for raw in [
        json!({"sessionUpdate":"tool_call_update","toolCallId":"call","status":"completed"}),
        json!({"sessionUpdate":"tool_call_update","toolCallId":"call","kind":"future_kind","name":null,"content":null,"locations":null}),
    ] {
        map(raw).details.apply(&mut details);
        assert_eq!(details, original);
    }
    map(json!({"sessionUpdate":"tool_call_update","toolCallId":"call","content":[],"locations":[],"name":""})).details.apply(&mut details);
    assert!(details.content.is_empty() && details.locations.is_empty());
    assert_eq!(details.kind, Some(domain::ToolKind::Read));
    assert_eq!(details.name.as_deref(), Some(""));
}
#[test]
fn malformed_known_tool_content_and_locations_fail_validation_but_unknown_content_is_explicit() {
    for fields in [
        json!({"content":[{"type":"diff","path":"/p"}]}),
        json!({"content":[{"type":"terminal","terminalId":""}]}),
        json!({"content":[{"type":"content","content":{"type":"image","data":"x"}}]}),
        json!({"locations":[{"path":"/p","line":-1}]}),
        json!({"locations":[{"path":"/p","line":4294967296u64}]}),
        json!({"content":{}}),
    ] {
        let mut raw = json!({"sessionUpdate":"tool_call_update","toolCallId":"call"});
        raw.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        assert!(decode_update(raw).is_err());
    }
    let update = map(
        json!({"sessionUpdate":"tool_call_update","toolCallId":"call","content":[{"type":"new_content","anything":[1,2,3]}]}),
    );
    assert!(matches!(
        &update.details.content.unwrap()[0],
        domain::ToolContent::Unsupported {
            kind: domain::UnsupportedToolContent::Unknown
        }
    ));
}
