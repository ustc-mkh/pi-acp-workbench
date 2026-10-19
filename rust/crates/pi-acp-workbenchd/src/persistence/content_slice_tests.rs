use super::*;
#[test]
fn content_slice_reads_bounded_bytes_and_enforces_utf8_offsets_and_endings() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("schema.sql")).unwrap();
    let text = format!("{}🌏tail", "a".repeat(CONTENT_SLICE_BYTES - 1));
    let item = NewContent {
        content: ContentRef {
            id: crate::domain::ContentId::generate(),
            sha256: ContentHash::of(&text),
            bytes: SafeInteger::new(text.len() as u64).unwrap(),
            kind: ContentKind::Text,
        },
        text,
    };
    put_text(&db, &item).unwrap();
    let first = slice(&db, &item.content, SafeInteger::new(0).unwrap(), None).unwrap();
    assert_eq!(first.text.len(), CONTENT_SLICE_BYTES - 1);
    let offset = first.next_offset.unwrap();
    let last = slice(&db, &item.content, offset, None).unwrap();
    assert_eq!(last.text, "🌏tail");
    assert!(last.next_offset.is_none());
    assert_eq!(format!("{}{}", first.text, last.text), item.text);
    assert!(slice(&db, &item.content, offset.next().unwrap(), None).is_err());
    assert!(matches!(
        slice(&db, &item.content, offset, Some(1)),
        Err(StoreError::Query(QueryError::TooLarge))
    ));
    let eof = slice(&db, &item.content, item.content.bytes, None).unwrap();
    assert!(eof.text.is_empty());
    assert!(eof.next_offset.is_none());
    assert!(slice(&db, &item.content, item.content.bytes.next().unwrap(), None).is_err());
    let mut bad = item.content.clone();
    bad.sha256 = ContentHash::of("wrong");
    assert!(slice(&db, &bad, SafeInteger::default(), None).is_err());
    // A slice validates the full descriptor/length but does not falsely claim
    // to rehash the entire body. Archive readers still perform whole validation.
    let mut poisoned = item.text.as_bytes().to_vec();
    *poisoned.last_mut().unwrap() = 0xff;
    db.execute(
        "UPDATE contents SET data=?2 WHERE id=?1",
        params![item.content.id.as_str(), poisoned],
    )
    .unwrap();
    assert!(slice(&db, &item.content, SafeInteger::default(), None).is_ok());
    assert!(read_text(&db, &item.content).is_err());
}
