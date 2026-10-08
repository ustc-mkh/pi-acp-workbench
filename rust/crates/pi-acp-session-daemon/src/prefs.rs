//! session-preferences.ts + session-settings.ts + applyPreferences port.
//!
//! preferences/<harness>.json: {version:1, preferences:[{kind,value}]} —
//! kinds ⊆ {model, thinking}; ≤2 entries, unique kinds, value 1..=10000 chars.
//! read(): ENOENT → []; malformed → '模型偏好格式不受支持或已损坏，原文件未修改：{file}'.
//! save(): never silently replace corrupt data — read() must succeed first;
//! empty preference set → no write; durable atomic write.
//!
//! Model/thinking preferences use current ACP configOptions only.
//! Model is applied first so the latest thinking catalogue is used.
//! Standard session modes are not inherited as model/thinking preferences.
use crate::agent::AgentProcess;
use crate::types::ChatState;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::LazyLock;

static THINKING_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^(?:thinking(?:[ _-]level)?|thought[ _-]level|reasoning(?:[ _-](?:effort|level))?)$",
    )
    .unwrap()
});
fn is_harness_id(value: &str) -> bool {
    matches!(value, "pi" | "codex" | "claude")
}

/// JS property read coerced for selector comparisons: strings pass through,
/// everything else reads as absent ('' keeps === and regex tests false).
fn vstr(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

/// 'options' in option ? option.options : [option] — flattened to one level.
fn flatten_options(config_options: Option<&Value>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for option in config_options
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        if let Some(nested) = option.as_object().and_then(|o| o.get("options")) {
            match nested.as_array() {
                // flatMap appends a non-array return value as a single element.
                Some(inner) => out.extend(inner.iter().cloned()),
                None => out.push(nested.clone()),
            }
        } else {
            out.push(option);
        }
    }
    out
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionPreference {
    pub kind: String, // model | thinking
    pub value: String,
}

struct Selector {
    category: Option<String>,
    kind: &'static str,
    current: String,
    id: String,
}

fn session_selectors(configs: Option<&[Value]>) -> Vec<Selector> {
    let controls: Vec<Selector> = configs
        .unwrap_or(&[])
        .iter()
        .filter_map(|config| {
            if config.get("type").and_then(Value::as_str) != Some("select") {
                return None;
            }
            let id = vstr(config.get("id"));
            let category = config.get("category").and_then(Value::as_str);
            let kind = if category == Some("model") || id == "model" {
                "model"
            } else if category == Some("thought_level")
                || THINKING_NAME.is_match(id)
                || THINKING_NAME.is_match(vstr(config.get("name")))
            {
                "thinking"
            } else {
                "other"
            };
            Some(Selector {
                category: category.map(str::to_string),
                kind,
                current: vstr(config.get("currentValue")).to_string(),
                id: id.to_string(),
            })
        })
        .collect();
    let thinking_index = controls
        .iter()
        .position(|c| c.category.as_deref() == Some("thought_level"))
        .or_else(|| controls.iter().position(|c| c.kind == "thinking"));
    controls
        .into_iter()
        .enumerate()
        .filter(|(i, c)| c.kind != "thinking" || Some(*i) == thinking_index)
        .map(|(_, c)| c)
        .collect()
}

/// Current ACP model/thinking pair, model first; modes are not inherited.
pub fn model_preferences(state: &ChatState) -> Vec<SessionPreference> {
    let mut preferences: Vec<SessionPreference> = session_selectors(state.configs.as_deref())
        .into_iter()
        .filter(|c| matches!(c.kind, "model" | "thinking"))
        .map(|c| SessionPreference {
            kind: c.kind.to_string(),
            value: c.current,
        })
        .collect();
    preferences.sort_by_key(|a| std::cmp::Reverse(a.kind == "model"));
    preferences
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreferencesFile {
    version: u32,
    preferences: Vec<SessionPreference>,
}

pub struct SessionPreferences {
    directory: PathBuf,
}

impl SessionPreferences {
    pub fn new(directory: PathBuf) -> Self {
        SessionPreferences { directory }
    }

    fn file(&self, harness: &str) -> Result<PathBuf, String> {
        if !is_harness_id(harness) {
            return Err("未知 harness。".into());
        }
        Ok(self.directory.join(format!("{harness}.json")))
    }

    /// Preferences are isolated by harness.
    pub async fn read(&self, harness: &str) -> Result<Vec<SessionPreference>, String> {
        let file = self.file(harness)?;
        let text = match tokio::fs::read_to_string(&file).await {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.to_string()),
        };
        let malformed = || {
            format!(
                "模型偏好格式不受支持或已损坏，原文件未修改：{}",
                file.display()
            )
        };
        let data: PreferencesFile = serde_json::from_str(&text).map_err(|_| malformed())?;
        let mut kinds = std::collections::HashSet::new();
        if data.version != 1
            || data.preferences.len() > 2
            || !data.preferences.iter().all(|p| {
                matches!(p.kind.as_str(), "model" | "thinking")
                    && (1..=10000).contains(&p.value.encode_utf16().count())
                    && kinds.insert(p.kind.as_str())
            })
        {
            return Err(malformed());
        }
        Ok(data.preferences)
    }

    /// Persists model/thinking pair from state; reads first (never blind-overwrite).
    pub async fn save(&self, harness: &str, state: &ChatState) -> Result<(), String> {
        let preferences = model_preferences(state);
        if preferences.is_empty() {
            return Ok(());
        }
        self.read(harness).await?; // Never silently replace corrupt or incompatible data.
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&self.directory)
                .map_err(|e| e.to_string())?;
        }
        #[cfg(not(unix))]
        tokio::fs::create_dir_all(&self.directory)
            .await
            .map_err(|e| e.to_string())?;
        // One atomic pair per harness: concurrent writers cannot mix model and thinking.
        let body = json!({
            "version": 1,
            "preferences": preferences.iter().map(|p| json!({"kind": p.kind, "value": p.value})).collect::<Vec<_>>(),
        });
        pi_acp_core::atomic::write_atomic_json(&self.file(harness)?, &body, true)
            .await
            .map_err(|e| e.to_string())
    }
}

/// applySelection (session-configuration.ts) — validates against the latest
/// catalogue; returns Ok(false) when the selector cannot apply the value.
async fn apply_selection(
    agent: &AgentProcess,
    session: &mut Value,
    id: &str,
    value: &str,
) -> Result<bool, String> {
    let config = session
        .get("configOptions")
        .and_then(Value::as_array)
        .and_then(|list| list.iter().find(|c| vstr(c.get("id")) == id).cloned());
    let Some(config) = config else {
        return Ok(false);
    };
    if vstr(config.get("currentValue")) == value {
        return Ok(true);
    }
    if config.get("type").and_then(Value::as_str) != Some("select")
        || !flatten_options(config.get("options"))
            .iter()
            .any(|o| vstr(o.get("value")) == value)
    {
        return Ok(false);
    }
    let session_id = session.get("sessionId").cloned().unwrap_or(Value::Null);
    let response = agent
        .with_timeout(
            agent.request(
                "session/set_config_option",
                json!({"sessionId": session_id, "configId": id, "value": value}),
            ),
            30_000,
        )
        .await?;
    match response.get("configOptions") {
        Some(options) => {
            session["configOptions"] = options.clone();
        }
        None => {
            // session.configOptions = undefined → JSON.stringify drops the key.
            if let Some(object) = session.as_object_mut() {
                object.remove("configOptions");
            }
        }
    }
    Ok(true)
}

pub async fn apply_preferences(
    agent: &AgentProcess,
    session: &mut Value,
    preferences: &[SessionPreference],
) -> Result<Option<String>, String> {
    let mut unavailable: Vec<String> = Vec::new();
    let mut ordered: Vec<SessionPreference> = preferences.to_vec();
    ordered.sort_by_key(|a| std::cmp::Reverse(a.kind == "model"));
    for preference in &ordered {
        let configs = session
            .get("configOptions")
            .and_then(Value::as_array)
            .cloned();
        let control = session_selectors(configs.as_deref())
            .into_iter()
            .find(|c| c.kind == preference.kind);
        let applied = match control {
            Some(control) => {
                apply_selection(agent, session, &control.id, &preference.value).await?
            }
            None => false,
        };
        if !applied {
            unavailable.push(format!("{}: {}", preference.kind, preference.value));
        }
    }
    Ok(if unavailable.is_empty() {
        None
    } else {
        Some(format!(
            "上次的设置当前不可用（{}），请检查本次模型与思考选项。",
            unavailable.join("、")
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regexes_match_ts() {
        for name in [
            "thinking",
            "Thinking_Level",
            "thought-level",
            "reasoning",
            "reasoning effort",
            "Reasoning_Level",
        ] {
            assert!(THINKING_NAME.is_match(name), "{name}");
        }
        for name in ["thoughtlevel", "reasons", "thinking2", "mode"] {
            assert!(!THINKING_NAME.is_match(name), "{name}");
        }
    }

    #[test]
    fn selectors_classify_and_dedupe() {
        let configs: Vec<Value> = serde_json::from_str(
            r#"[
                {"id":"model","type":"select","category":"model","name":"Model","currentValue":"m1",
                 "options":[{"value":"m1","name":"M1"},{"value":"m2","name":"M2"}]},
                {"id":"thinking_level","type":"select","category":"thought_level","name":"Thinking",
                 "currentValue":"low","options":[{"value":"low","name":"Low"},{"value":"high","name":"High"}]},
                {"id":"thinking-extra","type":"select","name":"thinking","currentValue":"x",
                 "options":[{"value":"x","name":"X"}]},
                {"id":"other","type":"select","name":"Other","currentValue":"o","options":[{"value":"o","name":"O"}]}
            ]"#,
        )
        .unwrap();
        // Duplicate thinking-kind controls collapse to the thought_level one.
        let state = ChatState {
            configs: Some(configs),
            ..Default::default()
        };
        let prefs = model_preferences(&state);
        assert_eq!(
            prefs.iter().map(|p| p.kind.as_str()).collect::<Vec<_>>(),
            ["model", "thinking"]
        );
        assert_eq!(prefs[0].value, "m1");
        assert_eq!(prefs[1].value, "low");
        let state = ChatState {
            configs: None,
            modes: Some(
                json!({"currentModeId":"high","availableModes":[{"id":"high","name":"Thinking: High"}]}),
            ),
            ..Default::default()
        };
        assert!(model_preferences(&state).is_empty());
    }

    #[tokio::test]
    async fn preferences_file_roundtrip_and_corruption() {
        let dir =
            std::env::temp_dir().join(format!("pi-prefs-test-{}", uuid::Uuid::new_v4().simple()));
        let store = SessionPreferences::new(dir.clone());
        assert!(store.read("pi").await.unwrap().is_empty());
        assert!(store.read("bogus").await.is_err());
        let state = ChatState { configs: serde_json::from_str(
            r#"[{"id":"model","type":"select","category":"model","name":"Model","currentValue":"m2","options":[]}]"#,
        )
        .unwrap(), ..Default::default() };
        store.save("pi", &state).await.unwrap();
        let read = store.read("pi").await.unwrap();
        assert_eq!(read.len(), 1);
        assert_eq!(
            (read[0].kind.as_str(), read[0].value.as_str()),
            ("model", "m2")
        );
        // Corrupt file → read fails, save refuses to overwrite.
        std::fs::write(dir.join("pi.json"), "{broken").unwrap();
        let error = store.read("pi").await.unwrap_err();
        assert!(
            error.contains("模型偏好格式不受支持或已损坏，原文件未修改"),
            "{error}"
        );
        assert!(store.save("pi", &state).await.is_err());
        // Wrong shape also fails validation without touching the file.
        std::fs::write(
            dir.join("pi.json"),
            r#"{"version":1,"preferences":[{"kind":"mode","value":"x"}]}"#,
        )
        .unwrap();
        assert!(store.read("pi").await.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
