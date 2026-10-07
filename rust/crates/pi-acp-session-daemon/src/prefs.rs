//! session-preferences.ts + session-settings.ts + applyPreferences port.
//!
//! preferences/<harness>.json: {version:1, preferences:[{kind,value}]} —
//! kinds ⊆ {model, thinking}; ≤2 entries, unique kinds, value 1..=10000 chars.
//! read(): ENOENT → []; malformed → '模型偏好格式不受支持或已损坏，原文件未修改：{file}'.
//! save(): never silently replace corrupt data — read() must succeed first;
//! empty preference set → no write; durable atomic write.
//!
//! Selector logic (session-settings.ts, harness is always 'pi' here):
//! - For each configs[] entry of type 'select': kind = 'model' when
//!   category=='model'||id=='model'; 'thinking' when category=='thought_level'
//!   || id/name matches thinkingName; 'mode' when category=='mode'; else 'other'.
//! - thinkingName regex: /^(?:thinking(?:[ _-]level)?|thought[ _-]level|reasoning(?:[ _-](?:effort|level))?)$/i
//! - thinkingPrefix regex: /^(?:thinking|reasoning(?: effort)?)\s*[:：]\s*/i
//! - levelName regex: /^(?:off|none|minimal|low|medium|high|xhigh|max|enabled|disabled|on)$/i
//! - compactThinking(name) = name minus thinkingPrefix, trimmed.
//! - Options flatten groups: 'options' in option ? option.options : [option].
//! - thinkingControl = first category=='thought_level' else first kind=='thinking';
//!   other thinking-kind controls are deduped out.
//! - modes→control when every availableMode matches thinkingPrefix/levelName
//!   (kind 'thinking', label 'Thinking') OR has same option ids as
//!   thinkingControl (covered → no control); otherwise kind 'mode' label '会话模式'.
//! - sessionPreferences(state) = model/thinking/mode selectors mapped to
//!   {kind, value:current}, model first.
//! - modelPreferences(state) = the same filtered to kind ∈ {model,thinking}.
//! - applyPreferences(agent, session, prefs): model-first order; per pref find
//!   selector by kind → applySelection: config → find config by change.id,
//!   must be 'select' & value in flattened options, skip if currentValue==value,
//!   else session/set_config_option {configId,value} → session.configOptions updated;
//!   mode → currentModeId!=value && modeId in availableModes → session/set_mode.
//!   Unapplied prefs → warning '上次的设置当前不可用（{kind}: {value}、…），请检查本次模型与思考选项。'.
use crate::agent::AgentProcess;
use crate::types::ChatState;
use regex::Regex;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::LazyLock;

static THINKING_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:thinking(?:[ _-]level)?|thought[ _-]level|reasoning(?:[ _-](?:effort|level))?)$").unwrap()
});
static THINKING_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?:thinking|reasoning(?: effort)?)\s*[:：]\s*").unwrap());
static LEVEL_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?:off|none|minimal|low|medium|high|xhigh|max|enabled|disabled|on)$").unwrap());

/// isHarnessId (src/harness.ts): the only valid file stems.
fn is_harness_id(value: &str) -> bool {
    matches!(value, "pi" | "codex" | "claude")
}

fn compact_thinking(name: &str) -> String {
    THINKING_PREFIX.replace(name, "").trim().to_string()
}

/// JS property read coerced for selector comparisons: strings pass through,
/// everything else reads as absent ('' keeps === and regex tests false).
fn vstr(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

/// 'options' in option ? option.options : [option] — flattened to one level.
fn flatten_options(config_options: Option<&Value>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for option in config_options.and_then(Value::as_array).cloned().unwrap_or_default() {
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

#[derive(Debug, Clone)]
pub struct SessionPreference {
    pub kind: String, // model | thinking | mode
    pub value: String,
}

#[derive(Clone)]
enum Change {
    Mode,
    Config(String),
}

/// SessionSelector from session-settings.ts (internal — only prefs flow out).
#[derive(Clone)]
struct Selector {
    #[allow(dead_code)] // label parity with TS; not read by preference code paths
    label: String,
    category: Option<String>,
    kind: &'static str, // model | thinking | mode | other
    current: String,
    options: Vec<(String, String)>, // (id, name)
    change: Change,
}

/// sessionSelectors() for harness 'pi' — codexFixedConfigs filtering is codex-only.
fn session_selectors(configs: Option<&[Value]>, modes: Option<&Value>) -> Vec<Selector> {
    let mut controls: Vec<Selector> = Vec::new();
    for config in configs.unwrap_or(&[]) {
        if config.get("type").and_then(Value::as_str) != Some("select") {
            continue;
        }
        let id = vstr(config.get("id"));
        let name = vstr(config.get("name"));
        let category = config.get("category").and_then(Value::as_str);
        let thinking = category == Some("thought_level") || THINKING_NAME.is_match(id) || THINKING_NAME.is_match(name);
        let kind: &'static str = if category == Some("model") || id == "model" {
            "model"
        } else if thinking {
            "thinking"
        } else if category == Some("mode") {
            "mode"
        } else {
            "other"
        };
        let options = flatten_options(config.get("options"));
        controls.push(Selector {
            label: name.to_string(),
            category: category.map(str::to_string),
            kind,
            current: vstr(config.get("currentValue")).to_string(),
            options: options
                .iter()
                .map(|o| {
                    let name = vstr(o.get("name"));
                    (
                        vstr(o.get("value")).to_string(),
                        if thinking { compact_thinking(name) } else { name.to_string() },
                    )
                })
                .collect(),
            change: Change::Config(id.to_string()),
        });
    }
    // Model switches can change supported levels while parallel modes remain stale.
    let thinking_index = controls
        .iter()
        .position(|c| c.category.as_deref() == Some("thought_level"))
        .or_else(|| controls.iter().position(|c| c.kind == "thinking"));
    let unique: Vec<&Selector> = controls
        .iter()
        .enumerate()
        .filter(|(i, c)| c.kind != "thinking" || Some(*i) == thinking_index)
        .map(|(_, c)| c)
        .collect();
    let available: &[Value] = modes
        .and_then(|m| m.get("availableModes"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let thinking_modes = !available.is_empty()
        && available.iter().all(|mode| {
            THINKING_PREFIX.is_match(vstr(mode.get("name")))
                || LEVEL_NAME.is_match(vstr(mode.get("id")))
                || LEVEL_NAME.is_match(vstr(mode.get("name")))
        });
    let thinking_control = thinking_index.map(|i| &controls[i]);
    let same_levels = modes.is_some()
        && thinking_control.is_some()
        && available.len() == thinking_control.map(|c| c.options.len()).unwrap_or(0)
        && available.iter().all(|mode| {
            let id = vstr(mode.get("id"));
            thinking_control.is_some_and(|c| c.options.iter().any(|(oid, _)| oid == id))
        });
    let modes_covered = unique.iter().any(|c| c.kind == "mode")
        || (thinking_control.is_some() && (thinking_modes || same_levels));
    let mut selectors: Vec<Selector> = Vec::new();
    if modes.is_some() && !modes_covered {
        selectors.push(Selector {
            label: if thinking_modes { "Thinking" } else { "会话模式" }.to_string(),
            category: None,
            kind: if thinking_modes { "thinking" } else { "mode" },
            current: vstr(modes.and_then(|m| m.get("currentModeId"))).to_string(),
            options: available
                .iter()
                .map(|mode| (vstr(mode.get("id")).to_string(), compact_thinking(vstr(mode.get("name")))))
                .collect(),
            change: Change::Mode,
        });
    }
    selectors.extend(unique.into_iter().cloned());
    selectors
}

/// sessionPreferences(state): model/thinking/mode selectors → {kind,current}, model first.
pub fn session_preferences(configs: Option<&[Value]>, modes: Option<&Value>) -> Vec<SessionPreference> {
    let mut preferences: Vec<SessionPreference> = session_selectors(configs, modes)
        .into_iter()
        .filter(|c| matches!(c.kind, "model" | "thinking" | "mode"))
        .map(|c| SessionPreference { kind: c.kind.to_string(), value: c.current })
        .collect();
    // JS stable sort: model entries first, rest keep source order.
    preferences.sort_by(|a, b| (b.kind == "model").cmp(&(a.kind == "model")));
    preferences
}

/// modelPreferences(state) — model/thinking pair only; modes are not inherited.
pub fn model_preferences(state: &ChatState) -> Vec<SessionPreference> {
    session_preferences(state.configs.as_deref(), state.modes.as_ref())
        .into_iter()
        .filter(|p| p.kind == "model" || p.kind == "thinking")
        .collect()
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

    /// harness is always 'pi' for the service.
    pub async fn read(&self, harness: &str) -> Result<Vec<SessionPreference>, String> {
        let file = self.file(harness)?;
        let text = match tokio::fs::read_to_string(&file).await {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.to_string()),
        };
        let malformed = || format!("模型偏好格式不受支持或已损坏，原文件未修改：{}", file.display());
        let data: Value = serde_json::from_str(&text).map_err(|_| malformed())?;
        let preferences = data.get("preferences").and_then(Value::as_array);
        let valid = data.get("version") == Some(&json!(1))
            && preferences.is_some_and(|list| {
                list.len() <= 2
                    && list.iter().all(|p| {
                        matches!(p.get("kind").and_then(Value::as_str), Some("model" | "thinking"))
                            && p.get("value")
                                .and_then(Value::as_str)
                                .is_some_and(|v| (1..=10000).contains(&v.encode_utf16().count()))
                    })
                    && {
                        let mut kinds = std::collections::HashSet::new();
                        list.iter().all(|p| kinds.insert(p.get("kind").and_then(Value::as_str).unwrap_or("")))
                    }
            });
        if !valid {
            return Err(malformed());
        }
        Ok(preferences
            .unwrap()
            .iter()
            .map(|p| SessionPreference {
                kind: p["kind"].as_str().unwrap_or("").to_string(),
                value: p["value"].as_str().unwrap_or("").to_string(),
            })
            .collect())
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
        tokio::fs::create_dir_all(&self.directory).await.map_err(|e| e.to_string())?;
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
    change: &Change,
    value: &str,
) -> Result<bool, String> {
    match change {
        Change::Config(id) => {
            let config = session
                .get("configOptions")
                .and_then(Value::as_array)
                .and_then(|list| list.iter().find(|c| vstr(c.get("id")) == id.as_str()).cloned());
            let Some(config) = config else { return Ok(false) };
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
        Change::Mode => {
            let modes = session.get("modes").cloned();
            if vstr(modes.as_ref().and_then(|m| m.get("currentModeId"))) == value {
                return Ok(true);
            }
            let available = modes
                .as_ref()
                .and_then(|m| m.get("availableModes"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if !available.iter().any(|m| vstr(m.get("id")) == value) {
                return Ok(false);
            }
            let session_id = session.get("sessionId").cloned().unwrap_or(Value::Null);
            agent
                .with_timeout(
                    agent.request("session/set_mode", json!({"sessionId": session_id, "modeId": value})),
                    30_000,
                )
                .await?;
            // session.modes = {...session.modes, currentModeId: value}
            let mut updated = modes
                .as_ref()
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            updated.insert("currentModeId".into(), json!(value));
            session["modes"] = Value::Object(updated);
            Ok(true)
        }
    }
}

/// Apply saved preferences to a fresh session; returns the warning text or None.
/// `session` is mutated in place (configOptions/modes fields) like the TS version.
pub async fn apply_preferences(
    agent: &AgentProcess,
    session: &mut Value,
    preferences: &[SessionPreference],
) -> Result<Option<String>, String> {
    let mut unavailable: Vec<String> = Vec::new();
    let mut ordered: Vec<SessionPreference> = preferences.to_vec();
    ordered.sort_by(|a, b| (b.kind == "model").cmp(&(a.kind == "model")));
    for preference in &ordered {
        let configs = session.get("configOptions").and_then(Value::as_array).cloned();
        let modes = session.get("modes").cloned();
        let control = session_selectors(configs.as_deref(), modes.as_ref())
            .into_iter()
            .find(|c| c.kind == preference.kind);
        let applied = match control {
            Some(control) => apply_selection(agent, session, &control.change, &preference.value).await?,
            None => false,
        };
        if !applied {
            unavailable.push(format!("{}: {}", preference.kind, preference.value));
        }
    }
    Ok(if unavailable.is_empty() {
        None
    } else {
        Some(format!("上次的设置当前不可用（{}），请检查本次模型与思考选项。", unavailable.join("、")))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regexes_match_ts() {
        for name in ["thinking", "Thinking_Level", "thought-level", "reasoning", "reasoning effort", "Reasoning_Level"] {
            assert!(THINKING_NAME.is_match(name), "{name}");
        }
        for name in ["thoughtlevel", "reasons", "thinking2", "mode"] {
            assert!(!THINKING_NAME.is_match(name), "{name}");
        }
        assert_eq!(compact_thinking("Thinking: High"), "High");
        assert_eq!(compact_thinking("reasoning effort：低"), "低");
        for level in ["off", "NONE", "minimal", "low", "medium", "high", "xhigh", "max", "on"] {
            assert!(LEVEL_NAME.is_match(level), "{level}");
        }
        assert!(!LEVEL_NAME.is_match("turbo"));
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
        let prefs = session_preferences(Some(&configs), None);
        assert_eq!(prefs.iter().map(|p| p.kind.as_str()).collect::<Vec<_>>(), ["model", "thinking"]);
        assert_eq!(prefs[0].value, "m1");
        assert_eq!(prefs[1].value, "low");
        // A non-thinking mode set surfaces a 'mode' selector labelled 会话模式.
        let modes = json!({"currentModeId":"a","availableModes":[{"id":"a","name":"Ask"},{"id":"b","name":"Plan"}]});
        let prefs = session_preferences(Some(&configs), Some(&modes));
        assert_eq!(prefs.iter().map(|p| p.kind.as_str()).collect::<Vec<_>>(), ["model", "mode", "thinking"]);
        // Thinking-flavoured modes are covered by the thinking control.
        let modes = json!({"currentModeId":"low","availableModes":[{"id":"low","name":"Low"},{"id":"high","name":"High"}]});
        let prefs = session_preferences(Some(&configs), Some(&modes));
        assert_eq!(prefs.iter().map(|p| p.kind.as_str()).collect::<Vec<_>>(), ["model", "thinking"]);
    }

    #[tokio::test]
    async fn preferences_file_roundtrip_and_corruption() {
        let dir = std::env::temp_dir().join(format!("pi-prefs-test-{}", uuid::Uuid::new_v4().simple()));
        let store = SessionPreferences::new(dir.clone());
        assert!(store.read("pi").await.unwrap().is_empty());
        assert!(store.read("bogus").await.is_err());
        let mut state = ChatState::default();
        state.configs = serde_json::from_str(
            r#"[{"id":"model","type":"select","category":"model","name":"Model","currentValue":"m2","options":[]}]"#,
        )
        .unwrap();
        store.save("pi", &state).await.unwrap();
        let read = store.read("pi").await.unwrap();
        assert_eq!(read.len(), 1);
        assert_eq!((read[0].kind.as_str(), read[0].value.as_str()), ("model", "m2"));
        // Corrupt file → read fails, save refuses to overwrite.
        std::fs::write(dir.join("pi.json"), "{broken").unwrap();
        let error = store.read("pi").await.unwrap_err();
        assert!(error.contains("模型偏好格式不受支持或已损坏，原文件未修改"), "{error}");
        assert!(store.save("pi", &state).await.is_err());
        // Wrong shape also fails validation without touching the file.
        std::fs::write(dir.join("pi.json"), r#"{"version":1,"preferences":[{"kind":"mode","value":"x"}]}"#).unwrap();
        assert!(store.read("pi").await.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
