use super::content::ContentBlock;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct NativeSessionId(String);
impl NativeSessionId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl TryFrom<String> for NativeSessionId {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
            return Err("invalid native session ID");
        }
        Ok(Self(value))
    }
}
impl From<NativeSessionId> for String {
    fn from(value: NativeSessionId) -> Self {
        value.0
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeRequest {
    pub protocol_version: u32,
    pub client_info: ClientInfo,
    pub client_capabilities: ClientCapabilities,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCapabilities {
    #[serde(default)]
    pub fs: FilesystemCapabilities,
    #[serde(default)]
    pub terminal: bool,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemCapabilities {
    #[serde(default)]
    pub read_text_file: bool,
    #[serde(default)]
    pub write_text_file: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResponse {
    pub protocol_version: u32,
    #[serde(default)]
    pub agent_info: Option<ClientInfo>,
    #[serde(default)]
    pub agent_capabilities: AgentCapabilities,
    #[serde(default)]
    pub auth_methods: Vec<AuthMethod>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    #[serde(
        default,
        rename = "_meta",
        deserialize_with = "super::extensions::deserialize_metadata",
        skip_serializing_if = "super::extensions::ProviderMetadata::is_empty"
    )]
    pub metadata: super::extensions::ProviderMetadata,
    #[serde(default)]
    pub load_session: bool,
    #[serde(default)]
    pub prompt_capabilities: PromptCapabilities,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptCapabilities {
    #[serde(default)]
    pub image: bool,
    #[serde(default)]
    pub audio: bool,
    #[serde(default)]
    pub embedded_context: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AuthMethod {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionRequest {
    pub cwd: String,
    pub mcp_servers: Vec<McpServer>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<EnvironmentVariable>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EnvironmentVariable {
    pub name: String,
    pub value: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionResponse {
    pub session_id: NativeSessionId,
    #[serde(flatten)]
    pub details: super::settings::SessionDetails,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LoadSessionResponse {
    #[serde(flatten)]
    pub details: super::settings::SessionDetails,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadSessionRequest {
    pub cwd: String,
    pub session_id: NativeSessionId,
    pub mcp_servers: Vec<McpServer>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPromptRequest {
    pub session_id: NativeSessionId,
    pub prompt: Vec<ContentBlock>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRequest {
    pub session_id: NativeSessionId,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptResponse {
    pub stop_reason: StopReason,
    #[serde(default)]
    pub usage: Option<TokenUsage>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    MaxTurnRequests,
    Refusal,
    Cancelled,
    #[serde(other)]
    Unknown,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub cached_read_tokens: Option<u64>,
    #[serde(default)]
    pub cached_write_tokens: Option<u64>,
    #[serde(default)]
    pub total_tokens: Option<u64>,
}
#[derive(Clone, Debug)]
pub struct SessionNotification {
    pub session_id: NativeSessionId,
    pub update: SessionUpdate,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "sessionUpdate")]
pub enum SessionUpdate {
    #[serde(rename = "agent_message_chunk")]
    AgentMessage {
        content: ContentBlock,
        #[serde(default, rename = "messageId", skip_serializing_if = "Option::is_none")]
        message_id: Option<crate::domain::ProviderMessageId>,
    },
    #[serde(rename = "agent_thought_chunk")]
    AgentThought {
        content: ContentBlock,
        #[serde(default, rename = "messageId", skip_serializing_if = "Option::is_none")]
        message_id: Option<crate::domain::ProviderMessageId>,
    },
    #[serde(rename = "user_message_chunk")]
    UserMessage { content: ContentBlock },
    #[serde(rename = "tool_call", rename_all = "camelCase")]
    ToolCall {
        tool_call_id: String,
        title: String,
        #[serde(default)]
        status: Option<ToolStatus>,
        #[serde(flatten)]
        details: super::tool::ToolDetailsPatch,
    },
    #[serde(rename = "tool_call_update", rename_all = "camelCase")]
    ToolCallUpdate {
        tool_call_id: String,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        status: Option<ToolStatus>,
        #[serde(flatten)]
        details: super::tool::ToolDetailsPatch,
    },
    #[serde(rename = "plan")]
    Plan { entries: Vec<PlanEntry> },
    #[serde(rename = "usage_update")]
    Usage { used: u64, size: u64 },
    #[serde(rename = "available_commands_update", rename_all = "camelCase")]
    AvailableCommands {
        available_commands: Vec<AvailableCommand>,
    },
    #[serde(rename = "config_option_update", rename_all = "camelCase")]
    ConfigOptions {
        config_options: Vec<super::settings::ConfigOption>,
    },
    #[serde(rename = "current_mode_update", rename_all = "camelCase")]
    CurrentMode { current_mode_id: String },
    #[serde(rename = "unknown")]
    Unknown { name: String },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlanEntry {
    pub content: String,
    pub status: PlanStatus,
    #[serde(default)]
    pub priority: Option<PlanPriority>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    Pending,
    InProgress,
    Completed,
    #[serde(other)]
    Unknown,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanPriority {
    High,
    Medium,
    Low,
    #[serde(other)]
    Unknown,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
    #[serde(other)]
    Unknown,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AvailableCommand {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub input: Option<CommandInput>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CommandInput {
    pub hint: String,
}
