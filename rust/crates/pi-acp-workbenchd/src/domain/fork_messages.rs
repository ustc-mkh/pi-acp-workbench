use super::ForkRole;
use crate::domain::{
    transcript::{EntryRole, TranscriptEntry},
    ProviderMessageId, TurnId,
};
use std::collections::BTreeMap;

pub(super) struct MessageSpan {
    pub start: usize,
    pub end: usize,
    pub role: ForkRole,
    pub text: String,
}
struct Group {
    span: MessageSpan,
    contiguous: bool,
    ends_in_text: bool,
}

/// Build complete visible message candidates without changing immutable delta
/// rows. Opaque stream IDs only group adjacent deltas within the SAME turn;
/// they are never native entry IDs/timestamps. The caller must establish idle
/// state and match the entire text against fresh safe native prefix evidence.
pub(super) fn messages(entries: &[TranscriptEntry]) -> Vec<MessageSpan> {
    let mut result = Vec::new();
    let mut groups: BTreeMap<(TurnId, ProviderMessageId), Group> = BTreeMap::new();
    let mut legacy: BTreeMap<TurnId, (usize, usize)> = BTreeMap::new();
    let mut agent_counts: BTreeMap<TurnId, usize> = BTreeMap::new();
    for (index, entry) in entries.iter().enumerate() {
        if matches!(entry.role, EntryRole::Agent) {
            *agent_counts.entry(entry.turn.clone()).or_default() += 1;
        }
        if matches!(entry.role, EntryRole::User) {
            result.push(MessageSpan {
                start: index,
                end: index,
                role: ForkRole::User,
                text: entry.text.clone(),
            });
            continue;
        }
        if !matches!(entry.role, EntryRole::Agent | EntryRole::Thought) {
            continue;
        }
        let Some(id) = &entry.message else {
            if matches!(entry.role, EntryRole::Agent) {
                let count = legacy.entry(entry.turn.clone()).or_insert((index, 0));
                count.1 += 1;
            }
            continue;
        };
        let key = (entry.turn.clone(), id.clone());
        let is_text = matches!(entry.role, EntryRole::Agent);
        match groups.entry(key) {
            std::collections::btree_map::Entry::Vacant(slot) => {
                slot.insert(Group {
                    span: MessageSpan {
                        start: index,
                        end: index,
                        role: ForkRole::Agent,
                        text: if is_text {
                            entry.text.clone()
                        } else {
                            String::new()
                        },
                    },
                    contiguous: true,
                    ends_in_text: is_text,
                });
            }
            std::collections::btree_map::Entry::Occupied(mut slot) => {
                let group = slot.get_mut();
                group.contiguous &= group.span.end + 1 == index;
                group.span.end = index;
                group.ends_in_text = is_text;
                if is_text {
                    group.span.text.push_str(&entry.text);
                }
            }
        }
    }
    for group in groups.into_values() {
        if group.contiguous && group.ends_in_text {
            result.push(group.span);
        }
    }
    // Without grouping evidence, multiple assistant rows in one turn remain
    // ambiguous, even when some other rows in that turn carry stream IDs.
    for (turn, (index, count)) in legacy {
        if count == 1 && agent_counts[&turn] == 1 {
            result.push(MessageSpan {
                start: index,
                end: index,
                role: ForkRole::Agent,
                text: entries[index].text.clone(),
            });
        }
    }
    result
}
