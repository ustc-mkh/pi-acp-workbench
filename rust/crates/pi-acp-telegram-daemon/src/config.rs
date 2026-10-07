//! telegramConfig() port (src/telegram-config.ts).
use serde_json::Value;
use std::collections::BTreeMap;

pub struct Config {
    pub chat_id: i64,
    pub allowed_user_ids: Vec<i64>,
    pub workspaces: BTreeMap<String, String>,
    pub restrict_to_workspaces: bool,
}

pub fn parse(value: &Value) -> Result<Config, String> {
    let v = value.as_object().ok_or("Telegram 配置必须为 JSON 对象。")?;
    let chat_id = v
        .get("chatId")
        .and_then(Value::as_i64)
        .filter(|id| *id < 0)
        .ok_or("chatId 必须是私人 Topics 超级群组的负整数 ID。")?;
    let users = v
        .get("allowedUserIds")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .ok_or("allowedUserIds 必须包含至少一个明确允许的 Telegram 用户数字 ID。")?;
    let mut allowed = Vec::new();
    for id in users {
        allowed.push(
            id.as_i64()
                .filter(|id| *id > 0)
                .ok_or("allowedUserIds 必须包含至少一个明确允许的 Telegram 用户数字 ID。")?,
        );
    }
    let mut workspaces = BTreeMap::new();
    if let Some(map) = v.get("workspaces") {
        let map = map
            .as_object()
            .ok_or("workspaces 必须是工作区名称到本机目录的映射。")?;
        for (name, path) in map {
            let valid_name = !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                && !["__proto__", "constructor", "prototype"].contains(&name.as_str());
            let path = path.as_str().filter(|p| !p.trim().is_empty());
            if !valid_name || path.is_none() {
                return Err("workspaces 必须是工作区名称到本机目录的映射。".into());
            }
            workspaces.insert(name.clone(), path.unwrap().to_string());
        }
    }
    let restrict_to_workspaces = match v.get("restrictToWorkspaces") {
        None => false,
        Some(value) => value
            .as_bool()
            .ok_or("restrictToWorkspaces 必须是布尔值。")?,
    };
    let unknown: Vec<&str> = v
        .keys()
        .map(String::as_str)
        .filter(|k| {
            ![
                "chatId",
                "allowedUserIds",
                "workspaces",
                "restrictToWorkspaces",
            ]
            .contains(k)
        })
        .collect();
    if !unknown.is_empty() {
        return Err(format!(
            "不支持的 Telegram 配置字段：{}",
            unknown.join(", ")
        ));
    }
    Ok(Config {
        chat_id: chat_id,
        allowed_user_ids: allowed,
        workspaces,
        restrict_to_workspaces,
    })
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
