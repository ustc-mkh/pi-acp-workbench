//! Telegram relay configuration validation.
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub chat_id: i64,
    pub allowed_user_ids: Vec<i64>,
    #[serde(default)]
    pub workspaces: BTreeMap<String, String>,
    #[serde(default)]
    pub restrict_to_workspaces: bool,
    #[serde(default)]
    pub service_socket: Option<String>,
}

pub fn parse(value: &Value) -> Result<Config, String> {
    let config: Config =
        serde_json::from_value(value.clone()).map_err(|e| format!("Telegram 配置无效：{e}"))?;
    if config
        .service_socket
        .as_ref()
        .is_some_and(|path| !std::path::Path::new(path).is_absolute())
    {
        return Err("serviceSocket 必须为绝对路径。".into());
    }
    if config.chat_id >= 0 {
        return Err("chatId 必须是私人 Topics 超级群组的负整数 ID。".into());
    }
    if config.allowed_user_ids.is_empty() || config.allowed_user_ids.iter().any(|id| *id <= 0) {
        return Err("allowedUserIds 必须包含至少一个明确允许的 Telegram 用户数字 ID。".into());
    }
    for (name, path) in &config.workspaces {
        let valid_name = !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            && !["__proto__", "constructor", "prototype"].contains(&name.as_str());
        if !valid_name || path.trim().is_empty() {
            return Err("workspaces 必须是工作区名称到本机目录的映射。".into());
        }
    }
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_workspace_restriction() {
        assert!(
            !parse(&json!({"chatId":-1,"allowedUserIds":[1]}))
                .unwrap()
                .restrict_to_workspaces
        );
        assert!(
            parse(&json!({"chatId":-1,"allowedUserIds":[1],"restrictToWorkspaces":true}))
                .unwrap()
                .restrict_to_workspaces
        );
        assert!(
            parse(&json!({"chatId":-1,"allowedUserIds":[1],"restrictToWorkspaces":"yes"})).is_err()
        );
    }
}
