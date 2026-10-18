use super::{ids::*, interaction::*, plan::Plan, session::SessionSnapshot};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum DomainEvent {
    SessionCreated(SessionSnapshot),
    /// Internal preparation result; the host publishes only the adopted session.
    ForkPrepared(Box<super::fork::ForkProjection>),
    /// Workflow receipt, not a turn cancellation or SessionState transition.
    ForkCancelled {
        session: SessionId,
        operation: super::ids::OperationId,
    },
    SessionLoaded(SessionSnapshot),
    SessionsListed(Vec<SessionSnapshot>),
    CatalogueChanged {
        session: SessionId,
        catalogue: super::catalogue::Catalogue,
    },
    ProviderSessionAttached {
        session: SessionId,
        provider_session: ProviderSessionId,
    },
    UserPromptAdded {
        session: SessionId,
        turn: TurnId,
        entry: EntryId,
        prompt: String,
    },
    AgentText {
        session: SessionId,
        turn: TurnId,
        entry: EntryId,
        message: Option<ProviderMessageId>,
        text: String,
    },
    AgentImage {
        session: SessionId,
        turn: TurnId,
        entry: EntryId,
        message: Option<ProviderMessageId>,
        image: super::image::ImageRef,
    },
    AgentThought {
        session: SessionId,
        turn: TurnId,
        entry: EntryId,
        message: Option<ProviderMessageId>,
        text: String,
    },
    ToolCallChanged {
        session: SessionId,
        tool: super::tool::ToolCall,
    },
    PlanChanged {
        session: SessionId,
        plan: Plan,
    },
    InteractionRequested {
        session: SessionId,
        interaction: Interaction,
    },
    InteractionResolved {
        session: SessionId,
        resolution: InteractionResolution,
    },
    UsageChanged {
        session: SessionId,
        input_tokens: u64,
        output_tokens: u64,
    },
    ContextUsageChanged {
        session: SessionId,
        used: u64,
        size: u64,
    },
    TurnStarted {
        session: SessionId,
        turn: TurnId,
    },
    TurnFinished {
        session: SessionId,
        turn: TurnId,
    },
    TurnCancelled {
        session: SessionId,
        turn: TurnId,
    },
    SessionError {
        session: SessionId,
        error: String,
    },
    SessionRemoved(SessionId),
}
