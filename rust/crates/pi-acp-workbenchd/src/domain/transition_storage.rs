//! Lossless typed projection for the T04 SQL session commit path. No I/O.
use super::{
    fork::ContentHash,
    ids::ContentId,
    query::{ContentKind, ContentRef, QueryError, SafeInteger, SessionView, ToolBody, ToolHeader},
    tool::{ToolCall, ToolContent},
    transition::{NewContent, ToolUpdate},
    SessionState,
};

impl SessionView {
    /// The SQL link sequence is supplied by the caller; it is not a timestamp.
    pub fn from_state(
        state: &SessionState,
        last_entry_seq: SafeInteger,
    ) -> Result<Self, QueryError> {
        let view = Self {
            id: state.id.clone(),
            provider_session: state.provider_session.clone(),
            harness: state.harness.clone(),
            cwd: state.cwd.clone(),
            status: state.status.clone(),
            config: state.config.clone(),
            configuration_intent: state.configuration_intent.clone(),
            catalogue: state.catalogue.clone(),
            plan: state.plan.clone(),
            usage: state.usage.clone(),
            active_turn: state.active_turn.clone(),
            pending_interactions: state.pending_interactions.clone(),
            origin: state.transcript.origin.clone(),
            revision: SafeInteger::new(state.revision)?,
            last_entry_seq,
        };
        view.validate()?;
        Ok(view)
    }
}

impl ToolUpdate {
    /// Partial tool updates replace headers, never overwrite immutable content.
    /// Identical bodies share refs; kind is part of the content identity.
    pub fn from_call(call: &ToolCall) -> Result<Self, QueryError> {
        let mut contents = Vec::new();
        let mut archive = |text: &str, kind: ContentKind| -> Result<ContentRef, QueryError> {
            let sha256 = ContentHash::of(text);
            let namespace = match kind {
                ContentKind::Text => "text",
                ContentKind::ToolText => "text",
                ContentKind::ToolDiff => "diff",
                ContentKind::ToolResource => "resource",
            };
            let item = NewContent {
                content: ContentRef {
                    id: ContentId::new(format!("tool-{namespace}-{}", sha256.as_str()))
                        .map_err(|_| QueryError::InvalidInput)?,
                    sha256,
                    bytes: SafeInteger::new(text.len() as u64)?,
                    kind,
                },
                text: text.into(),
            };
            item.validate()?;
            let reference = item.content.clone();
            contents.push(item);
            Ok(reference)
        };
        let mut bodies = Vec::new();
        for body in &call.details.content {
            bodies.push(match body {
                ToolContent::Text { text } => ToolBody::Text {
                    content: archive(text, ContentKind::ToolText)?,
                },
                ToolContent::Diff {
                    path,
                    old_text,
                    new_text,
                } => ToolBody::Diff {
                    path: path.clone(),
                    old_text: old_text
                        .as_deref()
                        .map(|text| archive(text, ContentKind::ToolDiff))
                        .transpose()?,
                    new_text: archive(new_text, ContentKind::ToolDiff)?,
                },
                ToolContent::ResourceText {
                    uri,
                    text,
                    mime_type,
                } => ToolBody::ResourceText {
                    uri: uri.clone(),
                    content: archive(text, ContentKind::ToolResource)?,
                    mime_type: mime_type.clone(),
                },
                ToolContent::ResourceLink {
                    uri,
                    name,
                    mime_type,
                } => ToolBody::ResourceLink {
                    uri: uri.clone(),
                    name: name.clone(),
                    mime_type: mime_type.clone(),
                },
                ToolContent::TerminalReference { id } => {
                    ToolBody::TerminalReference { id: id.clone() }
                }
                ToolContent::Unsupported { kind } => ToolBody::Unsupported { kind: kind.clone() },
            });
        }
        let header = ToolHeader {
            id: call.id.clone(),
            turn: call.turn.clone(),
            status: call.status.clone(),
            kind: call.details.kind.clone(),
            title: call.title.clone(),
            name: call.details.name.clone(),
            locations: call.details.locations.clone(),
            content: bodies,
        };
        header.validate()?;
        Ok(Self { header, contents })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        ids::{TerminalId, ToolCallId, TurnId},
        tool::{ToolDetails, ToolKind, ToolLocation, ToolStatus, UnsupportedToolContent},
    };

    #[test]
    fn sql_projection_view_preserves_hot_identity_without_serializing_transcript() {
        #[derive(serde::Deserialize)]
        struct Fixture {
            view: SessionView,
        }
        let expected = serde_json::from_str::<Fixture>(include_str!(
            "../../../../../test/fixtures/rewrite/ipc-v3.json"
        ))
        .unwrap()
        .view;
        let mut state = SessionState {
            id: expected.id.clone(),
            provider_session: expected.provider_session.clone(),
            harness: expected.harness.clone(),
            cwd: expected.cwd.clone(),
            status: expected.status.clone(),
            transcript: super::super::transcript::Transcript {
                origin: expected.origin.clone(),
                entries: vec![],
                tools: Default::default(),
            },
            plan: expected.plan.clone(),
            active_turn: expected.active_turn.clone(),
            pending_interactions: expected.pending_interactions.clone(),
            usage: expected.usage.clone(),
            config: expected.config.clone(),
            configuration_intent: expected.configuration_intent.clone(),
            catalogue: expected.catalogue.clone(),
            revision: expected.revision.get(),
        };
        state
            .transcript
            .entries
            .push(super::super::transcript::TranscriptEntry {
                id: super::super::EntryId::generate(),
                turn: TurnId::generate(),
                role: super::super::transcript::EntryRole::Agent,
                text: "old entry never in hot JSON".repeat(100_000),
                message: None,
                image: None,
            });
        let projected = SessionView::from_state(&state, expected.last_entry_seq).unwrap();
        assert_eq!(
            serde_json::to_vec(&projected).unwrap(),
            serde_json::to_vec(&expected).unwrap()
        );
        let encoded = serde_json::to_string(&projected).unwrap();
        assert!(!encoded.contains("transcript"));
        assert!(!encoded.contains("old entry never in hot JSON"));
        state.revision = super::super::query::MAX_SAFE_INTEGER + 1;
        assert!(SessionView::from_state(&state, expected.last_entry_seq).is_err());
    }

    #[test]
    fn sql_projection_tool_archives_large_bodies_but_retains_all_display_metadata() {
        let text = "中🌏\n\"\\".repeat(10_000);
        let call = ToolCall {
            id: ToolCallId::new("tool/opaque").unwrap(),
            turn: TurnId::generate(),
            title: "exact title".into(),
            status: ToolStatus::InProgress,
            details: ToolDetails {
                kind: Some(ToolKind::Edit),
                name: Some("tool name".into()),
                locations: vec![ToolLocation {
                    path: "../../untrusted".into(),
                    line: Some(7),
                }],
                content: vec![
                    ToolContent::Text { text: text.clone() },
                    ToolContent::Diff {
                        path: "../../untrusted".into(),
                        old_text: Some(text.clone()),
                        new_text: "new 🌏".into(),
                    },
                    ToolContent::Diff {
                        path: "empty old".into(),
                        old_text: None,
                        new_text: String::new(),
                    },
                    ToolContent::ResourceText {
                        uri: "https://never-fetched.invalid".into(),
                        text: text.clone(),
                        mime_type: Some("text/plain".into()),
                    },
                    ToolContent::ResourceLink {
                        uri: "file:///never-opened".into(),
                        name: "name".into(),
                        mime_type: None,
                    },
                    ToolContent::TerminalReference {
                        id: TerminalId::new("display-only").unwrap(),
                    },
                    ToolContent::Unsupported {
                        kind: UnsupportedToolContent::Image,
                    },
                ],
            },
        };
        let update = ToolUpdate::from_call(&call).unwrap();
        assert_eq!(update.header.id, call.id);
        assert_eq!(update.header.turn, call.turn);
        assert_eq!(update.header.status, call.status);
        assert_eq!(update.header.title, call.title);
        assert_eq!(update.header.kind, call.details.kind);
        assert_eq!(update.header.name, call.details.name);
        assert_eq!(update.header.locations, call.details.locations);
        assert_eq!(update.contents.len(), 5);
        assert!(crate::domain::query::json_bytes(&update.header, 4096).is_ok());
        assert_eq!(update.contents[0].text, text);
        assert_ne!(
            update.contents[0].content.id, update.contents[1].content.id,
            "same bytes with different typed kinds cannot alias"
        );
        let again = ToolUpdate::from_call(&call).unwrap();
        assert_eq!(update.contents[0].content, again.contents[0].content);
        for item in update.contents {
            item.validate().unwrap();
        }
        let mut oversized_metadata = call;
        oversized_metadata.title = "x".repeat(crate::domain::query::MAX_QUERY_BYTES + 1);
        assert!(matches!(
            ToolUpdate::from_call(&oversized_metadata),
            Err(QueryError::TooLarge)
        ));
    }
}
