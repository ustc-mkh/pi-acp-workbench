#[cfg(test)]
mod tests {
    use crate::{
        domain::{session::SessionConfig, Harness, SessionId, SessionState, SessionStatus},
        persistence::SessionStore,
    };
    use rusqlite::Connection;
    fn state() -> SessionState {
        SessionState {
            id: SessionId::generate(),
            provider_session: None,
            harness: Harness::Pi,
            cwd: crate::domain::WorkspacePath::new("/tmp").unwrap(),
            status: SessionStatus::Idle,
            transcript: Default::default(),
            plan: Default::default(),
            active_turn: None,
            pending_interactions: Default::default(),
            usage: Default::default(),
            configuration_intent: None,
            config: SessionConfig {
                model: None,
                mode: None,
            },
            catalogue: Default::default(),
            revision: 7,
        }
    }
    #[tokio::test]
    async fn sql_hot_state_identity_revision_and_typed_json_corruption_fail_closed() {
        for mutation in [
            "UPDATE sessions SET revision=revision+1",
            "UPDATE sessions SET cwd='/'",
            "UPDATE sessions SET hot_state_json='{}'",
        ] {
            let state = state();
            let root = std::env::temp_dir()
                .join(format!("workbench-corrupt-state-{}", uuid::Uuid::new_v4()));
            let store = SessionStore::fixture(&root);
            store.save(&state).await.unwrap();
            store.payloads.shutdown().await;
            let database = Connection::open(root.join("workbench.sqlite3")).unwrap();
            database.execute(mutation, []).unwrap();
            database.close().unwrap();
            let reopened = SessionStore::fixture(&root);
            assert!(
                reopened.load(state.id.as_str()).await.is_err(),
                "{mutation}"
            );
            assert!(reopened.load("../escape").await.is_err());
            assert!(reopened.remove("../escape").await.is_err());
            reopened.payloads.shutdown().await;
            tokio::fs::remove_dir_all(root).await.unwrap();
        }
    }
    #[tokio::test]
    async fn stored_session_ignores_untrusted_json_files_and_writes_no_business_file_protocol() {
        let state = state();
        let root = std::env::temp_dir().join(format!("workbench-no-json-{}", uuid::Uuid::new_v4()));
        let store = SessionStore::fixture(&root);
        store.save(&state).await.unwrap();
        let mut names = tokio::fs::read_dir(&root).await.unwrap();
        let mut found = Vec::new();
        while let Some(entry) = names.next_entry().await.unwrap() {
            found.push(entry.file_name().to_string_lossy().to_string());
        }
        assert!(!found.iter().any(|name| name == "history"
            || name == "journal"
            || name == "outbox"
            || name == "payloads"));
        assert!(!found
            .iter()
            .any(|name| name.ends_with(".json") && name != "storage-format.json"));
        store.payloads.shutdown().await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
