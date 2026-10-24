//! Frozen turn rendering retains one bounded page, one content slice and one
//! UTF-16 limited output fragment, regardless of the size of the turn.
use super::{api::SendMessage, render::DeliveryPart, types::TopicKey};
use crate::{
    domain::{
        error::DomainError,
        image::ImageRef,
        query::{EntryHeader, SafeInteger, TextBody},
        DeliveryId, ProviderMessageId, TurnId,
    },
    persistence::payload::PayloadStore,
};
use std::collections::VecDeque;

struct TextCursor {
    reference: Option<crate::domain::query::ContentRef>,
    next: Option<SafeInteger>,
    buffer: String,
    position: usize,
}
impl TextCursor {
    fn new(body: TextBody) -> Self {
        match body {
            TextBody::Inline { text } => Self {
                reference: None,
                next: None,
                buffer: text,
                position: 0,
            },
            TextBody::Archived { content } => Self {
                reference: Some(content),
                next: Some(SafeInteger::default()),
                buffer: String::new(),
                position: 0,
            },
        }
    }
    async fn peek(&mut self, payloads: &PayloadStore) -> Result<Option<char>, DomainError> {
        if self.position == self.buffer.len() {
            let Some(next) = self.next.take() else {
                return Ok(None);
            };
            let page = payloads
                .content_slice(self.reference.as_ref().expect("archived cursor"), next)
                .await?;
            self.buffer = page.text;
            self.position = 0;
            self.next = page.next_offset;
        }
        Ok(self.buffer[self.position..].chars().next())
    }
}

struct HistoryItem {
    text: TextCursor,
    image: Option<ImageRef>,
}
pub struct HistoryStream {
    topic: TopicKey,
    prefix: Option<String>,
    remaining: VecDeque<HistoryItem>,
    current: Option<HistoryItem>,
}
impl HistoryStream {
    pub async fn new(
        payloads: &PayloadStore,
        bot: i64,
        topic: TopicKey,
        session: &crate::domain::SessionId,
        entry: &crate::domain::EntryId,
        seq: SafeInteger,
    ) -> Result<Self, DomainError> {
        Self::new_group(payloads, bot, topic, session, &[(entry.clone(), seq)]).await
    }
    pub async fn new_group(
        payloads: &PayloadStore,
        bot: i64,
        topic: TopicKey,
        session: &crate::domain::SessionId,
        entries: &[(crate::domain::EntryId, SafeInteger)],
    ) -> Result<Self, DomainError> {
        use crate::domain::transcript::EntryRole;
        let mut items = VecDeque::new();
        let mut first: Option<(
            crate::domain::transcript::EntryRole,
            Option<ProviderMessageId>,
        )> = None;
        for (entry, seq) in entries {
            let header = payloads.entry_header(entry).await?;
            if header.role == EntryRole::Thought
                || (header.role == EntryRole::Tool && header.image.is_none())
            {
                return Err(DomainError::Persistence(
                    "invalid history export role".into(),
                ));
            }
            if let Some((role, message)) = &first {
                if *role != header.role || message.is_none() || message != &header.message {
                    return Err(DomainError::Persistence(
                        "invalid provider message grouping".into(),
                    ));
                }
            } else {
                first = Some((header.role.clone(), header.message.clone()));
            }
            if matches!(header.role, EntryRole::Agent | EntryRole::User)
                && payloads
                    .automatic_delivered(bot, &topic, session, entry, *seq, &header.turn)
                    .await?
            {
                continue;
            }
            let body = if header.role == EntryRole::Tool {
                TextBody::Inline {
                    text: String::new(),
                }
            } else {
                header.text
            };
            items.push_back(HistoryItem {
                text: TextCursor::new(body),
                image: header.image,
            });
        }
        let first_seq = entries.first().map(|(_, seq)| *seq).unwrap_or_default();
        let prefix = (!items.is_empty()).then(|| {
            format!(
                "History · session {session} · #{} · {:?} · bounded message segment through #{} (may continue across batches; /history all resumes without discarding the tail)",
                first_seq.get(),
                first
                    .as_ref()
                    .map(|(role, _)| role)
                    .unwrap_or(&EntryRole::Agent),
                entries.last().map_or(first_seq, |(_, seq)| *seq).get()
            )
        });
        Ok(Self {
            topic,
            prefix,
            remaining: items,
            current: None,
        })
    }
    pub fn into_input(mut self, session: &crate::domain::SessionId) -> Self {
        if self.prefix.is_some() {
            self.prefix = Some(format!("User input · session {session}"));
        }
        self
    }
    pub async fn next(
        &mut self,
        payloads: &PayloadStore,
    ) -> Result<Option<DeliveryPart>, DomainError> {
        if let Some(prefix) = self.prefix.take() {
            return Ok(Some(DeliveryPart::Message(SendMessage {
                chat_id: self.topic.chat,
                message_thread_id: self.topic.thread,
                text: prefix,
                disable_notification: false,
                reply_markup: None,
            })));
        }
        let mut fragment = String::new();
        let mut units = 0;
        loop {
            if self.current.is_none() {
                self.current = self.remaining.pop_front();
            }
            let Some(current) = self.current.as_mut() else {
                if fragment.is_empty() {
                    return Ok(None);
                }
                break;
            };
            if let Some(ch) = current.text.peek(payloads).await? {
                let width = ch.len_utf16();
                if units + width > 4000 {
                    break;
                }
                fragment.push(ch);
                units += width;
                current.text.position += ch.len_utf8();
                continue;
            }
            if current.image.is_some() {
                if !fragment.is_empty() {
                    break;
                }
                let image = current.image.take().expect("checked image");
                self.current = None;
                return Ok(Some(DeliveryPart::Image {
                    topic: self.topic.clone(),
                    image,
                }));
            }
            self.current = None;
        }
        if !fragment.is_empty() {
            return Ok(Some(DeliveryPart::Message(SendMessage {
                chat_id: self.topic.chat,
                message_thread_id: self.topic.thread,
                text: fragment,
                disable_notification: false,
                reply_markup: None,
            })));
        }
        Ok(None)
    }
}

pub struct TurnStream {
    history_scope: Option<(i64, crate::domain::SessionId)>,
    history_skipped: bool,
    completion: Option<String>,
    completion_emitted: bool,
    delivery: DeliveryId,
    turn: TurnId,
    topic: TopicKey,
    after: SafeInteger,
    more: bool,
    page: VecDeque<EntryHeader>,
    current: Option<TextCursor>,
    image: Option<ImageRef>,
    previous_entry: Option<EntryHeader>,
    text_since_image: bool,
    separator: u8,
    fragment: String,
    units: usize,
    emitted: bool,
    finished: bool,
}
impl TurnStream {
    pub fn new(delivery: DeliveryId, turn: TurnId, topic: TopicKey) -> Self {
        Self {
            history_scope: None,
            history_skipped: false,
            completion: None,
            completion_emitted: false,
            delivery,
            turn,
            topic,
            after: SafeInteger::default(),
            more: true,
            page: VecDeque::new(),
            current: None,
            image: None,
            previous_entry: None,
            text_since_image: false,
            separator: 0,
            fragment: String::new(),
            units: 0,
            emitted: false,
            finished: false,
        }
    }
    pub fn with_history_scope(mut self, bot: i64, session: crate::domain::SessionId) -> Self {
        self.history_scope = Some((bot, session));
        self
    }
    fn flush(&mut self) -> DeliveryPart {
        self.units = 0;
        self.emitted = true;
        DeliveryPart::Message(SendMessage {
            chat_id: self.topic.chat,
            message_thread_id: self.topic.thread,
            text: std::mem::take(&mut self.fragment),
            disable_notification: false,
            reply_markup: None,
        })
    }
    pub async fn next(
        &mut self,
        payloads: &PayloadStore,
    ) -> Result<Option<DeliveryPart>, DomainError> {
        if self.finished {
            return Ok(None);
        }
        loop {
            if self.image.is_some() {
                if !self.fragment.is_empty() {
                    return Ok(Some(self.flush()));
                }
                self.emitted = true;
                self.text_since_image = false;
                return Ok(Some(DeliveryPart::Image {
                    topic: self.topic.clone(),
                    image: self.image.take().expect("pending image"),
                }));
            }
            if self.separator > 0 {
                if self.units == 4000 {
                    return Ok(Some(self.flush()));
                }
                self.fragment.push('\n');
                self.units += 1;
                self.separator -= 1;
                self.text_since_image = true;
                continue;
            }
            if let Some(current) = &mut self.current {
                match current.peek(payloads).await? {
                    Some(ch) => {
                        let width = ch.len_utf16();
                        if self.units + width > 4000 {
                            return Ok(Some(self.flush()));
                        }
                        self.fragment.push(ch);
                        self.units += width;
                        self.text_since_image = true;
                        current.position += ch.len_utf8();
                        continue;
                    }
                    None => self.current = None,
                }
            }
            if self.page.is_empty() && self.more {
                let page = payloads.delivery_page(&self.delivery, self.after).await?;
                self.more = page.next_seq.is_some();
                if page.completion.is_some() {
                    self.completion = page.completion;
                }
                if let Some(next) = page.next_seq {
                    if next <= self.after || page.entries.is_empty() {
                        return Err(DomainError::Persistence(
                            "delivery cursor did not advance".into(),
                        ));
                    }
                    self.after = next;
                }
                self.page = page.entries.into();
                if let Some((bot, session)) = &self.history_scope {
                    if self.page.iter().any(|header| header.turn != self.turn) {
                        return Err(DomainError::Persistence(
                            "delivery turn/entry mismatch".into(),
                        ));
                    }
                    let ids = self
                        .page
                        .iter()
                        .map(|header| {
                            crate::persistence::payload::history_delivery_id(
                                *bot,
                                &self.topic,
                                session,
                                &header.id,
                            )
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    let seen = payloads.history_delivered(ids).await?;
                    let original = std::mem::take(&mut self.page);
                    for (header, seen) in original.into_iter().zip(seen) {
                        if seen {
                            self.history_skipped = true;
                        } else {
                            self.page.push_back(header);
                        }
                    }
                    if self.page.is_empty() && self.more {
                        continue;
                    }
                }
            }
            if let Some(header) = self.page.pop_front() {
                if header.turn != self.turn {
                    return Err(DomainError::Persistence(
                        "delivery turn/entry mismatch".into(),
                    ));
                }
                if header.image.is_none()
                    && self.text_since_image
                    && !self
                        .previous_entry
                        .as_ref()
                        .is_some_and(|previous| previous.continues_message(&header))
                {
                    self.separator = 2;
                }
                self.previous_entry = Some(header.clone());
                self.current = Some(TextCursor::new(header.text));
                self.image = header.image;
                continue;
            }
            if !self.fragment.is_empty() {
                return Ok(Some(self.flush()));
            }
            if let Some(mut summary) = self.completion.take() {
                if self.history_skipped && !self.emitted {
                    summary.push_str(" Output already exported in this topic.");
                }
                self.completion_emitted = true;
                return Ok(Some(DeliveryPart::Message(SendMessage {
                    chat_id: self.topic.chat,
                    message_thread_id: self.topic.thread,
                    text: summary,
                    disable_notification: false,
                    reply_markup: None,
                })));
            }
            self.finished = true;
            if !self.emitted && !self.completion_emitted {
                self.fragment = if self.history_skipped {
                    "Turn completed. Output already exported in this topic."
                } else {
                    "Turn completed."
                }
                .into();
                return Ok(Some(self.flush()));
            }
            return Ok(None);
        }
    }
}
