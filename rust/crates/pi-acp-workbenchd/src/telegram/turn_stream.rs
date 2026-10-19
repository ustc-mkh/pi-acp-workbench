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

pub struct TurnStream {
    delivery: DeliveryId,
    turn: TurnId,
    topic: TopicKey,
    after: SafeInteger,
    more: bool,
    page: VecDeque<EntryHeader>,
    current: Option<TextCursor>,
    image: Option<ImageRef>,
    previous_message: Option<ProviderMessageId>,
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
            delivery,
            turn,
            topic,
            after: SafeInteger::default(),
            more: true,
            page: VecDeque::new(),
            current: None,
            image: None,
            previous_message: None,
            text_since_image: false,
            separator: 0,
            fragment: String::new(),
            units: 0,
            emitted: false,
            finished: false,
        }
    }
    fn flush(&mut self) -> DeliveryPart {
        self.units = 0;
        self.emitted = true;
        DeliveryPart::Message(SendMessage {
            chat_id: self.topic.chat,
            message_thread_id: self.topic.thread,
            text: std::mem::take(&mut self.fragment),
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
                if let Some(next) = page.next_seq {
                    if next <= self.after || page.entries.is_empty() {
                        return Err(DomainError::Persistence(
                            "delivery cursor did not advance".into(),
                        ));
                    }
                    self.after = next;
                }
                self.page = page.entries.into();
            }
            if let Some(header) = self.page.pop_front() {
                if header.turn != self.turn {
                    return Err(DomainError::Persistence(
                        "delivery turn/entry mismatch".into(),
                    ));
                }
                if header.image.is_none()
                    && self.text_since_image
                    && self.previous_message.is_some()
                    && header.message.is_some()
                    && self.previous_message != header.message
                {
                    self.separator = 2;
                }
                self.previous_message = header.message;
                self.current = Some(TextCursor::new(header.text));
                self.image = header.image;
                continue;
            }
            self.finished = true;
            if !self.fragment.is_empty() {
                return Ok(Some(self.flush()));
            }
            if !self.emitted {
                self.fragment = "Turn completed.".into();
                return Ok(Some(self.flush()));
            }
            return Ok(None);
        }
    }
}
