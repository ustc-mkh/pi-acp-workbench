#[cfg(test)]
mod tests {
    use crate::{
        domain::{session::SessionConfig, Harness, SessionId, SessionState, SessionStatus},
        persistence::{checksum, HistorySnapshot, HistoryStore, FORMAT_VERSION},
    };

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
    async fn history_rejects_wrong_version_identity_revision_and_checksum() {
        let state = state();
        let root = std::env::temp_dir().join(format!("workbench-history-{}", state.id));
        let store = HistoryStore::fixture(&root);
        store.save(&state).await.unwrap();
        let path = root.join(format!("{}.json", state.id));
        let original: HistorySnapshot =
            serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(
            store
                .load(state.id.as_str())
                .await
                .unwrap()
                .unwrap()
                .revision,
            7
        );
        for fault in 0..4 {
            let mut snapshot = original.clone();
            match fault {
                0 => snapshot.format_version = FORMAT_VERSION - 1,
                1 => {
                    snapshot.session.id = SessionId::generate();
                    snapshot.checksum = checksum(&snapshot.session).unwrap();
                }
                2 => snapshot.revision += 1,
                _ => snapshot.session.cwd = crate::domain::WorkspacePath::new("/tampered").unwrap(),
            }
            tokio::fs::write(&path, serde_json::to_vec(&snapshot).unwrap())
                .await
                .unwrap();
            assert!(
                store.load(state.id.as_str()).await.is_err(),
                "fault {fault}"
            );
        }
        tokio::fs::write(&path, b"{truncated").await.unwrap();
        assert!(store.load(state.id.as_str()).await.is_err());
        assert!(store.load("../escape").await.is_err());
        assert!(store.remove("../escape").await.is_err());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn leftover_temporary_file_is_not_a_commit() {
        let mut state = state();
        let root = std::env::temp_dir().join(format!("workbench-history-temp-{}", state.id));
        let store = HistoryStore::fixture(&root);
        store.save(&state).await.unwrap();
        state.revision += 1;
        let snapshot = HistorySnapshot {
            format_version: FORMAT_VERSION,
            revision: state.revision,
            checksum: checksum(&state).unwrap(),
            session: state.clone(),
            delivery_events: Default::default(),
        };
        tokio::fs::write(
            root.join(format!("{}.crashed.tmp", state.id)),
            serde_json::to_vec(&snapshot).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(
            store
                .load(state.id.as_str())
                .await
                .unwrap()
                .unwrap()
                .revision,
            7
        );
        store.save(&state).await.unwrap();
        assert_eq!(
            store
                .load(state.id.as_str())
                .await
                .unwrap()
                .unwrap()
                .revision,
            8
        );
        store.remove(state.id.as_str()).await.unwrap();
        assert!(store.load(state.id.as_str()).await.unwrap().is_none());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
