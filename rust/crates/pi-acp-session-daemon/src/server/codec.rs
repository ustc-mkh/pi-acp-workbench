//! JSON frame encoding and byte-compatible UTF-16 fragment escaping.
use serde_json::Value;
use std::fmt::Write as _;
pub(super) fn encode(value: &Value, limit: usize) -> Option<String> {
    let mut body = serde_json::to_string(value).ok()?;
    body.push('\n');
    (body.len() <= limit).then_some(body)
}
/// Escape lone surrogates at fragment boundaries exactly as JSON.stringify.
pub(super) fn encode_fragment(units: &[u16]) -> String {
    let mut out = String::with_capacity(units.len() + units.len() / 8);
    let mut i = 0;
    while i < units.len() {
        let u = units[i];
        match u {
            0x22 => out.push_str("\\\""),
            0x5C => out.push_str("\\\\"),
            0x08 => out.push_str("\\b"),
            0x09 => out.push_str("\\t"),
            0x0A => out.push_str("\\n"),
            0x0C => out.push_str("\\f"),
            0x0D => out.push_str("\\r"),
            0x00..=0x1F => {
                let _ = write!(out, "\\u{u:04x}");
            }
            0xD800..=0xDBFF => {
                let low = units.get(i + 1).copied().unwrap_or(0);
                if (0xDC00..=0xDFFF).contains(&low) {
                    let scalar = 0x1_0000 + (((u as u32) - 0xD800) << 10) + (low as u32 - 0xDC00);
                    out.push(char::from_u32(scalar).unwrap_or('\u{FFFD}'));
                    i += 1;
                } else {
                    let _ = write!(out, "\\u{u:04x}");
                }
            }
            0xDC00..=0xDFFF => {
                let _ = write!(out, "\\u{u:04x}");
            }
            _ => {
                if let Some(c) = char::from_u32(u as u32) {
                    out.push(c);
                }
            }
        }
        i += 1;
    }
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fragment_boundaries_preserve_surrogates_and_control_characters() {
        assert_eq!(encode_fragment(&[0xD83D]), "\\ud83d");
        assert_eq!(encode_fragment(&[0xDE00]), "\\ude00");
        assert_eq!(encode_fragment(&[0xD83D, 0xDE00, 10]), "😀\\n");
        assert!(encode(&serde_json::json!("abcd"), 2).is_none());
    }
}
