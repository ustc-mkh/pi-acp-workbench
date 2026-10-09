//! Stable error categories for clients; detail is retained for users and durable receipts.
#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("{0}")]
    InvalidParams(String),
    #[error("{0}")]
    Busy(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Io(String),
    #[error("{0}")]
    Agent(String),
    #[error("{0}")]
    Interrupted(String),
    #[error("未知服务操作")]
    UnknownMethod,
    #[error("会话服务正在停止")]
    Stopping,
}
#[derive(Debug, Clone, Copy, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidParams,
    Busy,
    NotFound,
    IoError,
    AgentError,
    Interrupted,
    UnknownMethod,
    Stopping,
}
impl ServiceError {
    pub fn code(&self) -> ErrorCode {
        match self {
            Self::InvalidParams(_) => ErrorCode::InvalidParams,
            Self::Busy(_) => ErrorCode::Busy,
            Self::NotFound(_) => ErrorCode::NotFound,
            Self::Io(_) => ErrorCode::IoError,
            Self::Agent(_) => ErrorCode::AgentError,
            Self::Interrupted(_) => ErrorCode::Interrupted,
            Self::UnknownMethod => ErrorCode::UnknownMethod,
            Self::Stopping => ErrorCode::Stopping,
        }
    }
}
// Legacy worker/storage modules retain their detailed String errors internally.
// Classification is centralized here while clients depend solely on stable codes.
impl From<String> for ServiceError {
    fn from(detail: String) -> Self {
        if detail.contains("不存在") || detail.contains("已删除") {
            Self::NotFound(detail)
        } else if detail.contains("忙碌")
            || detail.contains("正在使用")
            || detail.contains("处理中")
            || detail.contains("正在另一个窗口")
        {
            Self::Busy(detail)
        } else if detail.contains("不会自动重放")
            || detail.contains("未完成")
            || detail.contains("中断")
        {
            Self::Interrupted(detail)
        } else if detail.contains("Permission denied")
            || detail.contains("No such file")
            || detail.contains("Not a directory")
            || detail.contains("无法保存")
            || detail.contains("索引")
            || detail.contains("历史文件")
            || detail.contains("存储")
        {
            Self::Io(detail)
        } else {
            Self::Agent(detail)
        }
    }
}
