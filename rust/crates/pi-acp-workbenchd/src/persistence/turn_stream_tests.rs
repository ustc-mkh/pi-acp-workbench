use super::turn_manifest_tests::{apply, initial};
use super::{
    database::Database,
    payload::PayloadStore,
    sqlite_tests::{open, Root},
};
use crate::{
    domain::{
        command::{AgentEvent, DomainCommand},
        DeliveryId, ProviderMessageId,
    },
    telegram::{
        render::{self, DeliveryPart},
        turn_stream::TurnStream,
        types::TopicKey,
    },
};
fn token(part: DeliveryPart) -> String {
    match part {
        DeliveryPart::Message(message) => {
            assert!(message.text.encode_utf16().count() <= 4000);
            format!("text:{}", message.text)
        }
        DeliveryPart::Image { image, .. } => format!("image:{}", image.id()),
    }
}
#[tokio::test]
async fn frozen_turn_stream_matches_legacy_oracle_across_pages_unicode_images_and_source_deletion()
{
    let root = Root::new();
    let (lease, db) = open(&root.data()).await;
    let mut view = initial();
    let session = view.id.clone();
    db.create(view.clone()).await.unwrap();
    apply(
        &db,
        &mut view,
        DomainCommand::Prompt {
            session: session.clone(),
            prompt: crate::domain::Prompt::new("question").unwrap(),
        },
    )
    .await;
    let turn = view.active_turn.clone().unwrap();
    let image = crate::domain::image::ImageAsset::from_base64("image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=").unwrap();
    for index in 0..207 {
        let message = Some(ProviderMessageId::new(format!("message-{}", index / 3)).unwrap());
        let event = if index == 104 {
            AgentEvent::Image {
                turn: turn.clone(),
                asset: image.clone(),
                message,
            }
        } else {
            AgentEvent::Text {
                turn: turn.clone(),
                text: if index == 100 {
                    "🌏b".repeat(40_000)
                } else if index % 7 == 0 {
                    String::new()
                } else {
                    format!("piece-{index}🌏")
                },
                message,
            }
        };
        apply(
            &db,
            &mut view,
            DomainCommand::Agent {
                session: session.clone(),
                event,
            },
        )
        .await;
    }
    apply(
        &db,
        &mut view,
        DomainCommand::Agent {
            session: session.clone(),
            event: AgentEvent::Finished { turn: turn.clone() },
        },
    )
    .await;
    let delivery = DeliveryId::new(format!("turn-{turn}")).unwrap();
    db.remove(session.clone(), None).await.unwrap();
    db.shutdown().await.unwrap();
    let db = Database::open(root.data(), &lease).await.unwrap();
    let payloads = PayloadStore::new(db.clone());
    let mut after = Default::default();
    let mut entries = vec![];
    loop {
        let page = payloads.delivery_page(&delivery, after).await.unwrap();
        assert!(page.entries.len() <= 100);
        assert!(serde_json::to_vec(&page).unwrap().len() <= crate::domain::query::MAX_QUERY_BYTES);
        entries.extend(page.entries.into_iter().map(|header| header.id));
        match page.next_seq {
            Some(next) => {
                assert!(next > after);
                after = next;
            }
            None => break,
        }
    }
    assert_eq!(entries.len(), 207);
    let topic = TopicKey::from_delivery(-100, 1).unwrap();
    // Independent vector oracle retained only in this test. Production never
    // materializes a whole turn or consumes an Entries payload.
    let mut expected = Vec::new();
    let mut text = String::new();
    let mut previous = None;
    for id in entries {
        let row = payloads.entry(&id).await.unwrap();
        assert_eq!(row.turn, turn);
        if let Some(image) = row.image {
            expected.extend(
                render::messages(&topic, &std::mem::take(&mut text))
                    .into_iter()
                    .map(|message| format!("text:{}", message.text)),
            );
            expected.push(format!("image:{}", image.id()));
        }
        if !text.is_empty()
            && previous.is_some()
            && row.message.is_some()
            && previous != row.message
        {
            text.push_str("\n\n");
        }
        previous = row.message;
        text.push_str(&row.text);
    }
    expected.extend(
        render::messages(&topic, &text)
            .into_iter()
            .map(|message| format!("text:{}", message.text)),
    );
    if expected.is_empty() {
        expected.push("text:Turn completed.".into());
    }
    let mut stream = TurnStream::new(delivery, turn, topic);
    let mut actual = vec![];
    while let Some(part) = stream.next(&payloads).await.unwrap() {
        actual.push(token(part));
    }
    assert_eq!(actual, expected);
    assert!(stream.next(&payloads).await.unwrap().is_none());
    db.shutdown().await.unwrap();
}
