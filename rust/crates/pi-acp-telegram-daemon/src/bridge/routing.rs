//! Pure input classification and ordering. No sockets, files, locks or tasks.
use super::state::{InboxItem, InboxPhase};
use super::thread_of;
use serde_json::Value;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum InputClass {
    Prompt,
    Command,
    Control,
}

impl InputClass {
    pub(super) fn classify(update: &Value) -> Self {
        if update.get("callback_query").is_some() {
            return Self::Control;
        }
        if update
            .pointer("/message/reply_to_message/text")
            .and_then(Value::as_str)
            == Some("请输入服务器上的绝对目录路径，回复这条消息即可。")
        {
            return Self::Command;
        }
        match update
            .pointer("/message/text")
            .and_then(Value::as_str)
            .and_then(parse_command)
            .map(|(name, _, _)| name.to_lowercase())
            .as_deref()
        {
            Some("stop" | "interrupt") => Self::Control,
            Some(
                "start" | "help" | "commands" | "menu" | "settings" | "new" | "open" | "sessions"
                | "sync" | "syncall" | "history" | "silent" | "notifications" | "status",
            ) => Self::Command,
            _ => Self::Prompt,
        }
    }
}

impl InboxItem {
    fn class(&self) -> InputClass {
        if self.prompt.is_some() {
            InputClass::Prompt
        } else {
            InputClass::classify(&self.update)
        }
    }
    pub(super) fn ordered(&self) -> bool {
        self.class() == InputClass::Prompt
    }
    pub(super) fn priority(&self) -> bool {
        self.class() == InputClass::Control || self.phase == InboxPhase::Interrupted
    }
    pub(super) fn ready(&self, items: &[Self]) -> bool {
        self.phase != InboxPhase::Started
            && !items.iter().any(|earlier| {
                earlier.id < self.id
                    && thread_of(&earlier.update) == thread_of(&self.update)
                    && ((self.ordered() && earlier.ordered())
                        || (self.priority() && earlier.class() == InputClass::Control))
            })
    }
}

/// `/cmd@bot args` — same shape as the TS regex `^\/(\w+)(?:@([\w]+))?(?:\s+([\s\S]*))?$`.
pub(super) fn parse_command(text: &str) -> Option<(String, Option<String>, Option<String>)> {
    let body = text.strip_prefix('/')?;
    let (head, argument) = match body.find(char::is_whitespace) {
        Some(i) => (&body[..i], Some(body[i..].trim_start().to_string())),
        None => (body, None),
    };
    let (command, bot) = match head.find('@') {
        Some(i) => (&head[..i], Some(head[i + 1..].to_string())),
        None => (head, None),
    };
    if command.is_empty()
        || !command
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return None;
    }
    if let Some(b) = &bot {
        if b.is_empty() || !b.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return None;
        }
    }
    Some((command.to_string(), bot, argument))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn item(id: i64, text: &str, thread: i64) -> InboxItem {
        InboxItem {
            id,
            update: json!({"message":{"text":text,"message_thread_id":thread}}),
            phase: InboxPhase::Pending,
            prompt: None,
        }
    }
    #[test]
    fn controls_and_status_bypass_prompts_but_each_ordered_lane_is_fifo() {
        let mut first = item(1, "long turn", 10);
        first.phase = InboxPhase::Started;
        let items = vec![
            first,
            item(2, "next prompt", 10),
            item(3, "/stop", 10),
            item(4, "/interrupt replacement", 10),
            item(5, "/status", 10),
            item(6, "other topic", 11),
        ];
        let ready: Vec<i64> = items
            .iter()
            .filter(|i| i.ready(&items))
            .map(|i| i.id)
            .collect();
        assert_eq!(ready, vec![3, 5, 6]);
        assert!(items[2].priority());
        assert!(!items[4].priority());
    }
    #[test]
    fn deferred_interrupt_is_a_prompt_even_when_its_text_is_a_relay_command() {
        let mut pending = item(1, "/interrupt /stop", 10);
        pending.prompt = Some("/stop".into());
        let items = vec![
            pending,
            item(2, "after replacement", 10),
            item(3, "/stop", 10),
        ];
        assert!(items[0].ordered());
        assert!(!items[0].priority());
        assert!(!items[1].ready(&items));
        assert!(items[2].ready(&items));
    }
    #[test]
    fn callback_and_named_commands_are_classified_without_changing_agent_slash_commands() {
        assert_eq!(
            InputClass::classify(&json!({"callback_query":{"data":"p:x:0"}})),
            InputClass::Control
        );
        assert_eq!(
            InputClass::classify(&item(1, "/STOP@my_bot", 10).update),
            InputClass::Control
        );
        assert_eq!(
            InputClass::classify(&item(1, "/compact", 10).update),
            InputClass::Prompt
        );
        assert_eq!(
            InputClass::classify(&item(1, "/history all", 10).update),
            InputClass::Command
        );
    }
}
