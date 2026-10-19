//! One bounded transaction: frozen request receipt + export cursor + existing
//! outbox intents. No body copies, extra sender or provider work.
use super::*;
use crate::{
    domain::{
        transition::{DeliveryIntent, DeliveryPayload},
        EntryId, NoticeId,
    },
    persistence::{
        inbox::HistoryExport,
        payload::{notice_content, notice_optional, NoticeContent},
        query,
    },
    telegram::command::ControlCommand,
};
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    text: String,
}

pub(super) fn reply(
    db: &Connection,
    bot: i64,
    offset: u64,
    request: HistoryExport,
    sync: Option<(usize, SafeInteger)>,
) -> Result<Output, DomainError> {
    let HistoryExport {
        topic,
        update,
        session,
        cwd,
        all,
    } = request;
    let mut statement = db
        .prepare(&format!(
            "SELECT {INBOX_COLUMNS} FROM telegram_inbox WHERE bot_id=?1 AND update_id=?2"
        ))
        .map_err(failure)?;
    let mut rows = statement
        .query(params![bot, safe(update.get())?])
        .map_err(failure)?;
    let admitted = record(
        db,
        bot,
        offset,
        rows.next()
            .map_err(failure)?
            .ok_or_else(|| failure("history inbox missing"))?,
    )?;
    let receipt_id = if let Some((limit, max_seq)) = sync {
        if all
            || admitted.command.topic.chat != topic.chat
            || !matches!(
                &admitted.command.action,
                TelegramAction::Control(ControlCommand::Sync { .. })
            )
        {
            return Err(DomainError::OperationConflict);
        }
        let plan = notice_optional(db, crate::telegram::sync::plan_id(update)?)
            .map_err(failure)?
            .ok_or_else(|| failure("sync plan missing"))?;
        let plan: crate::telegram::sync::Plan =
            serde_json::from_str(&plan.text).map_err(failure)?;
        if !plan.items.iter().any(|item| {
            item.session == session
                && item.limit == limit
                && item.max_seq == max_seq
                && cwd.as_ref().is_none_or(|cwd| cwd == &item.cwd)
        }) {
            return Err(DomainError::OperationConflict);
        }
        crate::telegram::sync::result_id(update, &session)?
    } else {
        if admitted.command.topic != topic
            || !matches!(&admitted.command.action, TelegramAction::Control(ControlCommand::History { session: original, all: original_all }) if original == &session && *original_all == all)
        {
            return Err(DomainError::OperationConflict);
        }
        NoticeId::new(format!("history-result-{}", update.get()))?
    };
    if let Some(saved) = notice_optional(db, receipt_id.clone()).map_err(failure)? {
        let receipt: Receipt = serde_json::from_str(&saved.text).map_err(failure)?;
        return Ok(Output::HistoryReply(receipt.text));
    }
    if binding(db, bot, &topic)?.as_ref() != Some(&session) {
        return Err(DomainError::OperationConflict);
    }
    let view = query::view(db, &session).map_err(failure)?;
    if cwd.as_ref() != Some(&view.cwd) {
        return Err(DomainError::OperationConflict);
    }
    let watermark = sync.map_or(view.last_entry_seq, |(_, max)| max);
    if watermark > view.last_entry_seq {
        return Err(DomainError::OperationConflict);
    }
    let args = params![
        bot,
        topic.chat.get(),
        topic.thread.map_or(0, |t| t.get()),
        session.as_str()
    ];
    let previous: Option<SafeInteger> = db.query_row("SELECT last_seq FROM telegram_history_cursors WHERE bot_id=?1 AND chat=?2 AND thread=?3 AND session=?4", args, |row| row.get(0)).optional().map_err(failure)?;
    let mut through = previous.unwrap_or_default();
    if through > view.last_entry_seq {
        return Err(failure("history cursor beyond source"));
    }
    let sql = if all {
        "SELECT se.seq,se.entry_id,e.role,e.image_id IS NOT NULL,e.turn,e.message FROM session_entries se JOIN entries e ON e.entry_id=se.entry_id WHERE se.session=?1 AND se.seq>?2 AND se.seq<=?3 ORDER BY se.seq LIMIT 200"
    } else {
        "SELECT se.seq,se.entry_id,e.role,e.image_id IS NOT NULL,e.turn,e.message FROM session_entries se JOIN entries e ON e.entry_id=se.entry_id WHERE se.session=?1 AND se.seq>?2 AND se.seq<=?3 ORDER BY se.seq DESC LIMIT 200"
    };
    let mut statement = db.prepare(sql).map_err(failure)?;
    let mut rows = statement
        .query(params![
            session.as_str(),
            if all { through } else { SafeInteger::default() },
            watermark
        ])
        .map_err(failure)?;
    let mut raw = vec![];
    let mut scanned = 0;
    while let Some(row) = rows.next().map_err(failure)? {
        let seq: SafeInteger = row.get(0).map_err(failure)?;
        if all {
            through = seq;
        }
        scanned += 1;
        let role: String = row.get(2).map_err(failure)?;
        let image: bool = row.get(3).map_err(failure)?;
        if role == "User" || role == "Agent" || (role == "Tool" && image) {
            raw.push((
                seq,
                EntryId::new(row.get::<_, String>(1).map_err(failure)?)?,
                if role == "Agent" || role == "User" {
                    Some(crate::domain::TurnId::new(
                        row.get::<_, String>(4).map_err(failure)?,
                    )?)
                } else {
                    None
                },
                role,
                row.get::<_, Option<String>>(5).map_err(failure)?,
            ));
        }
    }
    if all && scanned == 0 && through < view.last_entry_seq {
        return Err(failure("history cursor cannot advance"));
    }
    if !all {
        raw.reverse();
    }
    // A provider message ID is trustworthy grouping evidence only for adjacent
    // fragments with the same role. Missing IDs remain separate messages.
    type MessageGroup = (
        Vec<(EntryId, SafeInteger)>,
        Option<crate::domain::TurnId>,
        String,
        Option<String>,
    );
    let mut selected: Vec<MessageGroup> = vec![];
    let page_limit = sync.map_or(if all { 100 } else { 20 }, |(limit, _)| limit);
    for (seq, entry, turn, role, message) in raw {
        let can_join = message.is_some()
            && role != "Tool"
            && selected.last().is_some_and(|group| {
                group.2 == role
                    && group.3 == message
                    && group
                        .0
                        .last()
                        .is_some_and(|(_, previous_seq)| previous_seq.get() + 1 == seq.get())
            });
        if can_join {
            selected
                .last_mut()
                .expect("checked group")
                .0
                .push((entry, seq));
            continue;
        }
        if all && selected.len() == page_limit {
            break;
        }
        selected.push((vec![(entry, seq)], turn, role, message));
    }
    if !all && selected.len() > page_limit {
        selected.drain(..selected.len() - page_limit);
    }
    if all && selected.len() == page_limit {
        if let Some((entries, _, _, _)) = selected.last() {
            through = entries.last().expect("nonempty group").1;
        }
    }
    let mut queued = 0;
    for (entries, turn, _, _) in &selected {
        let (entry, seq) = entries.first().expect("history group nonempty");
        if let Some(turn) = turn {
            let mut delivered = true;
            for (member, member_seq) in entries {
                delivered &= crate::persistence::payload::automatic_delivered(
                    db,
                    bot,
                    &topic,
                    &session,
                    member,
                    *member_seq,
                    turn,
                )
                .map_err(failure)?;
            }
            if delivered {
                continue;
            }
        }
        let id = crate::persistence::payload::history_delivery_id(bot, &topic, &session, entry)?;
        let planned: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM telegram_history_exports WHERE export_id=?1)",
                [id.as_str()],
                |row| row.get(0),
            )
            .map_err(failure)?;
        if planned {
            continue;
        }
        if super::super::delivery::record(db, &id)
            .map_err(failure)?
            .is_none()
        {
            queued += 1;
        }
        query::put_delivery(
            db,
            &DeliveryIntent {
                id,
                revision: *seq,
                target: topic.delivery_target(bot, view.cwd.clone()),
                payload: DeliveryPayload::HistoryEntry {
                    session: session.clone(),
                    entries: entries.clone(),
                },
            },
        )
        .map_err(failure)?;
    }
    if all && through.get() > 0 {
        if previous.is_none() {
            let count: i64 = db.query_row("SELECT count(*) FROM (SELECT 1 FROM telegram_history_cursors WHERE bot_id=?1 LIMIT 4096)", [bot], |row| row.get(0)).map_err(failure)?;
            if count >= 4096 {
                return Err(DomainError::Backpressure);
            }
        }
        db.execute("INSERT INTO telegram_history_cursors(bot_id,chat,thread,session,last_seq) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(bot_id,chat,thread,session) DO UPDATE SET last_seq=excluded.last_seq", params![bot, topic.chat.get(), topic.thread.map_or(0, |t| t.get()), session.as_str(), through]).map_err(failure)?;
    }
    let text = format!("History export · session {session}\n{queued} new entries queued; {} eligible entries in this batch, {scanned} committed records examined (scan cap 200).\n{}\nUser/Agent text and images, plus tool images; no Thoughts or raw tool text. Entries already planned by explicit history are not queued again; completed automatic pushes in this same topic are also skipped. Full archived bodies stream in bounded parts. Transport remains at least once: partial/uncertain sends may repeat.", selected.len(), if all {
        if through < view.last_entry_seq { "More history remains. Repeat /history all to continue (up to 100 eligible entries per request)." } else { "Reached the committed history end for this request. Repeat /history all after new entries arrive." }
    } else { "Recent window: at most 20 eligible entries within the latest 200 committed records. /history all starts/resumes chronological batches from the beginning." });
    let receipt = NoticeContent {
        id: receipt_id,
        text: json(&Receipt { text: text.clone() })?,
    };
    super::super::content::put_text(db, &notice_content(&receipt).map_err(failure)?)
        .map_err(failure)?;
    Ok(Output::HistoryReply(text))
}
