use super::api::*;
use super::types::*;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[tokio::test]
async fn forum_discovery_and_topic_title_edits_use_typed_requests_and_idempotent_unchanged() {
    let chat = ChatId::new(-100).unwrap();
    let (base, request) = peer(
        "200 OK",
        "",
        r#"{"ok":true,"result":{"id":-100,"is_forum":true}}"#.into(),
    )
    .await;
    assert!(BotClient::new(&base, "123:SECRET")
        .unwrap()
        .forum_chat(chat)
        .await
        .unwrap());
    let body = String::from_utf8(request.await.unwrap()).unwrap();
    assert!(body.starts_with("POST /bot123:SECRET/getChat "));
    assert!(body.contains("\"chat_id\":-100"));
    let (base, request) = peer(
        "400 Bad Request",
        "",
        r#"{"ok":false,"error_code":400,"description":"Bad Request: TOPIC_NOT_MODIFIED"}"#.into(),
    )
    .await;
    BotClient::new(&base, "123:SECRET")
        .unwrap()
        .edit_topic(chat, TopicId::new(10).unwrap(), "#1 · 中文 😀")
        .await
        .unwrap();
    let body = String::from_utf8(request.await.unwrap()).unwrap();
    assert!(body.starts_with("POST /bot123:SECRET/editForumTopic "));
    assert!(body.contains("\"message_thread_id\":10"));
    assert!(body.contains("#1 · 中文 😀"));
}
async fn peer(
    status: &str,
    extra: &str,
    body: String,
) -> (String, tokio::task::JoinHandle<Vec<u8>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/", listener.local_addr().unwrap());
    let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}", body.len());
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = vec![];
        let mut buffer = [0; 4096];
        loop {
            let count = socket.read(&mut buffer).await.unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&buffer[..count]);
            if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|length| length.trim().parse().unwrap())
                    })
                    .unwrap();
                if bytes.len() >= end + 4 + length {
                    break;
                }
            }
        }
        socket.write_all(response.as_bytes()).await.unwrap();
        bytes
    });
    (base, task)
}
#[tokio::test]
async fn http_poll_sends_durable_offset_and_typed_update_allowlist() {
    let (base, request) = peer("200 OK", "", r#"{"ok":true,"result":[{"update_id":7,"message":{"message_id":1,"from":{"id":5,"is_bot":false},"chat":{"id":-100,"is_forum":true},"message_thread_id":2,"text":"hello"}}]}"#.into()).await;
    let client = BotClient::new(&base, "123:SECRET").unwrap();
    let updates = client.get_updates(7).await.unwrap();
    let incoming = updates.into_iter().next().unwrap().incoming().unwrap();
    assert_eq!(incoming.topic.thread, Some(TopicId::new(2).unwrap()));
    assert!(matches!(incoming.content, IncomingContent::Text(text) if text == "hello"));
    let request = String::from_utf8(request.await.unwrap()).unwrap();
    assert!(request.starts_with("POST /bot123:SECRET/getUpdates "));
    let body: serde_json::Value =
        serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["offset"], 7);
    assert_eq!(
        body["allowed_updates"],
        serde_json::json!(["message", "callback_query"])
    );
}
#[tokio::test]
async fn api_failures_keep_retry_after_but_never_echo_token_or_description() {
    let (base, request) = peer("429 Too Many Requests", "", r#"{"ok":false,"error_code":429,"description":"secret token 123:SECRET","parameters":{"retry_after":120}}"#.into()).await;
    let client = BotClient::new(&base, "123:SECRET").unwrap();
    let error = client.get_updates(0).await.err().unwrap();
    assert_eq!(error.retry_after(), 120);
    assert!(!error.fatal_poll());
    assert!(!format!("{error:?} {error}").contains("SECRET"));
    request.await.unwrap();
    assert!(ApiError::Response {
        code: 401,
        retry_after: None
    }
    .fatal_poll());
    assert!(ApiError::Response {
        code: 409,
        retry_after: None
    }
    .fatal_poll());
}
#[tokio::test]
async fn token_bearing_calls_never_follow_redirects() {
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let extra = format!(
        "Location: http://{}/stolen\r\n",
        target.local_addr().unwrap()
    );
    let (base, request) = peer("302 Found", &extra, r#"{"ok":false}"#.into()).await;
    assert!(BotClient::new(&base, "123:SECRET")
        .unwrap()
        .get_updates(0)
        .await
        .is_err());
    request.await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), target.accept())
            .await
            .is_err()
    );
    for base in [
        "http://example.com/",
        "https://user:password@example.com/",
        "https://example.com/?token=x",
        "https://example.com/extra",
    ] {
        assert!(BotClient::new(base, "123:SECRET").is_err());
    }
}
#[tokio::test]
async fn text_silent_policy_uses_the_typed_telegram_flag_without_hiding_message_or_markup() {
    for silent in [false, true] {
        let (base, request) = peer(
            "200 OK",
            "",
            r#"{"ok":true,"result":{"message_id":1,"chat":{"id":-100},"message_thread_id":2}}"#
                .into(),
        )
        .await;
        BotClient::new(&base, "123:SECRET")
            .unwrap()
            .send_message(&SendMessage {
                chat_id: ChatId::new(-100).unwrap(),
                message_thread_id: Some(TopicId::new(2).unwrap()),
                text: "授权入口 🚀".into(),
                disable_notification: silent,
                reply_markup: Some(InlineKeyboard {
                    inline_keyboard: vec![vec![InlineButton {
                        text: "Allow".into(),
                        callback_data: CallbackKey::for_option(
                            &crate::domain::DeliveryId::generate(),
                            0,
                        ),
                    }]],
                }),
            })
            .await
            .unwrap();
        let request = String::from_utf8(request.await.unwrap()).unwrap();
        assert!(request.starts_with("POST /bot123:SECRET/sendMessage "));
        let body: serde_json::Value =
            serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["disable_notification"], silent);
        assert_eq!(body["text"], "授权入口 🚀");
        assert_eq!(
            body["reply_markup"]["inline_keyboard"][0][0]["text"],
            "Allow"
        );
    }
}
#[tokio::test]
async fn markdown_send_and_preview_edits_use_safe_html_and_cards_can_be_deleted() {
    let response =
        r#"{"ok":true,"result":{"message_id":7,"chat":{"id":-100},"message_thread_id":2}}"#;
    let message = SendMessage {
        chat_id: ChatId::new(-100).unwrap(),
        message_thread_id: Some(TopicId::new(2).unwrap()),
        text: "**确认** `a < b` 😀".into(),
        disable_notification: false,
        reply_markup: None,
    };
    for edit in [false, true] {
        let (base, request) = peer("200 OK", "", response.into()).await;
        let api = BotClient::new(&base, "123:SECRET").unwrap();
        if edit {
            api.edit_message(MessageId::new(7).unwrap(), &message)
                .await
                .unwrap();
        } else {
            api.send_message(&message).await.unwrap();
        }
        let request = String::from_utf8(request.await.unwrap()).unwrap();
        let body: serde_json::Value =
            serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["parse_mode"], "HTML");
        assert_eq!(body["text"], "<b>确认</b> <code>a &lt; b</code> 😀");
    }
    let (base, request) = peer("200 OK", "", r#"{"ok":true,"result":true}"#.into()).await;
    BotClient::new(&base, "123:SECRET")
        .unwrap()
        .delete_message(message.chat_id, MessageId::new(7).unwrap())
        .await
        .unwrap();
    let request = String::from_utf8(request.await.unwrap()).unwrap();
    assert!(request.starts_with("POST /bot123:SECRET/deleteMessage "));
    let body: serde_json::Value =
        serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body, serde_json::json!({"chat_id": -100, "message_id": 7}));
}

#[tokio::test]
async fn verified_media_uploads_binary_multipart_with_typed_topic_and_correct_endpoint() {
    use crate::domain::image::{ImageAsset, ImageMime};
    use base64::{engine::general_purpose::STANDARD, Engine};
    let png = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=").unwrap();
    for (mime, bytes, method, field) in [
        (ImageMime::Png, png, "sendPhoto", "photo"),
        (
            ImageMime::Jpeg,
            vec![255, 216, 255, 217],
            "sendPhoto",
            "photo",
        ),
        (
            ImageMime::Gif,
            b"GIF89a\x01\x00\x01\x00".to_vec(),
            "sendAnimation",
            "animation",
        ),
        (
            ImageMime::Webp,
            b"RIFFxxxxWEBPVP8 ".to_vec(),
            "sendDocument",
            "document",
        ),
    ] {
        let (base, request) = peer(
            "200 OK",
            "",
            r#"{"ok":true,"result":{"message_id":1,"chat":{"id":-100},"message_thread_id":2}}"#
                .into(),
        )
        .await;
        let asset = ImageAsset::new(mime, bytes.clone()).unwrap();
        let filename = format!("{}.{}", asset.image().id(), mime.extension());
        let media = SendMedia {
            chat_id: ChatId::new(-100).unwrap(),
            message_thread_id: Some(TopicId::new(2).unwrap()),
            asset,
            disable_notification: true,
        };
        let message = BotClient::new(&base, "123:SECRET")
            .unwrap()
            .send_media(&media)
            .await
            .unwrap();
        assert_eq!(message.message_thread_id, media.message_thread_id);
        let request = request.await.unwrap();
        let text = String::from_utf8_lossy(&request);
        assert!(text.starts_with(&format!("POST /bot123:SECRET/{method} ")));
        assert!(text.contains("multipart/form-data; boundary="));
        assert!(text.contains(&format!("name=\"{field}\"")) && text.contains(&filename));
        assert!(text.contains("name=\"chat_id\"\r\n\r\n-100"));
        assert!(text.contains("name=\"message_thread_id\"\r\n\r\n2"));
        assert!(text.contains("name=\"disable_notification\"\r\n\r\ntrue"));
        assert!(text.contains(mime.as_str()));
        assert!(request.windows(bytes.len()).any(|window| window == bytes));
    }
}
#[tokio::test]
async fn media_retry_errors_are_bounded_and_never_include_token_or_remote_description() {
    let (base, request) = peer("429 Too Many Requests", "", r#"{"ok":false,"error_code":429,"description":"123:SECRET pixels","parameters":{"retry_after":120}}"#.into()).await;
    let asset = crate::domain::image::ImageAsset::from_base64("image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=").unwrap();
    let media = SendMedia {
        chat_id: ChatId::new(-100).unwrap(),
        message_thread_id: None,
        asset,
        disable_notification: false,
    };
    let error = BotClient::new(&base, "123:SECRET")
        .unwrap()
        .send_media(&media)
        .await
        .err()
        .unwrap();
    assert_eq!(error.retry_after(), 120);
    assert!(!format!("{error:?} {error}").contains("SECRET"));
    assert!(!format!("{media:?}").contains("iVBOR"));
    request.await.unwrap();
}
#[test]
fn inaccessible_inline_and_ambiguous_callbacks_cannot_infer_a_topic_from_sender_identity() {
    let inline: WireUpdate = serde_json::from_str(r#"{"update_id":1,"callback_query":{"id":"q","from":{"id":5,"is_bot":false},"inline_message_id":"inline","data":"unknown"}}"#).unwrap();
    assert!(inline.incoming().is_none());
    let ambiguous: WireUpdate = serde_json::from_str(r#"{"update_id":1,"message":{"message_id":1,"chat":{"id":-100},"from":{"id":5,"is_bot":false},"text":"hello"},"callback_query":{"id":"q","from":{"id":5,"is_bot":false},"message":{"message_id":1,"chat":{"id":-100}},"data":"unknown"}}"#).unwrap();
    assert!(ambiguous.incoming().is_none());
}
