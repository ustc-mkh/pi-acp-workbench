use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};

fn notification(content: serde_json::Value) -> crate::acp::JsonRpcNotification {
    serde_json::from_value(json!({"jsonrpc":"2.0", "method":"session/update", "params": {
        "sessionId":"native", "update":{"sessionUpdate":"agent_message_chunk", "content":content}
    }})).unwrap()
}

#[tokio::test]
async fn maximum_raw_image_and_exact_text_budget_cross_real_stdio_but_overflow_does_not_write() {
    let supervisor = supervisor("node", vec!["-e".into(), "require('node:readline').createInterface({input:process.stdin}).on('line',line=>process.stdout.write(line+'\\n'));".into()]);
    let (tx, mut events) = mpsc::channel(4);
    let worker = supervisor.spawn(SessionId::generate(), tx).await.unwrap();
    let mut raw = vec![0; crate::domain::image::MAX_IMAGE_BYTES];
    raw[..24].copy_from_slice(&[
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
    ]);
    let image =
        notification(json!({"type":"image","mimeType":"image/png","data":STANDARD.encode(&raw)}));
    let bytes = serde_json::to_vec(&image).unwrap().len();
    assert!(bytes > MAX_FRAME && bytes <= MAX_MEDIA_FRAME);
    worker.notify(image).await.unwrap();
    let event = tokio::time::timeout(Duration::from_secs(5), events.recv())
        .await
        .unwrap()
        .unwrap();
    let WorkerEvent::Update(update) = event else {
        panic!("image notification")
    };
    let crate::acp::SessionUpdate::AgentMessage {
        content:
            crate::acp::ContentBlock::Known(crate::acp::content::KnownContent::Image { data, .. }),
        ..
    } = update.update
    else {
        panic!("image block")
    };
    assert_eq!(STANDARD.decode(data).unwrap(), raw);
    raw.push(0);
    assert!(worker
        .notify(notification(
            json!({"type":"image","mimeType":"image/png","data":STANDARD.encode(raw)})
        ))
        .await
        .is_err());

    let empty = notification(json!({"type":"text","text":""}));
    let envelope = serde_json::to_vec(&empty).unwrap().len();
    let text = notification(json!({"type":"text","text":"x".repeat(MAX_FRAME - envelope)}));
    assert_eq!(serde_json::to_vec(&text).unwrap().len(), MAX_FRAME);
    worker.notify(text).await.unwrap();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .unwrap(),
        Some(WorkerEvent::Update(_))
    ));
    assert!(matches!(
        worker
            .notify(notification(
                json!({"type":"text","text":"x".repeat(MAX_FRAME - envelope + 1)})
            ))
            .await,
        Err(DomainError::FrameTooLarge)
    ));
    // Rejection must not kill the worker or put an over-budget frame on its stdin.
    worker
        .notify(notification(json!({"type":"text","text":"still alive"})))
        .await
        .unwrap();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .unwrap(),
        Some(WorkerEvent::Update(_))
    ));
    worker.stop().await;
}

#[tokio::test]
async fn inbound_large_non_media_frames_are_rejected_at_the_original_text_limit() {
    let script = format!("process.stdout.write(JSON.stringify({{jsonrpc:'2.0',method:'session/update',params:{{sessionId:'native',update:{{sessionUpdate:'agent_message_chunk',content:{{type:'text',text:'x'.repeat({})}}}}}}}})+'\\n');process.stdin.resume();", MAX_FRAME);
    let supervisor = supervisor("node", vec!["-e".into(), script]);
    let (tx, mut events) = mpsc::channel(1);
    let worker = supervisor.spawn(SessionId::generate(), tx).await.unwrap();
    let event = tokio::time::timeout(Duration::from_secs(5), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(event, WorkerEvent::Closed(ref reason) if reason.contains("byte budget")));
    worker.stop().await;
}

#[test]
fn maximum_prompt_unicode_and_json_escaping_fit_the_non_media_lane() {
    for scalar in ['中', '😀', '\u{0001}'] {
        let text = scalar.to_string().repeat(100_000);
        let prompt = crate::domain::Prompt::new(text).unwrap();
        let request = crate::acp::JsonRpcRequest::new(
            crate::acp::RequestId::String("budget".into()),
            "session/prompt",
            json!({"sessionId":"native","prompt":[{"type":"text","text":prompt.as_str()}]}),
        )
        .unwrap();
        validate_outbound(&JsonRpcMessage::Request(request)).unwrap();
        assert!(crate::domain::Prompt::new(scalar.to_string().repeat(100_001)).is_err());
    }
}

#[tokio::test]
async fn full_and_closed_worker_mailboxes_are_distinct() {
    let (tx, rx) = mpsc::channel(1);
    tx.try_send(()).unwrap();
    assert!(matches!(
        DomainError::mailbox(tx.try_send(()).unwrap_err()),
        DomainError::Backpressure
    ));
    drop(rx);
    assert!(matches!(
        DomainError::mailbox(tx.try_send(()).unwrap_err()),
        DomainError::MailboxClosed
    ));
}
