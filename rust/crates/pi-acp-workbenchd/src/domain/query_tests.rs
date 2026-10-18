use super::{fork::ContentHash, query::*, ContentId};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    version: ProtocolVersion,
    summary: SessionSummary,
    view: SessionView,
    entries: Vec<EntryHeader>,
    tools: Vec<ToolHeader>,
    receipts: Vec<CommandReceipt>,
}
fn fixture() -> Fixture {
    serde_json::from_str(include_str!(
        "../../../../../test/fixtures/rewrite/ipc-v3.json"
    ))
    .unwrap()
}
fn content(text: &str) -> ContentRef {
    ContentRef {
        id: ContentId::new("content-test").unwrap(),
        sha256: ContentHash::of(text),
        bytes: SafeInteger::new(text.len() as u64).unwrap(),
        kind: ContentKind::Text,
    }
}
#[test]
fn query_fixture_contracts_and_receipts_have_no_history() {
    let f = fixture();
    assert_eq!(u32::from(f.version), 3);
    f.view.validate().unwrap();
    for entry in &f.entries {
        entry.text.validate().unwrap();
    }
    for tool in &f.tools {
        tool.validate().unwrap();
    }
    for receipt in &f.receipts {
        receipt.validate().unwrap();
        let wire = String::from_utf8(json_bytes(receipt, MAX_QUERY_BYTES).unwrap()).unwrap();
        assert!(!wire.contains("transcript"));
        assert!(!wire.contains("67108864"));
    }
    let loaded = CommandReceipt::Loaded {
        view: Box::new(f.view.clone()),
    };
    loaded.validate().unwrap();
    let summary = serde_json::to_string(&f.summary).unwrap();
    assert!(!summary.contains("catalogue"));
    assert!(!summary.contains("text"));
    let batch = CommitBatch {
        session: f.summary.id,
        revision: f.view.revision,
        view: Some(f.view),
        entries: f.entries,
        tools: f.tools,
        removed: false,
    };
    batch.validate().unwrap();
}
#[test]
fn query_text_inline_threshold_is_utf8_bytes_and_always_uses_verified_ref() {
    let text = "🌏".repeat(INLINE_TEXT_BYTES / 4);
    assert!(matches!(
        TextBody::from_text(&text, content(&text)).unwrap(),
        TextBody::Inline { .. }
    ));
    let long = text + "中";
    let archived = TextBody::from_text(&long, content(&long)).unwrap();
    assert!(matches!(archived, TextBody::Archived { .. }));
    assert!(json_bytes(&archived, 512).is_ok());
    assert!(TextBody::Inline { text: long.clone() }.validate().is_err());
    let mut wrong = content(&long);
    wrong.bytes = SafeInteger::default();
    assert!(TextBody::from_text(&long, wrong).is_err());
    let mut wrong = content(&long);
    wrong.sha256 = ContentHash::of("different");
    assert!(TextBody::from_text(&long, wrong).is_err());
}
#[test]
fn query_actual_serialized_bytes_include_unicode_and_json_escaping() {
    let text = "中🌏\n\"\\\u{0}".repeat(100);
    let encoded = serde_json::to_vec(&text).unwrap();
    assert!(encoded.len() > text.len());
    assert_eq!(json_bytes(&text, encoded.len()).unwrap(), encoded);
    assert_eq!(
        json_bytes(&text, encoded.len() - 1).unwrap_err(),
        QueryError::TooLarge
    );
}
#[test]
fn query_safe_integer_version_and_limits_reject_overflow() {
    assert!(SafeInteger::new(MAX_SAFE_INTEGER).is_ok());
    assert!(SafeInteger::new(MAX_SAFE_INTEGER).unwrap().next().is_err());
    for wire in ["-1", "1.5", "9007199254740992", "18446744073709551615"] {
        assert!(serde_json::from_str::<SafeInteger>(wire).is_err());
    }
    assert!(serde_json::from_str::<ProtocolVersion>("2").is_err());
    let v2 = r#"{"version":2,"id":1,"command":{"method":"inspect","session":"session-1"}}"#;
    assert!(serde_json::from_str::<QueryRequest>(v2).is_err());
    let v3 = v2.replace("\"version\":2", "\"version\":3");
    serde_json::from_str::<QueryRequest>(&v3)
        .unwrap()
        .command
        .validate()
        .unwrap();
    assert_eq!(limit(None, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT).unwrap(), 50);
    assert!(limit(Some(0), DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT).is_err());
    assert!(limit(Some(101), DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT).is_err());
    assert_eq!(
        limit(None, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT).unwrap(),
        100
    );
    assert!(limit(Some(201), DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT).is_err());
}
#[test]
fn query_cursor_scope_slice_and_page_limits_are_enforced() {
    for json in [
        r#"{"method":"list","limit":101}"#,
        r#"{"method":"list","cursor":{"version":3,"max_created_seq":10,"before_seq":11}}"#,
        r#"{"method":"history","session":"s","cursor":{"version":3,"session":"other","max_entry_seq":10,"before_seq":5}}"#,
        r#"{"method":"history","session":"s","limit":201}"#,
        r#"{"method":"tools","session":"s","turn":"t","cursor":{"version":3,"session":"s","turn":"other","after_tool":"tool"}}"#,
    ] {
        assert!(serde_json::from_str::<QueryCommand>(json)
            .unwrap()
            .validate()
            .is_err());
    }
    let mut query = QueryCommand::Content {
        r#ref: content("text"),
        offset: SafeInteger::new(5).unwrap(),
        length: None,
    };
    assert!(query.validate().is_err());
    if let QueryCommand::Content { offset, length, .. } = &mut query {
        *offset = SafeInteger::default();
        *length = Some(CONTENT_SLICE_BYTES + 1);
    }
    assert!(query.validate().is_err());
    let f = fixture();
    let row = f.entries[0].clone();
    assert!(HistoryPage {
        entries: vec![row.clone(); 201],
        next_cursor: None
    }
    .validate()
    .is_err());
    let escaped = EntryHeader {
        text: TextBody::Inline {
            text: "\\".repeat(INLINE_TEXT_BYTES),
        },
        ..row
    };
    assert!(HistoryPage {
        entries: vec![escaped; 100],
        next_cursor: None
    }
    .validate()
    .is_err());
    assert!(ListPage {
        sessions: vec![f.summary; 101],
        next_cursor: None
    }
    .validate()
    .is_err());
    assert!(ToolPage {
        tools: vec![f.tools[0].clone(); 201],
        next_cursor: None
    }
    .validate()
    .is_err());
    let slice = ContentSlice {
        text: "x".repeat(CONTENT_SLICE_BYTES + 1),
        next_offset: None,
        sha256: ContentHash::of("x"),
        total_bytes: SafeInteger::new(MAX_CONTENT_BYTES as u64).unwrap(),
    };
    assert!(slice.validate().is_err());
}
#[test]
fn query_content_ref_rejects_path_url_bad_hash_unknown_kind_and_large_bytes() {
    let base = serde_json::to_value(content("text")).unwrap();
    for (key, bad) in [
        ("id", serde_json::json!("/etc/passwd")),
        ("id", serde_json::json!("https://example.com")),
        ("sha256", serde_json::json!("a".repeat(63))),
        ("kind", serde_json::json!("Path")),
        ("bytes", serde_json::json!(MAX_CONTENT_BYTES + 1)),
        ("bytes", serde_json::json!(-1)),
    ] {
        let mut v = base.clone();
        v[key] = bad;
        assert!(serde_json::from_value::<ContentRef>(v).is_err());
    }
    let mut v = base;
    v["path"] = serde_json::json!("/tmp/private");
    assert!(serde_json::from_value::<ContentRef>(v).is_err());
    // An immutable maximum-size row must fit as a ref, not be silently omitted.
    let f = fixture();
    assert!(matches!(f.entries[1].text, TextBody::Archived { .. }));
    assert!(json_bytes(&f.entries[1], 1024).is_ok());
}
#[test]
fn query_pending_interaction_budget_and_safe_expiry() {
    let mut f = fixture();
    let mut item: super::interaction::Interaction = serde_json::from_str(r#"{"id":"i","kind":"Permission","title":"Allow?","detail":"","fields":[],"options":[{"id":"yes","label":"Yes"}],"expires_at":null}"#).unwrap();
    for n in 0..32 {
        item.id = super::InteractionId::new(format!("i-{n}")).unwrap();
        f.view
            .pending_interactions
            .insert(item.id.clone(), item.clone());
    }
    f.view.validate().unwrap();
    item.id = super::InteractionId::new("i-32").unwrap();
    f.view
        .pending_interactions
        .insert(item.id.clone(), item.clone());
    assert!(f.view.validate().is_err());
    f.view.pending_interactions.clear();
    f.view
        .pending_interactions
        .insert(super::InteractionId::new("wrong").unwrap(), item.clone());
    assert!(f.view.validate().is_err());
    f.view.pending_interactions.clear();
    item.expires_at = Some(MAX_SAFE_INTEGER + 1);
    f.view.pending_interactions.insert(item.id.clone(), item);
    assert!(f.view.validate().is_err());
}
#[test]
fn query_fixed_budget_values() {
    assert_eq!(MAX_FRAME_BYTES, 8_388_608);
    assert_eq!(MAX_QUERY_BYTES, 1_048_576);
    assert_eq!(MAX_VIEW_BYTES, 524_288);
    assert_eq!(INLINE_TEXT_BYTES, 16_384);
    assert_eq!(MAX_CONTENT_BYTES, 67_108_864);
    assert_eq!(CONTENT_SLICE_BYTES, 65_536);
    assert_eq!(super::image::MAX_IMAGE_BYTES, 4_194_304);
    assert_eq!((DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT), (50, 100));
    assert_eq!((DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT), (100, 200));
    assert_eq!(STORAGE_VERSION, 3);
    assert_eq!(MAX_PENDING_INTERACTIONS, 32);
}
#[test]
fn query_view_metadata_and_batch_budget_are_hard_errors_not_truncation() {
    let mut f = fixture();
    f.view
        .catalogue
        .commands
        .push(super::catalogue::AvailableCommand {
            name: "large".into(),
            description: "中".repeat(MAX_VIEW_BYTES),
            input_hint: None,
        });
    assert_eq!(f.view.validate().unwrap_err(), QueryError::TooLarge);
    f.tools[0].title = "\\".repeat(MAX_QUERY_BYTES);
    assert_eq!(f.tools[0].validate().unwrap_err(), QueryError::TooLarge);
    let f = fixture();
    let mut batch = CommitBatch {
        session: f.summary.id,
        revision: f.view.revision.next().unwrap(),
        view: Some(f.view),
        entries: vec![],
        tools: vec![],
        removed: false,
    };
    assert_eq!(batch.validate().unwrap_err(), QueryError::InvalidInput);
    batch.view = None;
    batch.removed = true;
    batch.entries = f.entries;
    assert_eq!(batch.validate().unwrap_err(), QueryError::InvalidInput);
}
