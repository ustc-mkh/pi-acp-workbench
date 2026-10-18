use super::payload::PayloadStore;
use crate::domain::image::ImageAsset;
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
#[tokio::test]
async fn image_archive_is_immutable_identity_checked_and_detects_corruption() {
    let root =
        std::env::temp_dir().join(format!("workbench-image-archive-{}", uuid::Uuid::new_v4()));
    let store = PayloadStore::new(&root);
    let asset = ImageAsset::from_base64("image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=").unwrap();
    assert!(store.image(asset.image()).await.is_err());
    store.put_image(&asset).await.unwrap();
    store.put_image(&asset).await.unwrap();
    let path = root.join(format!("image-{}.json", asset.image().id()));
    let committed = tokio::fs::read(&path).await.unwrap();
    let loaded = store.image(asset.image()).await.unwrap();
    assert_eq!(loaded.bytes(), asset.bytes());
    assert_eq!(loaded.image(), asset.image());
    let mut bytes = asset.bytes().to_vec();
    *bytes.last_mut().unwrap() ^= 1;
    let mut changed = serde_json::to_value(&asset).unwrap();
    changed["data"] = serde_json::json!(STANDARD.encode(&bytes));
    changed["image"]["sha256"] = serde_json::json!(format!("{:x}", Sha256::digest(&bytes)));
    let changed: ImageAsset = serde_json::from_value(changed).unwrap();
    assert!(
        store.put_image(&changed).await.is_err(),
        "same ID cannot be rebound"
    );
    assert!(
        store.image(changed.image()).await.is_err(),
        "read must compare the full expected descriptor"
    );
    assert_eq!(tokio::fs::read(&path).await.unwrap(), committed);
    tokio::fs::write(&path, b"corrupt image record")
        .await
        .unwrap();
    assert!(store.image(asset.image()).await.is_err());
    tokio::fs::remove_dir_all(root).await.unwrap();
}
