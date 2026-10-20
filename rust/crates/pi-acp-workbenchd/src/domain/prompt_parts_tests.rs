use super::ids::{Prompt, PromptPart};

#[test]
fn typed_input_preserves_order_identity_sources_and_scalar_budget() {
    let text = PromptPart::Text {
        text: "你好🌏".into(),
    };
    let context = PromptPart::Context {
        id: "selection-1".into(),
        name: "src/a.rs:1-2".into(),
        text: "explicit selection".into(),
    };
    let first = Prompt::from_parts(vec![text.clone(), context.clone()]).unwrap();
    let reversed = Prompt::from_parts(vec![context.clone(), text.clone()]).unwrap();
    assert_ne!(
        serde_json::to_vec(&first).unwrap(),
        serde_json::to_vec(&reversed).unwrap()
    );
    assert!(first.as_str().contains("src/a.rs:1-2"));
    assert_eq!(
        serde_json::from_slice::<Prompt>(&serde_json::to_vec(&first).unwrap()).unwrap(),
        first
    );
    assert!(Prompt::from_parts(vec![context.clone(), context]).is_err());
    assert!(Prompt::new("🌏".repeat(100000)).is_ok());
    assert!(Prompt::new("中".repeat(100001)).is_err());
    assert!(serde_json::from_str::<Prompt>("\"old string prompt\"").is_err());
}

#[test]
fn image_input_decodes_reencodes_and_rejects_corruption_and_pixel_bombs() {
    use super::image::{ImageAsset, ImageMime};
    let mut encoded = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(2, 2)
        .write_to(&mut encoded, image::ImageFormat::Png)
        .unwrap();
    let clean = encoded.into_inner();
    let mut trailing = clean.clone();
    trailing.extend_from_slice(b"untrusted trailing metadata");
    let asset = ImageAsset::new(ImageMime::Png, trailing).unwrap();
    let sanitized = asset.sanitize_input().unwrap();
    assert_eq!(sanitized.image().id(), asset.image().id());
    assert_eq!(sanitized.bytes(), clean);
    let mut corrupt = clean.clone();
    corrupt.truncate(25);
    assert!(ImageAsset::new(ImageMime::Png, corrupt)
        .unwrap()
        .sanitize_input()
        .is_err());
    // Encode valid PNGs, including correct CRCs: malformed headers would only
    // prove corruption rejection, not the independent dimension/pixel limits.
    for (width, height, allowed) in [(8192, 1, true), (8193, 1, false), (8192, 2048, false)] {
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(width, height)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let image = ImageAsset::new(ImageMime::Png, png.into_inner()).unwrap();
        assert_eq!(image.sanitize_input().is_ok(), allowed, "{width}x{height}");
    }
}

#[test]
fn input_context_has_utf8_and_source_budgets() {
    assert!(Prompt::from_parts(vec![PromptPart::Context {
        id: "a".into(),
        name: "source".into(),
        text: "中".repeat(21846)
    }])
    .is_err());
    assert!(Prompt::from_parts(vec![PromptPart::Context {
        id: "a".into(),
        name: "bad\nsource".into(),
        text: "x".into()
    }])
    .is_err());
}
