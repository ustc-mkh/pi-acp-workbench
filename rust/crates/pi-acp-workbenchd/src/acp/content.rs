//! Opaque content is retained only at the ACP boundary, never in domain state.
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RawExtension(serde_json::Value);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum KnownContent {
    Text {
        text: String,
    },
    Image {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        uri: Option<String>,
    },
    Audio {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
    Resource {
        resource: EmbeddedResource,
    },
    ResourceLink {
        uri: String,
        name: String,
        #[serde(rename = "mimeType", default, skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EmbeddedResource {
    Text {
        uri: String,
        text: String,
        #[serde(rename = "mimeType", default, skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
    },
    Blob {
        uri: String,
        blob: String,
        #[serde(rename = "mimeType", default, skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
    },
}
#[derive(Clone, Debug)]
pub enum ContentBlock {
    Known(KnownContent),
    Unknown(RawExtension),
}
impl ContentBlock {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Known(KnownContent::Text { text: text.into() })
    }
    pub fn display_text(&self) -> Option<&str> {
        match self {
            Self::Known(KnownContent::Text { text }) => Some(text),
            Self::Known(KnownContent::Resource {
                resource: EmbeddedResource::Text { text, .. },
            }) => Some(text),
            _ => None,
        }
    }
}
impl Serialize for ContentBlock {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Known(content) => content.serialize(serializer),
            Self::Unknown(raw) => raw.serialize(serializer),
        }
    }
}
impl<'de> Deserialize<'de> for ContentBlock {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = RawExtension::deserialize(deserializer)?;
        let kind = raw
            .0
            .get("type")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| serde::de::Error::custom("content type missing"))?;
        if matches!(
            kind,
            "text" | "image" | "audio" | "resource" | "resource_link"
        ) {
            serde_json::from_value(raw.0)
                .map(Self::Known)
                .map_err(serde::de::Error::custom)
        } else {
            Ok(Self::Unknown(raw))
        }
    }
}
