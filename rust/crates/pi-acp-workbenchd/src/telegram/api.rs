//! Telegram HTTP/JSON boundary. Errors never retain request URLs or bot tokens.
use super::types::*;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{future::Future, sync::Arc, time::Duration};
#[derive(Clone, Debug, thiserror::Error)]
pub enum ApiError {
    #[error("Telegram transport failed")]
    Transport,
    #[error("invalid Telegram API response")]
    Protocol,
    #[error("Telegram API error {code}")]
    Response { code: u16, retry_after: Option<u64> },
}
impl ApiError {
    pub fn retry_after(&self) -> u64 {
        match self {
            Self::Response {
                retry_after: Some(seconds),
                ..
            } => (*seconds).clamp(1, 86400),
            _ => 5,
        }
    }
    pub fn fatal_poll(&self) -> bool {
        matches!(
            self,
            Self::Response {
                code: 401 | 403 | 409,
                ..
            }
        )
    }
}
#[derive(Clone, Deserialize)]
pub struct WireUser {
    pub id: UserId,
    pub is_bot: bool,
    pub username: Option<String>,
}
#[derive(Clone, Deserialize)]
pub struct WireChat {
    pub id: ChatId,
    #[serde(default)]
    pub is_forum: bool,
}
#[derive(Clone, Deserialize)]
pub struct WireMessage {
    pub message_id: MessageId,
    pub chat: WireChat,
    pub message_thread_id: Option<TopicId>,
    pub from: Option<WireUser>,
    pub text: Option<String>,
}
#[derive(Clone, Deserialize)]
pub struct WireCallback {
    pub id: String,
    pub from: WireUser,
    pub message: Option<WireMessage>,
    pub data: Option<String>,
}
#[derive(Clone, Deserialize)]
pub struct WireUpdate {
    pub update_id: UpdateId,
    pub message: Option<WireMessage>,
    pub callback_query: Option<WireCallback>,
}
impl WireUpdate {
    pub fn incoming(self) -> Option<IncomingUpdate> {
        if self.message.is_some() && self.callback_query.is_some() {
            return None;
        }
        let (message, sender, content) = if let Some(callback) = self.callback_query {
            let message = callback.message?;
            let content = match callback
                .data
                .and_then(|data| CallbackKey::try_from(data).ok())
            {
                Some(key) => IncomingContent::Callback {
                    key,
                    query: callback.id,
                },
                None => IncomingContent::Unsupported,
            };
            (message, callback.from, content)
        } else {
            let message = self.message?;
            let sender = message.from.clone()?;
            let content = message
                .text
                .clone()
                .map(IncomingContent::Text)
                .unwrap_or(IncomingContent::Unsupported);
            (message, sender, content)
        };
        Some(IncomingUpdate {
            id: self.update_id,
            topic: TopicKey {
                chat: message.chat.id,
                thread: message.message_thread_id,
            },
            sender: sender.id,
            from_bot: sender.is_bot,
            forum: message.chat.is_forum,
            content,
        })
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct InlineButton {
    pub text: String,
    pub callback_data: CallbackKey,
}
#[derive(Clone, Debug, Serialize)]
pub struct InlineKeyboard {
    pub inline_keyboard: Vec<Vec<InlineButton>>,
}
#[derive(Clone, Debug, Serialize)]
pub struct SendMessage {
    pub chat_id: ChatId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_thread_id: Option<TopicId>,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_markup: Option<InlineKeyboard>,
}
/// Verified local archive bytes only; no URL/file-id upload fallback.
#[derive(Clone, Debug)]
pub struct SendMedia {
    pub chat_id: ChatId,
    pub message_thread_id: Option<TopicId>,
    pub asset: crate::domain::image::ImageAsset,
}
#[derive(Clone, Deserialize)]
pub struct ForumTopic {
    pub message_thread_id: TopicId,
}
pub trait BotApi: Clone + Send + Sync + 'static {
    fn get_me(&self) -> impl Future<Output = Result<WireUser, ApiError>> + Send;
    fn get_updates(
        &self,
        offset: u64,
    ) -> impl Future<Output = Result<Vec<WireUpdate>, ApiError>> + Send;
    fn send_message(
        &self,
        message: &SendMessage,
    ) -> impl Future<Output = Result<WireMessage, ApiError>> + Send;
    fn send_media(
        &self,
        _media: &SendMedia,
    ) -> impl Future<Output = Result<WireMessage, ApiError>> + Send {
        async { Err(ApiError::Protocol) }
    }
    fn answer_callback(
        &self,
        query: &str,
        text: &str,
    ) -> impl Future<Output = Result<(), ApiError>> + Send;
    fn create_topic(
        &self,
        chat: ChatId,
        name: &str,
    ) -> impl Future<Output = Result<ForumTopic, ApiError>> + Send;
}
#[derive(Clone)]
pub struct BotClient {
    http: reqwest::Client,
    base: Arc<reqwest::Url>,
}
#[derive(Deserialize)]
struct Envelope<R> {
    ok: bool,
    result: Option<R>,
    error_code: Option<u16>,
    parameters: Option<ResponseParameters>,
}
#[derive(Deserialize)]
struct ResponseParameters {
    retry_after: Option<u64>,
}
impl BotClient {
    pub fn new(base: &str, token: &str) -> Result<Self, ApiError> {
        if token.is_empty()
            || token.len() > 256
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'))
        {
            return Err(ApiError::Protocol);
        }
        let mut base = reqwest::Url::parse(base).map_err(|_| ApiError::Protocol)?;
        let loopback = matches!(
            base.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        );
        if (base.scheme() != "https" && !(base.scheme() == "http" && loopback))
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
            || base.path() != "/"
        {
            return Err(ApiError::Protocol);
        }
        base.set_path(&format!("/bot{token}/"));
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(40))
            .build()
            .map_err(|_| ApiError::Transport)?;
        Ok(Self {
            http,
            base: Arc::new(base),
        })
    }
    async fn call<Q: Serialize + ?Sized, R: DeserializeOwned>(
        &self,
        method: &str,
        request: &Q,
    ) -> Result<R, ApiError> {
        let url = self.base.join(method).map_err(|_| ApiError::Protocol)?;
        let response = self
            .http
            .post(url)
            .json(request)
            .send()
            .await
            .map_err(|_| ApiError::Transport)?;
        Self::receive(response).await
    }
    async fn receive<R: DeserializeOwned>(mut response: reqwest::Response) -> Result<R, ApiError> {
        let status = response.status();
        let mut bytes = vec![];
        while let Some(chunk) = response.chunk().await.map_err(|_| ApiError::Transport)? {
            if bytes.len().saturating_add(chunk.len()) > 8 * 1024 * 1024 {
                return Err(ApiError::Protocol);
            }
            bytes.extend_from_slice(&chunk);
        }
        let response: Envelope<R> =
            serde_json::from_slice(&bytes).map_err(|_| ApiError::Protocol)?;
        if !status.is_success() || !response.ok {
            return Err(ApiError::Response {
                code: response.error_code.unwrap_or(status.as_u16()),
                retry_after: response
                    .parameters
                    .and_then(|parameters| parameters.retry_after),
            });
        }
        response.result.ok_or(ApiError::Protocol)
    }
}
impl BotApi for BotClient {
    async fn get_me(&self) -> Result<WireUser, ApiError> {
        {
            #[derive(Serialize)]
            struct Empty {}
            self.call("getMe", &Empty {}).await
        }
    }
    async fn get_updates(&self, offset: u64) -> Result<Vec<WireUpdate>, ApiError> {
        #[derive(Serialize)]
        struct Request {
            offset: u64,
            timeout: u8,
            limit: u8,
            allowed_updates: [&'static str; 2],
        }
        self.call(
            "getUpdates",
            &Request {
                offset,
                timeout: 20,
                limit: 100,
                allowed_updates: ["message", "callback_query"],
            },
        )
        .await
    }
    async fn send_message(&self, message: &SendMessage) -> Result<WireMessage, ApiError> {
        self.call("sendMessage", message).await
    }
    async fn send_media(&self, media: &SendMedia) -> Result<WireMessage, ApiError> {
        use crate::domain::image::ImageMime;
        let image = media.asset.image();
        let (method, field) = match image.mime() {
            ImageMime::Png | ImageMime::Jpeg => ("sendPhoto", "photo"),
            ImageMime::Gif => ("sendAnimation", "animation"),
            ImageMime::Webp => ("sendDocument", "document"),
        };
        let part = reqwest::multipart::Part::bytes(media.asset.bytes().to_vec())
            .file_name(format!("{}.{}", image.id(), image.mime().extension()))
            .mime_str(image.mime().as_str())
            .map_err(|_| ApiError::Protocol)?;
        let mut form = reqwest::multipart::Form::new()
            .text("chat_id", media.chat_id.get().to_string())
            .part(field, part);
        if let Some(thread) = media.message_thread_id {
            form = form.text("message_thread_id", thread.get().to_string());
        }
        let url = self.base.join(method).map_err(|_| ApiError::Protocol)?;
        let response = self
            .http
            .post(url)
            .multipart(form)
            .send()
            .await
            .map_err(|_| ApiError::Transport)?;
        Self::receive(response).await
    }
    async fn answer_callback(&self, query: &str, text: &str) -> Result<(), ApiError> {
        #[derive(Serialize)]
        struct Request<'a> {
            callback_query_id: &'a str,
            text: &'a str,
        }
        if !self
            .call::<_, bool>(
                "answerCallbackQuery",
                &Request {
                    callback_query_id: query,
                    text,
                },
            )
            .await?
        {
            return Err(ApiError::Protocol);
        }
        Ok(())
    }
    async fn create_topic(&self, chat: ChatId, name: &str) -> Result<ForumTopic, ApiError> {
        #[derive(Serialize)]
        struct Request<'a> {
            chat_id: ChatId,
            name: &'a str,
        }
        self.call(
            "createForumTopic",
            &Request {
                chat_id: chat,
                name,
            },
        )
        .await
    }
}
