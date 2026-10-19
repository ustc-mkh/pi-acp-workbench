use super::*;
use crate::domain::{
    fork::oracle::OracleHistory,
    fork::{self, ForkTarget, PrefixHash},
    query::SessionView,
    transcript::TranscriptEntry,
    EntryId, ProviderMessageId, ProviderSessionId, TurnId,
};
fn fixture() -> OracleHistory {
    let mut view = crate::domain::tests::state();
    view.provider_session = Some(ProviderSessionId::new("native-source").unwrap());
    view.revision = SafeInteger::new(7).unwrap();
    OracleHistory::new(view)
}
fn append(
    state: &mut OracleHistory,
    turn: usize,
    message: Option<usize>,
    role: EntryRole,
    text: &str,
) {
    state.transcript.entries.push(TranscriptEntry {
        id: EntryId::generate(),
        turn: TurnId::new(format!("turn-{turn}")).unwrap(),
        role,
        text: text.into(),
        message: message.map(|m| ProviderMessageId::new(format!("message-{m}")).unwrap()),
        image: None,
    });
}
fn seed(state: &OracleHistory) -> (Connection, SessionView) {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("schema.sql")).unwrap();
    let view = state.hot_view();
    query::insert_view(&db, &view).unwrap();
    for (index, entry) in state.transcript.entries.iter().enumerate() {
        let row = crate::domain::transition::NewEntry {
            id: entry.id.clone(),
            turn: entry.turn.clone(),
            role: entry.role.clone(),
            message: entry.message.clone(),
            text: super::super::payload::entry_content(entry).unwrap(),
            image: None,
        };
        content::put_entry(&db, &row).unwrap();
        db.execute(
            "INSERT INTO session_entries VALUES (?1,?2,?3)",
            params![state.id.as_str(), index as i64 + 1, entry.id.as_str()],
        )
        .unwrap();
    }
    (db, view)
}
fn compare(state: &OracleHistory) {
    let (mut db, view) = seed(state);
    // Every row and several full-group digests, including ambiguous native keys.
    let mut texts = vec![
        "a".to_string(),
        "b".to_string(),
        "ab".to_string(),
        "aa".to_string(),
        "answer".to_string(),
    ];
    texts.extend(state.transcript.entries.iter().map(|r| r.text.clone()));
    texts.sort();
    texts.dedup();
    for text in texts {
        for role in [ForkRole::User, ForkRole::Agent] {
            let point = ForkCandidate {
                target: ForkTarget {
                    entry: crate::domain::ProviderEntryId::new("native-entry").unwrap(),
                    prefix: PrefixHash::new("a".repeat(64)).unwrap(),
                },
                role,
                text: ContentHash::of(&text),
                safe: true,
            };
            for row in &state.transcript.entries {
                let request = ForkRequest {
                    entry: row.id.clone(),
                };
                let expected = fork::prepare(state, &request, std::slice::from_ref(&point));
                let actual = prepare(&db, &view, &request, std::slice::from_ref(&point));
                assert_eq!(
                    expected.is_ok(),
                    actual.is_ok(),
                    "text={text:?} row={:?} expected={:?} actual={:?}",
                    row,
                    expected,
                    actual
                );
                if let (Ok(expected), Ok(actual)) = (expected, actual) {
                    assert_eq!(expected.target, actual.target);
                    assert_eq!(
                        actual.entry_seq.get() as usize,
                        expected.snapshot.transcript.entries.len()
                    );
                    let (branch, _) =
                        adopt(&mut db, actual, ProviderSessionId::generate()).unwrap();
                    assert!(branch.config.model.is_none());
                    assert!(branch.catalogue.models.is_empty());
                    assert_eq!(
                        branch.last_entry_seq.get() as usize,
                        expected.snapshot.transcript.entries.len()
                    );
                }
            }
        }
    }
}
#[test]
fn streaming_fork_matches_vector_oracle_on_generated_group_reuse_and_ambiguity() {
    for seed in 0..48 {
        let mut state = fixture();
        let mut random = seed as u64 + 1;
        for _ in 0..6 {
            random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
            let role = match (random >> 32) % 3 {
                0 => EntryRole::User,
                1 => EntryRole::Agent,
                _ => EntryRole::Thought,
            };
            append(
                &mut state,
                ((random >> 36) % 2) as usize,
                match (random >> 40) % 3 {
                    0 => None,
                    n => Some(n as usize),
                },
                role,
                if random & 1 == 0 { "a" } else { "b" },
            );
        }
        compare(&state);
    }
    let mut state = fixture();
    append(&mut state, 0, None, EntryRole::User, "question");
    append(
        &mut state,
        0,
        Some(1),
        EntryRole::Thought,
        "ignored thought",
    );
    append(&mut state, 0, Some(1), EntryRole::Agent, "a");
    append(&mut state, 0, Some(1), EntryRole::Agent, "b");
    compare(&state);
    append(&mut state, 1, Some(2), EntryRole::Agent, "ab");
    compare(&state);
}

#[test]
fn streaming_fork_large_groups_have_small_plans_and_adoption_is_atomic() {
    let mut state = fixture();
    append(&mut state, 0, None, EntryRole::User, "earlier question");
    append(&mut state, 0, None, EntryRole::Agent, "earlier answer");
    append(&mut state, 1, None, EntryRole::User, "question");
    let text = "🌏a".repeat(200_000);
    append(&mut state, 1, Some(1), EntryRole::Agent, &text);
    append(
        &mut state,
        1,
        Some(1),
        EntryRole::Thought,
        "not sent to native",
    );
    append(&mut state, 1, Some(1), EntryRole::Agent, "tail");
    let last = state.transcript.entries.last().unwrap();
    let point = ForkCandidate {
        target: ForkTarget {
            entry: crate::domain::ProviderEntryId::new("native-entry").unwrap(),
            prefix: PrefixHash::new("a".repeat(64)).unwrap(),
        },
        role: ForkRole::Agent,
        text: ContentHash::of(&format!("{text}tail")),
        safe: true,
    };
    let request = ForkRequest {
        entry: last.id.clone(),
    };
    let (mut db, view) = seed(&state);
    let plan = prepare(&db, &view, &request, std::slice::from_ref(&point)).unwrap();
    assert!(encode(&plan).unwrap().len() < 2048);
    assert!(prepare(&db, &view, &request, &[point.clone(), point.clone()]).is_err());
    let mut stale = plan.clone();
    stale.revision = stale.revision.next().unwrap();
    assert!(adopt(&mut db, stale, ProviderSessionId::generate()).is_err());
    assert!(adopt(&mut db, plan.clone(), plan.scope.native.clone()).is_err());
    db.execute_batch(&format!("CREATE TRIGGER fail_fork BEFORE INSERT ON session_entries WHEN NEW.session <> '{}' BEGIN SELECT RAISE(ABORT,'injected failure'); END;", state.id.as_str())).unwrap();
    assert!(adopt(&mut db, plan.clone(), ProviderSessionId::generate()).is_err());
    assert_eq!(
        db.query_row("SELECT count(*) FROM sessions", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(matches!(
        query::view(&db, &plan.new_session_id),
        Err(StoreError::NotFound)
    ));
    db.execute_batch("DROP TRIGGER fail_fork").unwrap();
    let (branch, _) = adopt(&mut db, plan, ProviderSessionId::generate()).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM entries", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        6
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM contents", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        6
    );
    assert_eq!(branch.last_entry_seq.get(), 6);
    super::super::query::remove(&mut db, &state.id, None).unwrap();
    let page = query::history(&db, &branch.id, None, Some(200)).unwrap();
    assert_eq!(page.entries.len(), 6);
    assert!(matches!(&page.entries[3].text, TextBody::Archived { .. }));
}
