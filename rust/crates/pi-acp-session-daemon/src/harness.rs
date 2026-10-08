//! Provider identity is translated once at the ACP boundary; storage always uses local IDs.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Deserialize, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Harness {
    #[default]
    Pi,
    Codex,
    Claude,
}
impl Harness {
    pub fn name(self) -> &'static str {
        match self {
            Self::Pi => "pi",
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "pi" => Ok(Self::Pi),
            "codex" => Ok(Self::Codex),
            "claude" => Ok(Self::Claude),
            _ => Err("不支持的 harness".into()),
        }
    }
    pub fn local_id(self, native: &str) -> Result<String, String> {
        if native.is_empty() {
            return Err("Agent 返回空会话 ID".into());
        }
        if self == Self::Pi {
            if native.starts_with("workbench:codex:") || native.starts_with("workbench:claude:") {
                return Err("Pi 会话 ID 使用了保留的 harness 命名空间".into());
            }
            return Ok(native.to_string());
        }
        let mut encoded = String::new();
        for byte in native.bytes() {
            if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
                encoded.push(byte as char);
            } else {
                encoded.push_str(&format!("%{byte:02X}"));
            }
        }
        Ok(format!("workbench:{}:{encoded}", self.name()))
    }
    pub fn native_id(self, local: &str) -> Result<String, String> {
        if self == Self::Pi {
            return self.local_id(local);
        }
        let prefix = format!("workbench:{}:", self.name());
        let encoded = local
            .strip_prefix(&prefix)
            .ok_or("会话不属于当前 harness")?;
        let mut bytes = Vec::new();
        let mut chars = encoded.bytes();
        while let Some(byte) = chars.next() {
            if byte == b'%' {
                let a = chars
                    .next()
                    .and_then(|c| (c as char).to_digit(16))
                    .ok_or("无效会话 ID 编码")?;
                let b = chars
                    .next()
                    .and_then(|c| (c as char).to_digit(16))
                    .ok_or("无效会话 ID 编码")?;
                bytes.push((a * 16 + b) as u8);
            } else {
                bytes.push(byte);
            }
        }
        let native = String::from_utf8(bytes).map_err(|_| "无效会话 ID 编码")?;
        if native.is_empty() {
            return Err("无效会话 ID".into());
        }
        Ok(native)
    }
    pub fn inbound(self, mut params: serde_json::Value) -> Result<serde_json::Value, String> {
        if let Some(id) = params.get("sessionId").and_then(serde_json::Value::as_str) {
            params["sessionId"] = self.local_id(id)?.into();
        }
        Ok(params)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn namespace_matches_encode_uri_component_and_rejects_cross_harness_ids() {
        let native = "same/中文:%";
        let local = Harness::Codex.local_id(native).unwrap();
        assert_eq!(local, "workbench:codex:same%2F%E4%B8%AD%E6%96%87%3A%25");
        assert_eq!(Harness::Codex.native_id(&local).unwrap(), native);
        assert!(Harness::Claude.native_id(&local).is_err());
        assert!(Harness::Pi.local_id(&local).is_err());
        assert!(Harness::Codex.native_id("workbench:codex:%ZZ").is_err());
    }
}
