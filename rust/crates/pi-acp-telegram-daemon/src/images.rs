//! Bounded raster output images. Never download model-authored URLs or read outside cwd.
use base64::{engine::general_purpose::STANDARD, Engine};
use pulldown_cmark::{Event, Parser, Tag};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tokio::io::AsyncReadExt;

pub const MAX_BYTES: usize = 3 * 1024 * 1024;
pub const MAX_TOTAL: usize = 6 * 1024 * 1024;
pub const MAX_IMAGES: usize = 8;
#[derive(Clone, Debug, serde::Serialize)]
pub enum Source {
    Data { mime: String, data: String },
    File(String),
}
pub struct Image {
    pub mime: &'static str,
    pub bytes: Vec<u8>,
    pub filename: String,
}
fn raster(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("image/png"),
        "image/jpeg" => Some("image/jpeg"),
        "image/gif" => Some("image/gif"),
        "image/webp" => Some("image/webp"),
        _ => None,
    }
}
fn data(mime: &str, value: &str) -> Option<Source> {
    (raster(mime).is_some() && value.len() <= MAX_BYTES.div_ceil(3) * 4).then(|| Source::Data {
        mime: mime.into(),
        data: value.into(),
    })
}
fn block(value: &Value) -> Option<Source> {
    match value["type"].as_str()? {
        "image" => data(value["mimeType"].as_str()?, value["data"].as_str()?),
        "resource" => data(
            value["resource"]["mimeType"].as_str()?,
            value["resource"]["blob"].as_str()?,
        ),
        _ => None,
    }
}
fn url(source: &str) -> Option<Source> {
    if let Some(tail) = source.strip_prefix("data:") {
        let (mime, value) = tail.split_once(";base64,")?;
        return data(mime, value);
    }
    if source.is_empty() || source.len() > 4096 || source.chars().any(char::is_control) {
        return None;
    }
    if source.starts_with("//") {
        return None;
    }
    if let Ok(url) = reqwest::Url::parse(source) {
        if url.scheme() != "file" {
            return None;
        }
    }
    Some(Source::File(source.into()))
}
pub fn sources(entry: &Value) -> Vec<Source> {
    let mut result = Vec::new();
    if let Some(blocks) = entry["contextBlocks"].as_array() {
        result.extend(blocks.iter().filter_map(block).take(MAX_IMAGES));
    }
    if let Some(content) = entry.pointer("/tool/content").and_then(Value::as_array) {
        let remaining = MAX_IMAGES.saturating_sub(result.len());
        result.extend(
            content
                .iter()
                .filter_map(|c| block(&c["content"]))
                .take(remaining),
        );
    }
    let texts = std::iter::once(entry["text"].as_str()).chain(
        entry
            .pointer("/tool/content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|c| c.pointer("/content/text").and_then(Value::as_str)),
    );
    for text in texts.flatten() {
        if result.len() >= MAX_IMAGES {
            break;
        }
        for event in Parser::new(text) {
            if let Event::Start(Tag::Image { dest_url, .. }) = event {
                if let Some(source) = url(&dest_url) {
                    result.push(source);
                }
                if result.len() >= MAX_IMAGES {
                    break;
                }
            }
        }
        if result.len() >= MAX_IMAGES {
            break;
        }
    }
    result.truncate(MAX_IMAGES);
    result
}
fn inside(root: &Path, target: &Path) -> Result<(), String> {
    if target.starts_with(root) {
        Ok(())
    } else {
        Err("图片不在当前工作目录内。".into())
    }
}
fn signature(mime: &str, b: &[u8]) -> bool {
    match mime {
        "image/png" => b.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]),
        "image/jpeg" => b.starts_with(&[255, 216, 255]),
        "image/gif" => b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a"),
        "image/webp" => b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP"),
        _ => false,
    }
}
pub async fn load(cwd: &str, source: &Source) -> Result<Image, String> {
    let (mime, bytes, filename) = match source {
        Source::Data { mime, data } => {
            let mime = raster(mime).ok_or("不支持的图片格式。")?;
            if data.len() > MAX_BYTES.div_ceil(3) * 4 {
                return Err("图片超过 3 MB。".into());
            }
            let bytes = STANDARD.decode(data).map_err(|_| "图片编码无效。")?;
            if STANDARD.encode(&bytes) != *data {
                return Err("图片编码无效。".into());
            }
            let extension = match mime {
                "image/png" => "png",
                "image/jpeg" => "jpg",
                "image/gif" => "gif",
                _ => "webp",
            };
            (mime, bytes, format!("output.{extension}"))
        }
        Source::File(source) => {
            if cwd.is_empty() {
                return Err("会话缺少工作目录。".into());
            }
            let root = tokio::fs::canonicalize(cwd)
                .await
                .map_err(|_| "图片目录不可用。")?;
            let target = if source.to_ascii_lowercase().starts_with("file:") {
                let url = reqwest::Url::parse(source).map_err(|_| "图片路径无效。")?;
                if url.query().is_some() || url.fragment().is_some() {
                    return Err("图片路径无效。".into());
                }
                url.to_file_path().map_err(|_| "图片路径无效。")?
            } else {
                if url(source).is_none() {
                    return Err("不自动加载远程图片。".into());
                }
                let decoded = percent_encoding::percent_decode_str(source)
                    .decode_utf8()
                    .map_err(|_| "图片路径无效。")?;
                root.join(PathBuf::from(decoded.as_ref()))
            };
            let target = tokio::fs::canonicalize(target)
                .await
                .map_err(|_| "图片不存在。")?;
            inside(&root, &target)?;
            let mime = match target
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase()
                .as_str()
            {
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "gif" => "image/gif",
                "webp" => "image/webp",
                _ => return Err("不支持的图片格式。".into()),
            };
            let meta = tokio::fs::metadata(&target)
                .await
                .map_err(|_| "图片不可读。")?;
            if !meta.is_file() || meta.len() > MAX_BYTES as u64 {
                return Err("图片不可读或超过 3 MB。".into());
            }
            let mut options = tokio::fs::OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
            let file = options.open(&target).await.map_err(|_| "图片不可读。")?;
            #[cfg(target_os = "linux")]
            {
                use std::os::fd::AsRawFd;
                let opened = tokio::fs::canonicalize(format!("/proc/self/fd/{}", file.as_raw_fd()))
                    .await
                    .map_err(|_| "图片不可读。")?;
                inside(&root, &opened)?;
            }
            if !file.metadata().await.map_err(|_| "图片不可读。")?.is_file() {
                return Err("图片不可读。".into());
            }
            let mut bytes = Vec::new();
            file.take((MAX_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| "图片不可读。")?;
            let filename = format!(
                "output.{}",
                target.extension().and_then(|e| e.to_str()).unwrap_or("png")
            );
            (mime, bytes, filename)
        }
    };
    if bytes.len() > MAX_BYTES || !signature(mime, &bytes) {
        return Err("图片超限或格式与内容不符。".into());
    }
    Ok(Image {
        mime,
        bytes,
        filename,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn parses_images_but_not_remote_urls_code_or_svg() {
        let e = json!({"text":"![local](./a.png) ![remote](https://example.com/a.png) `![code](b.png)` ![svg](data:image/svg+xml;base64,PHN2Zy8+)"});
        assert_eq!(sources(&e).len(), 1);
        assert!(matches!(&sources(&e)[0],Source::File(s) if s=="./a.png"));
    }
    #[tokio::test]
    async fn rejects_symlink_escapes_bad_signatures_and_oversized_files() {
        let dir = std::env::temp_dir().join(format!("pi-tg-images-{}", uuid::Uuid::new_v4()));
        let cwd = dir.join("work");
        tokio::fs::create_dir_all(&cwd).await.unwrap();
        let png = [137, 80, 78, 71, 13, 10, 26, 10];
        tokio::fs::write(cwd.join("a.png"), png).await.unwrap();
        tokio::fs::write(dir.join("outside.png"), png)
            .await
            .unwrap();
        tokio::fs::write(cwd.join("bad.png"), b"<svg/>")
            .await
            .unwrap();
        tokio::fs::write(cwd.join("large.png"), vec![0; MAX_BYTES + 1])
            .await
            .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("outside.png"), cwd.join("escape.png")).unwrap();
        let root = cwd.to_str().unwrap();
        assert_eq!(
            load(root, &Source::File("a.png".into()))
                .await
                .unwrap()
                .bytes,
            png
        );
        for path in [
            "../outside.png",
            "%2e%2e/outside.png",
            "escape.png",
            "bad.png",
            "large.png",
            "https://example.com/x.png",
        ] {
            assert!(
                load(root, &Source::File(path.into())).await.is_err(),
                "{path}"
            );
        }
        assert!(load(
            root,
            &Source::Data {
                mime: "image/svg+xml".into(),
                data: STANDARD.encode(png)
            }
        )
        .await
        .is_err());
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }
}
