//! Typed ACP message-content hot path. Unknown content kinds remain forward compatible.
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MessageContent {
    #[serde(rename = "type")]
    pub kind: String,
    pub text: String,
    pub name: String,
    pub uri: String,
    pub resource: ResourceContent,
}
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct ResourceContent {
    pub text: Option<String>,
}
impl MessageContent {
    pub fn display_text(&self) -> String {
        match self.kind.as_str() {
            "text" => self.text.clone(),
            "resource_link" => format!("[{}]({})", self.name, self.uri),
            "resource" => self
                .resource
                .text
                .as_deref()
                .unwrap_or("[二进制资源]")
                .into(),
            other => format!("[{other} 内容]"),
        }
    }
    pub fn decode(value: &Value) -> Self {
        Self::deserialize(value).unwrap_or_default()
    }
}
