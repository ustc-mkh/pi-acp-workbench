use super::{
    api::{InlineButton, InlineKeyboard, SendMessage},
    types::{CallbackBinding, CallbackKey, TopicKey},
};
use crate::{
    domain::error::DomainError,
    domain::{
        interaction::{
            FieldKind, FieldValue, Interaction, InteractionAnswer, InteractionKind,
            InteractionResponse,
        },
        plan::PlanStatus,
        SessionSnapshot,
    },
    persistence::{
        inbox::TelegramStore,
        outbox::{DeliveryEvent, DeliveryPayload},
        payload::PayloadStore,
    },
};
use std::collections::BTreeMap;

pub fn split_text(text: &str) -> Vec<String> {
    let mut result = vec![];
    let mut current = String::new();
    let mut units = 0;
    for character in text.chars() {
        let width = character.len_utf16();
        if units + width > 4000 {
            result.push(std::mem::take(&mut current));
            units = 0;
        }
        current.push(character);
        units += width;
    }
    if !current.is_empty() {
        result.push(current);
    }
    result
}
pub fn messages(topic: &TopicKey, text: &str) -> Vec<SendMessage> {
    split_text(text)
        .into_iter()
        .map(|text| SendMessage {
            chat_id: topic.chat,
            message_thread_id: topic.thread,
            text,
            reply_markup: None,
        })
        .collect()
}
/// Plan is deliberately rendered only by this explicit /status projection.
pub fn status(snapshot: &SessionSnapshot) -> String {
    let mut text = format!(
        "Session {}\n{:?} · {:?}\n{}\nModel: {}\nMode: {}\n",
        snapshot.id,
        snapshot.harness,
        snapshot.status,
        snapshot.cwd.as_str(),
        snapshot
            .config
            .model
            .as_ref()
            .map(|id| id.as_str())
            .unwrap_or("default"),
        snapshot
            .config
            .mode
            .as_ref()
            .map(|id| id.as_str())
            .unwrap_or("default")
    );
    if !snapshot.plan.items.is_empty() {
        text.push_str("\nPlan:\n");
        for item in &snapshot.plan.items {
            let marker = match item.status {
                PlanStatus::Pending => "○",
                PlanStatus::InProgress => "◐",
                PlanStatus::Completed => "✓",
                PlanStatus::Failed => "✗",
            };
            text.push_str(&format!("{marker} {}\n", item.description));
        }
    }
    if !snapshot.pending_interactions.is_empty() {
        text.push_str(&format!(
            "\nPending interactions: {}",
            snapshot.pending_interactions.len()
        ));
    }
    text
}
fn interaction_view(interaction: &Interaction) -> (String, Vec<(String, InteractionResponse)>) {
    let mut body = format!("{}\n{}\n", interaction.title, interaction.detail);
    let mut choices = vec![];
    if interaction.kind == InteractionKind::Permission {
        for option in &interaction.options {
            body.push_str(&format!("\n{}: {}", option.id, option.label));
            choices.push((
                option.label.clone(),
                InteractionResponse::Permission {
                    option: option.id.clone(),
                },
            ));
        }
    } else {
        for field in &interaction.fields {
            body.push_str(&format!(
                "\n{} ({}){}",
                field.label,
                field.name,
                if field.required { " *" } else { "" }
            ));
            match &field.kind {
                FieldKind::Choice { options, multiple } => {
                    for option in options {
                        body.push_str(&format!("\n  {}: {}", option.id, option.label));
                    }
                    if interaction.fields.len() == 1 && !multiple {
                        for option in options {
                            choices.push((
                                option.label.clone(),
                                InteractionResponse::Form {
                                    fields: BTreeMap::from([(
                                        field.name.clone(),
                                        FieldValue::Selected(vec![option.id.clone()]),
                                    )]),
                                },
                            ));
                        }
                    }
                }
                FieldKind::Boolean if interaction.fields.len() == 1 => {
                    for value in [true, false] {
                        choices.push((
                            value.to_string(),
                            InteractionResponse::Form {
                                fields: BTreeMap::from([(
                                    field.name.clone(),
                                    FieldValue::Boolean(value),
                                )]),
                            },
                        ));
                    }
                }
                FieldKind::Integer { min, max } => body.push_str(&format!(" [{min:?}..{max:?}]")),
                _ => {}
            }
        }
    }
    body.push_str(&format!("\n\nInteraction: {}\n单字段可直接回复；多字段/多选用 /answer {} {{\"Form\":{{\"fields\":...}}}}。", interaction.id, interaction.id));
    choices.push(("Decline".into(), InteractionResponse::Decline));
    choices.push(("Cancel".into(), InteractionResponse::Cancel));
    (body, choices)
}
#[derive(Clone, Debug)]
pub enum DeliveryPart {
    Message(SendMessage),
    Image {
        topic: TopicKey,
        image: crate::domain::image::ImageRef,
    },
}
fn text_parts(topic: &TopicKey, text: &str) -> Vec<DeliveryPart> {
    messages(topic, text)
        .into_iter()
        .map(DeliveryPart::Message)
        .collect()
}
fn flush_text(topic: &TopicKey, text: &mut String, parts: &mut Vec<DeliveryPart>) {
    if !text.is_empty() {
        parts.extend(text_parts(topic, &std::mem::take(text)));
    }
}
pub async fn render(
    event: &DeliveryEvent,
    topic: &TopicKey,
    snapshot: Option<&SessionSnapshot>,
    payloads: &PayloadStore,
    store: &TelegramStore,
    now: u64,
) -> Result<Vec<DeliveryPart>, DomainError> {
    match &event.payload {
        DeliveryPayload::SessionCompleted { turn, entries } => {
            let mut text = String::new();
            let mut parts = Vec::new();
            let mut previous_message = None;
            for id in entries {
                let entry = payloads.entry(id).await?;
                if &entry.turn != turn {
                    return Err(DomainError::Persistence(
                        "delivery turn/entry mismatch".into(),
                    ));
                }
                if let Some(image) = entry.image {
                    flush_text(topic, &mut text, &mut parts);
                    parts.push(DeliveryPart::Image {
                        topic: topic.clone(),
                        image,
                    });
                }
                if !text.is_empty()
                    && previous_message.is_some()
                    && entry.message.is_some()
                    && previous_message != entry.message
                {
                    text.push_str("\n\n");
                }
                previous_message = entry.message;
                text.push_str(&entry.text);
            }
            flush_text(topic, &mut text, &mut parts);
            if parts.is_empty() {
                parts.extend(text_parts(topic, "Turn completed."));
            }
            Ok(parts)
        }
        DeliveryPayload::AgentMessage { entry } => {
            let entry = payloads.entry(entry).await?;
            let mut parts = Vec::new();
            if let Some(image) = entry.image {
                parts.push(DeliveryPart::Image {
                    topic: topic.clone(),
                    image,
                });
            }
            parts.extend(text_parts(topic, &entry.text));
            Ok(parts)
        }
        DeliveryPayload::Notice { notice } => {
            Ok(text_parts(topic, &payloads.notice(notice).await?.text))
        }
        DeliveryPayload::Interaction { interaction } => {
            let Some(snapshot) =
                snapshot.filter(|snapshot| snapshot.pending_interactions.contains_key(interaction))
            else {
                return Ok(vec![]);
            };
            let interaction = payloads.interaction(interaction).await?;
            if interaction.expires_at.is_some_and(|expiry| now >= expiry) {
                return Ok(vec![]);
            }
            let (body, choices) = interaction_view(&interaction);
            let mut rows = vec![];
            for (index, (label, response)) in choices.into_iter().enumerate() {
                let key = CallbackKey::for_option(&event.id, index);
                store
                    .register_callback(
                        key.clone(),
                        CallbackBinding {
                            topic: topic.clone(),
                            session: snapshot.id.clone(),
                            answer: InteractionAnswer {
                                interaction: interaction.id.clone(),
                                response,
                            },
                            expires_at: interaction.expires_at.unwrap_or(u64::MAX),
                            used_by: None,
                        },
                    )
                    .await?;
                rows.push(vec![InlineButton {
                    text: label.chars().take(64).collect(),
                    callback_data: key,
                }]);
            }
            let mut parts = messages(topic, &body);
            if let Some(last) = parts.last_mut() {
                last.reply_markup = Some(InlineKeyboard {
                    inline_keyboard: rows,
                });
            }
            Ok(parts.into_iter().map(DeliveryPart::Message).collect())
        }
        DeliveryPayload::Image { image } => {
            let asset = payloads.image_by_id(image).await?;
            Ok(vec![DeliveryPart::Image {
                topic: topic.clone(),
                image: asset.image().clone(),
            }])
        }
    }
}
