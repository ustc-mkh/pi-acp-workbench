//! Photo delivery shares pacing, silence and durable retry checkpoints with text.
use super::*;
use crate::api::Upload;
use crate::images;

impl Bridge {
    pub(super) async fn send_entry_images(
        &self,
        scope: &str,
        cwd: &str,
        entries: &[Value],
        thread: i64,
        silent: bool,
    ) -> Result<(), String> {
        let mut count = 0;
        let mut total = 0;
        let mut seen = HashSet::new();
        for source in entries.iter().flat_map(images::sources) {
            let mut hash = Sha256::new();
            hash.update(scope.as_bytes());
            hash.update(b"\0");
            match &source {
                images::Source::Data { mime, data } => {
                    hash.update(mime.as_bytes());
                    hash.update(b"\0");
                    hash.update(data.as_bytes());
                }
                images::Source::File(path) => {
                    hash.update(b"file\0");
                    hash.update(path.as_bytes());
                }
            }
            let key = format!("media:{}", hex::encode(hash.finalize()));
            if !seen.insert(key.clone()) {
                continue;
            }
            if count >= images::MAX_IMAGES {
                break;
            }
            count += 1;
            if self.shared.store.read().await.delivered.contains(&key) {
                continue;
            }
            let image = images::load(cwd, &source).await;
            let image = match image {
                Ok(image) if total + image.bytes.len() <= images::MAX_TOTAL => image,
                _ => {
                    self.send("[图片未发送：仅支持当前工作目录内或内嵌的 PNG / JPEG / WebP / GIF，单张不超过 3 MB、每批合计不超过 6 MB。]",Some(thread),json!({"disable_notification":silent})).await.map_err(|e| e.message)?;
                    self.media_checkpoint(key).await?;
                    continue;
                }
            };
            total += image.bytes.len();
            let (method, field) = match image.mime {
                "image/png" | "image/jpeg" => ("sendPhoto", "photo"),
                "image/gif" => ("sendAnimation", "animation"),
                _ => ("sendDocument", "document"),
            };
            let params = json!({"chat_id":self.shared.opts.chat_id,"message_thread_id":thread,"disable_notification":silent});
            let mut upload = Upload {
                field,
                filename: image.filename,
                mime: image.mime,
                bytes: Arc::new(image.bytes),
            };
            let mut result = self
                .shared
                .api
                .upload(method, params.clone(), upload.clone())
                .await;
            // Telegram may reject a photo's geometry; preserve it as a document instead.
            if result.as_ref().is_err_and(|e| e.code == 400) && method != "sendDocument" {
                upload.field = "document";
                result = self.shared.api.upload("sendDocument", params, upload).await;
            }
            if let Err(error) = result {
                if error.code == 400 {
                    self.send(
                        "[Telegram 无法显示此图片，原内容可在桌面查看。]",
                        Some(thread),
                        json!({"disable_notification":silent}),
                    )
                    .await
                    .map_err(|e| e.message)?;
                } else {
                    return Err(error.message);
                }
            }
            self.media_checkpoint(key).await?;
        }
        Ok(())
    }
    async fn media_checkpoint(&self, key: String) -> Result<(), String> {
        self.persist(|s| {
            s.delivered.push(key);
            trim(&mut s.delivered, DELIVERED_KEEP);
        })
        .await
    }
}
