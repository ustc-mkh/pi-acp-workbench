//! Bounded immutable image payloads. Snapshots/events contain ImageRef only;
//! encoded bytes belong in the independent payload archive. Signature checks
//! establish MIME consistency, not complete image decoding/sanitization.
use super::{error::DomainError, ImageId};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
pub const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ImageMime {
    #[serde(rename = "image/png")]
    Png,
    #[serde(rename = "image/jpeg")]
    Jpeg,
    #[serde(rename = "image/gif")]
    Gif,
    #[serde(rename = "image/webp")]
    Webp,
}
impl ImageMime {
    pub fn parse(value: &str) -> Result<Self, DomainError> {
        match value {
            "image/png" => Ok(Self::Png),
            "image/jpeg" => Ok(Self::Jpeg),
            "image/gif" => Ok(Self::Gif),
            "image/webp" => Ok(Self::Webp),
            _ => Err(invalid()),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
        }
    }
    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Gif => "gif",
            Self::Webp => "webp",
        }
    }
    fn matches(self, bytes: &[u8]) -> bool {
        match self {
            Self::Png => {
                bytes.len() >= 24
                    && bytes.starts_with(b"\x89PNG\r\n\x1a\n")
                    && &bytes[12..16] == b"IHDR"
            }
            Self::Jpeg => bytes.len() >= 4 && bytes.starts_with(b"\xff\xd8\xff"),
            Self::Gif => {
                bytes.len() >= 10 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"))
            }
            Self::Webp => {
                bytes.len() >= 16 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP"
            }
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "ImageRefWire", into = "ImageRefWire")]
pub struct ImageRef {
    id: ImageId,
    mime: ImageMime,
    bytes: u64,
    sha256: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ImageRefWire {
    id: ImageId,
    mime: ImageMime,
    bytes: u64,
    sha256: String,
}
impl TryFrom<ImageRefWire> for ImageRef {
    type Error = DomainError;
    fn try_from(value: ImageRefWire) -> Result<Self, Self::Error> {
        if value.bytes == 0
            || value.bytes > MAX_IMAGE_BYTES as u64
            || value.sha256.len() != 64
            || !value
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(invalid());
        }
        Ok(Self {
            id: value.id,
            mime: value.mime,
            bytes: value.bytes,
            sha256: value.sha256,
        })
    }
}
impl From<ImageRef> for ImageRefWire {
    fn from(value: ImageRef) -> Self {
        Self {
            id: value.id,
            mime: value.mime,
            bytes: value.bytes,
            sha256: value.sha256,
        }
    }
}
impl ImageRef {
    pub fn id(&self) -> &ImageId {
        &self.id
    }
    pub fn mime(&self) -> ImageMime {
        self.mime
    }
    pub fn byte_len(&self) -> u64 {
        self.bytes
    }
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(try_from = "ImageAssetWire", into = "ImageAssetWire")]
pub struct ImageAsset {
    image: ImageRef,
    data: Vec<u8>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ImageAssetWire {
    format_version: u32,
    image: ImageRef,
    data: String,
}
impl ImageAsset {
    pub fn from_base64(mime: &str, data: &str) -> Result<Self, DomainError> {
        if data.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
            return Err(invalid());
        }
        Self::new(
            ImageMime::parse(mime)?,
            STANDARD.decode(data).map_err(|_| invalid())?,
        )
    }
    pub fn new(mime: ImageMime, data: Vec<u8>) -> Result<Self, DomainError> {
        validate(mime, &data)?;
        Ok(Self {
            image: ImageRef {
                id: ImageId::generate(),
                mime,
                bytes: data.len() as u64,
                sha256: digest(&data),
            },
            data,
        })
    }
    /// Restore immutable database bytes without regenerating the opaque ID or
    /// allocating a base64 JSON envelope. The complete descriptor is verified.
    pub(crate) fn from_archive(image: ImageRef, data: Vec<u8>) -> Result<Self, DomainError> {
        validate(image.mime, &data)?;
        if data.len() as u64 != image.bytes || digest(&data) != image.sha256 {
            return Err(invalid());
        }
        Ok(Self { image, data })
    }
    pub fn image(&self) -> &ImageRef {
        &self.image
    }
    pub fn bytes(&self) -> &[u8] {
        &self.data
    }
}
impl TryFrom<ImageAssetWire> for ImageAsset {
    type Error = DomainError;
    fn try_from(value: ImageAssetWire) -> Result<Self, Self::Error> {
        if value.format_version != 1 || value.data.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
            return Err(invalid());
        }
        let data = STANDARD.decode(&value.data).map_err(|_| invalid())?;
        Self::from_archive(value.image, data)
    }
}
impl From<ImageAsset> for ImageAssetWire {
    fn from(value: ImageAsset) -> Self {
        Self {
            format_version: 1,
            image: value.image,
            data: STANDARD.encode(&value.data),
        }
    }
}
impl std::fmt::Debug for ImageAsset {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImageAsset")
            .field("image", &self.image)
            .finish_non_exhaustive()
    }
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn validate(mime: ImageMime, data: &[u8]) -> Result<(), DomainError> {
    if data.is_empty() || data.len() > MAX_IMAGE_BYTES || !mime.matches(data) {
        return Err(invalid());
    }
    Ok(())
}
fn invalid() -> DomainError {
    DomainError::Protocol("invalid or unsupported image payload".into())
}
