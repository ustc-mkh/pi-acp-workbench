use super::image::*;
use base64::{engine::general_purpose::STANDARD, Engine};
const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
#[test]
fn bounded_image_assets_validate_encoding_mime_signature_and_reference_on_deserialize() {
    let asset = ImageAsset::from_base64("image/png", PNG).unwrap();
    assert_eq!(asset.image().mime(), ImageMime::Png);
    assert_eq!(asset.image().byte_len() as usize, asset.bytes().len());
    let encoded = serde_json::to_value(&asset).unwrap();
    let restored: ImageAsset = serde_json::from_value(encoded.clone()).unwrap();
    assert_eq!(restored.image(), asset.image());
    assert_eq!(restored.bytes(), asset.bytes());
    assert!(ImageAsset::from_base64("image/png", "not base64").is_err());
    assert!(ImageAsset::from_base64("image/jpeg", PNG).is_err());
    assert!(ImageAsset::from_base64("image/svg+xml", PNG).is_err());
    assert!(ImageAsset::from_base64("image/png", "").is_err());
    assert!(ImageAsset::new(ImageMime::Png, vec![0; MAX_IMAGE_BYTES + 1]).is_err());
    for (key, value) in [
        ("format_version", serde_json::json!(2)),
        ("data", serde_json::json!(STANDARD.encode(b"corrupt bytes"))),
    ] {
        let mut corrupt = encoded.clone();
        corrupt[key] = value;
        assert!(serde_json::from_value::<ImageAsset>(corrupt).is_err());
    }
    for (key, value) in [
        ("bytes", serde_json::json!(0)),
        ("sha256", serde_json::json!("x".repeat(64))),
        ("sha256", serde_json::json!("a".repeat(64))),
    ] {
        let mut corrupt = encoded.clone();
        corrupt["image"][key] = value;
        assert!(serde_json::from_value::<ImageAsset>(corrupt).is_err());
    }
    assert!(
        !serde_json::to_string(asset.image()).unwrap().contains(PNG),
        "references contain metadata, not binary"
    );
}
#[test]
fn acp_image_mapping_is_fallible_and_does_not_fetch_image_uri() {
    use crate::{
        acp::{adapter::update_to_agent, decode_update},
        domain::{command::AgentEvent, TurnId},
    };
    let mut raw = serde_json::json!({"sessionUpdate":"agent_message_chunk","messageId":"opaque-image-stream","content":{"type":"image","data":PNG,"mimeType":"image/png","uri":"http://example.invalid/never-fetch"}});
    let event = update_to_agent(TurnId::generate(), decode_update(raw.clone()).unwrap())
        .unwrap()
        .unwrap();
    assert!(
        matches!(event, AgentEvent::Image { message: Some(id), asset, .. } if id.as_str() == "opaque-image-stream" && asset.image().mime() == ImageMime::Png)
    );
    raw["content"]["data"] = serde_json::json!("invalid");
    assert!(update_to_agent(TurnId::generate(), decode_update(raw).unwrap()).is_err());
}
