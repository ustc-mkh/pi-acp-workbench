use super::{client::AcpClient, dto::*, extensions::*};
use crate::{
    domain::{
        fork::{ForkTarget, PrefixHash},
        ids::*,
        session::SessionConfig,
        WorkspacePath,
    },
    worker::WorkerSupervisor,
};
use serde_json::json;
use tokio::sync::mpsc;
#[test]
fn private_methods_require_explicit_versioned_negotiation_not_agent_name() {
    for metadata in [
        json!(null),
        json!({}),
        json!({"pi-workbench":null}),
        json!({"pi-workbench":{"inspect":true,"nativeFork":true}}),
        json!({"pi-workbench":{"version":2,"inspect":true,"nativeFork":true}}),
        json!({"pi-workbench":{"version":1,"nativeFork":true}}),
    ] {
        let capabilities: AgentCapabilities =
            serde_json::from_value(json!({"_meta":metadata})).unwrap();
        assert!(!capabilities.metadata.supports_native_fork());
    }
    let capabilities: AgentCapabilities = serde_json::from_value(json!({"_meta":{"pi-workbench":{"version":1,"inspect":true,"nativeFork":true},"future-namespace":{"opaque":"ignored"}}})).unwrap();
    assert!(capabilities.metadata.supports_native_fork());
    assert!(capabilities.metadata.supports_inspection());
    assert!(serde_json::from_value::<AgentCapabilities>(
        json!({"_meta":{"pi-workbench":{"version":1,"nativeFork":"yes"}}})
    )
    .is_err());
}
#[test]
fn inspection_validates_native_identity_digest_key_role_and_duplicate_nodes() {
    let point = json!({"entryId":"native-1","hash":"a".repeat(64),"role":"user","key":format!("user:{}", "b".repeat(64)),"safe":true,"timestamp":1700000000000_u64});
    let decoded: InspectResponse = serde_json::from_value(json!({"forkPoints":[point.clone()],"records":[{"opaque-provider-usage":"not propagated"}]})).unwrap();
    let converted = decoded.candidates().unwrap();
    assert_eq!(converted.len(), 1);
    assert_eq!(converted[0].target.entry.as_str(), "native-1");
    for replacement in [
        json!({"entryId":""}),
        json!({"hash":"short"}),
        json!({"role":"secret-invalid-role"}),
    ] {
        let mut malformed = point.clone();
        for (key, value) in replacement.as_object().unwrap() {
            malformed[key] = value.clone();
        }
        assert!(
            serde_json::from_value::<InspectResponse>(json!({"forkPoints":[malformed]})).is_err()
        );
    }
    let mut wrong = point.clone();
    wrong["key"] = json!(format!("assistant:{}", "b".repeat(64)));
    assert!(
        serde_json::from_value::<InspectResponse>(json!({"forkPoints":[wrong]}))
            .unwrap()
            .candidates()
            .is_err()
    );
    assert!(
        serde_json::from_value::<InspectResponse>(json!({"forkPoints":[point.clone(),point]}))
            .unwrap()
            .candidates()
            .is_err()
    );
    let source = NativeSessionId::try_from("source".to_owned()).unwrap();
    assert!(ForkResponse {
        session_id: source.clone()
    }
    .independent(&source)
    .is_err());
}
#[test]
fn captured_pi_1_3_native_offline_response_passes_the_new_typed_boundary() {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Capture {
        capabilities: AgentCapabilities,
        inspection: InspectResponse,
        fork_responses: Vec<ForkResponse>,
    }
    let capture: Capture = serde_json::from_str(include_str!(
        "../../../../../test/fixtures/rewrite/pi-sdk-1.3.0-native-offline.json"
    ))
    .unwrap();
    assert!(
        capture.capabilities.load_session && capture.capabilities.metadata.supports_native_fork()
    );
    let points = capture.inspection.candidates().unwrap();
    assert_eq!(points.len(), 6);
    assert!(
        !points
            .iter()
            .any(|point| point.target.entry.as_str() == "a2"),
        "unsafe tool intermediate must not become a target"
    );
    let first = points
        .iter()
        .find(|point| point.target.entry.as_str() == "u1")
        .unwrap();
    assert_eq!(
        first.text,
        crate::domain::fork::ContentHash::of("first question")
    );
    assert!(capture
        .fork_responses
        .into_iter()
        .next()
        .unwrap()
        .independent(&NativeSessionId::try_from("recorded-source".to_string()).unwrap())
        .is_ok());
}
#[test]
fn unsafe_pi_intermediate_points_may_have_empty_hash_without_hiding_safe_neighbors() {
    let safe = json!({"entryId":"safe-user","hash":"a".repeat(64),"role":"user","key":format!("user:{}", "b".repeat(64)),"safe":true});
    let unsafe_point = json!({"entryId":"pending-tool","hash":"","role":"assistant","key":format!("assistant:{}", "c".repeat(64)),"safe":false});
    let response: InspectResponse =
        serde_json::from_value(json!({"forkPoints":[safe.clone(),unsafe_point.clone()]})).unwrap();
    let candidates = response.candidates().unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].target.entry.as_str(), "safe-user");
    let mut invalid_safe = unsafe_point.clone();
    invalid_safe["safe"] = json!(true);
    assert!(
        serde_json::from_value::<InspectResponse>(json!({"forkPoints":[invalid_safe]}))
            .unwrap()
            .candidates()
            .is_err()
    );
    let mut duplicate = unsafe_point;
    duplicate["entryId"] = json!("safe-user");
    assert!(
        serde_json::from_value::<InspectResponse>(json!({"forkPoints":[safe,duplicate]}))
            .unwrap()
            .candidates()
            .is_err()
    );
}
#[tokio::test]
async fn typed_native_fork_preserves_source_and_loads_independent_historical_settings_without_text_reseed(
) {
    let root =
        std::env::temp_dir().join(format!("workbench-native-client-{}", uuid::Uuid::new_v4()));
    let peer =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test/contract-agent.mjs");
    let supervisor = WorkerSupervisor::new(
        "node".into(),
        vec![peer.to_string_lossy().into_owned()],
        std::collections::HashMap::from([(
            "WORKBENCH_CONTRACT_NATIVE_STATE".into(),
            root.to_string_lossy().into_owned(),
        )]),
        1,
    );
    let (tx, _updates) = mpsc::channel(32);
    let client = AcpClient::new(supervisor.spawn(SessionId::generate(), tx).await.unwrap());
    let metadata = client
        .initialize()
        .await
        .unwrap()
        .agent_capabilities
        .metadata;
    let created = client
        .new_session(&WorkspacePath::new("/tmp").unwrap())
        .await
        .unwrap();
    let source = created.session_id;
    let mut details = created.details;
    client
        .prompt(
            source.clone(),
            vec![super::ContentBlock::text("fork source")],
        )
        .await
        .unwrap();
    client
        .configure(
            &source,
            &mut details,
            &SessionConfig {
                options: Default::default(),
                model: Some(ModelId::new("other").unwrap()),
                mode: Some(ModeId::new("high").unwrap()),
            },
        )
        .await
        .unwrap();
    client
        .prompt(
            source.clone(),
            vec![super::ContentBlock::text("after settings")],
        )
        .await
        .unwrap();
    let before = tokio::fs::read(root.join(format!("{}.json", source.as_str())))
        .await
        .unwrap();
    let points = client.fork_points(&source, &metadata).await.unwrap();
    assert_eq!(points.len(), 4);
    let target = points[0].target.clone();
    assert!(client
        .fork_native(&source, &target, &ProviderMetadata::default())
        .await
        .is_err());
    let stale = ForkTarget {
        entry: target.entry.clone(),
        prefix: PrefixHash::new("0".repeat(64)).unwrap(),
    };
    assert!(client
        .fork_native(&source, &stale, &metadata)
        .await
        .is_err());
    let forked = client
        .fork_native(&source, &target, &metadata)
        .await
        .unwrap();
    assert_ne!(forked.as_str(), source.as_str());
    client.cancel_native_fork(&source, &metadata).await.unwrap();
    assert_eq!(
        tokio::fs::read(root.join(format!("{}.json", source.as_str())))
            .await
            .unwrap(),
        before
    );
    client.stop().await;
    let (tx, _updates) = mpsc::channel(32);
    let branch = AcpClient::new(supervisor.spawn(SessionId::generate(), tx).await.unwrap());
    branch.initialize().await.unwrap();
    let native = NativeSessionId::try_from(forked.as_str().to_owned()).unwrap();
    let loaded = branch
        .load_session(&WorkspacePath::new("/tmp").unwrap(), native.clone())
        .await
        .unwrap();
    assert_eq!(loaded.details.select("model").unwrap().1, "default");
    assert_eq!(loaded.details.modes.unwrap().current_mode_id, "low");
    branch
        .prompt(
            native,
            vec![super::ContentBlock::text("branch continuation")],
        )
        .await
        .unwrap();
    #[derive(serde::Deserialize)]
    struct NativeState {
        entries: Vec<NativeEntry>,
    }
    #[derive(serde::Deserialize)]
    struct NativeEntry {
        text: String,
    }
    let native: NativeState = serde_json::from_slice(
        &tokio::fs::read(root.join(format!("{forked}.json")))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        native
            .entries
            .iter()
            .map(|entry| entry.text.as_str())
            .collect::<Vec<_>>(),
        [
            "fork source",
            "branch continuation",
            "echo: branch continuation"
        ]
    );
    assert_eq!(
        tokio::fs::read(root.join(format!("{}.json", source.as_str())))
            .await
            .unwrap(),
        before
    );
    branch.stop().await;
    supervisor.shutdown().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
