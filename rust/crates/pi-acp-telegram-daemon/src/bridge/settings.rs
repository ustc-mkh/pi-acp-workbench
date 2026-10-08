//! ACP select controls, using the same model/thought-level classification as the desktop.
use serde_json::Value;

#[derive(Clone, Debug)]
pub(super) struct Choice {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug)]
pub(super) struct Selector {
    pub id: String,
    pub label: String,
    pub kind: &'static str,
    pub current: String,
    pub choices: Vec<Choice>,
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn thinking(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase().replace([' ', '_', '-'], "");
    matches!(
        normalized.as_str(),
        "thinking"
            | "thinkinglevel"
            | "thoughtlevel"
            | "reasoning"
            | "reasoningeffort"
            | "reasoninglevel"
    )
}

pub(super) fn selectors(state: &Value) -> Vec<Selector> {
    let mut result = Vec::new();
    let mut preferred_thinking = false;
    let configs = state.pointer("/snapshot/configs").and_then(Value::as_array);
    for config in configs.into_iter().flatten() {
        if text(config, "type") != "select" {
            continue;
        }
        let category = text(config, "category");
        let kind = if category == "model" || text(config, "id") == "model" {
            "model"
        } else if category == "thought_level"
            || thinking(text(config, "id"))
            || thinking(text(config, "name"))
        {
            "thinking"
        } else {
            continue;
        };
        let mut choices = Vec::new();
        for option in config
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(group) = option.get("options").and_then(Value::as_array) {
                for child in group {
                    choices.push(Choice {
                        id: text(child, "value").into(),
                        label: format!("{} · {}", text(option, "name"), text(child, "name")),
                    });
                }
            } else {
                choices.push(Choice {
                    id: text(option, "value").into(),
                    label: text(option, "name").into(),
                });
            }
        }
        choices.retain(|choice| !choice.id.is_empty());
        if kind == "thinking" {
            if preferred_thinking
                || (category != "thought_level" && result.iter().any(|s: &Selector| s.kind == kind))
            {
                continue;
            }
            result.retain(|s| s.kind != "thinking");
            preferred_thinking = category == "thought_level";
        }
        result.push(Selector {
            id: text(config, "id").into(),
            label: if kind == "model" {
                "模型"
            } else {
                "思考强度"
            }
            .into(),
            kind,
            current: text(config, "currentValue").into(),
            choices,
        });
    }
    result
}

impl Selector {
    pub fn current_label(&self) -> &str {
        self.choices
            .iter()
            .find(|c| c.id == self.current)
            .map(|c| c.label.as_str())
            .unwrap_or(&self.current)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn controls_preserve_provider_groups_and_prefer_canonical_thought_level() {
        let state = json!({"snapshot":{"configs":[
            {"id":"reasoning","type":"select","name":"Reasoning","currentValue":"high","options":[{"value":"high","name":"High"}]},
            {"id":"model","type":"select","currentValue":"m1","options":[{"name":"Provider","options":[{"value":"m1","name":"Model One"}]}]},
            {"id":"effort","category":"thought_level","type":"select","currentValue":"low","options":[{"value":"low","name":"Low"}]},
            {"id":"collaboration_mode","type":"select","options":[]}
        ]}});
        let controls = selectors(&state);
        assert_eq!(controls.len(), 2);
        assert_eq!(controls[0].current_label(), "Provider · Model One");
        assert_eq!(controls[1].id, "effort");
    }
}
