use super::{ids::*, interaction::InteractionAnswer, plan::Plan, session::Harness, WorkspacePath};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum DomainCommand {
    CreateSession {
        harness: Harness,
        cwd: WorkspacePath,
    },
    LoadSession(SessionId),
    #[cfg(test)]
    ListSessions,
    Prompt {
        session: SessionId,
        prompt: Prompt,
    },
    RequestCancel {
        session: SessionId,
    },
    Cancel {
        session: SessionId,
    },
    AnswerInteraction {
        session: SessionId,
        answer: InteractionAnswer,
    },
    Fork {
        session: SessionId,
        request: super::fork::ForkRequest,
    },
    CancelFork {
        session: SessionId,
        operation: super::ids::OperationId,
    },
    PrepareFork {
        session: SessionId,
        request: super::fork::ForkRequest,
        candidates: Vec<super::fork::ForkCandidate>,
    },
    AdoptFork {
        projection: Box<super::fork::ForkPlan>,
        native: ProviderSessionId,
    },
    SetModel {
        session: SessionId,
        model: ModelId,
    },
    Discover {
        session: SessionId,
    },
    SetOption {
        session: SessionId,
        id: String,
        value: String,
    },
    SetMode {
        session: SessionId,
        mode: ModeId,
    },
    PrepareConfiguration {
        session: SessionId,
        intent: super::session::ConfigurationIntent,
    },
    CommitConfiguration {
        session: SessionId,
    },
    Manage {
        session: SessionId,
        action: super::management::ManagementAction,
    },
    UndoTurn {
        session: SessionId,
        turn: TurnId,
    },
    RemoveSession(SessionId),
    Inspect(SessionId),
    Agent {
        session: SessionId,
        event: AgentEvent,
    },
}
impl DomainCommand {
    pub(crate) fn is_query(&self) -> bool {
        match self {
            Self::Inspect(_) => true,
            #[cfg(test)]
            Self::ListSessions => true,
            _ => false,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum AgentEvent {
    /// Explicit provider lifecycle evidence; never inferred from idle output.
    AutonomousStarted {
        turn: TurnId,
    },
    Cancelled {
        turn: TurnId,
    },
    Catalogue(super::catalogue::CataloguePatch),
    ConfigurationRestored(super::catalogue::CataloguePatch),
    AvailableCommands(Vec<super::catalogue::AvailableCommand>),
    ProviderSessionAttached {
        id: ProviderSessionId,
    },
    Text {
        turn: TurnId,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<ProviderMessageId>,
    },
    Image {
        turn: TurnId,
        asset: super::image::ImageAsset,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<ProviderMessageId>,
    },
    Thought {
        turn: TurnId,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<ProviderMessageId>,
    },
    ToolCall(super::tool::ToolCallUpdate),
    Plan(Plan),
    Interaction(super::interaction::Interaction),
    Usage {
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: Option<u64>,
        cache_write_tokens: Option<u64>,
    },
    ContextUsage {
        used: u64,
        size: u64,
    },
    Finished {
        turn: TurnId,
    },
    Crashed {
        reason: String,
    },
}
