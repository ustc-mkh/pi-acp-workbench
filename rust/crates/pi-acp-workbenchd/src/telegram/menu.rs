//! Bounded, cold menu projections. Buttons carry existing typed controls, not a
//! second command engine; the inbox freezes their acceptance just like text.
use super::{
    admission::authorize_workspace,
    api::{BotApi, InlineButton, InlineKeyboard},
    command::{ControlCommand, MenuPage},
    render::{messages, DeliveryPart},
    runtime::Context,
    state::InboxRecord,
    types::{CallbackAction, CallbackBinding, CallbackKey, TopicKey},
};
use crate::{
    domain::{
        error::DomainError, query::MAX_SAFE_INTEGER, DeliveryId, Harness, NoticeId, SessionId,
        WorkspacePath,
    },
    persistence::inbox::TelegramStore,
};
use serde::{Deserialize, Serialize};
const PAGE_SIZE: usize = 10;
const MAX_BUTTONS: usize = 24;
const MAX_MENU_BYTES: usize = 64 * 1024;
const MENU_LIFETIME: u64 = 10 * 60;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Choice {
    label: String,
    command: ControlCommand,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Menu {
    text: String,
    expected_binding: Option<SessionId>,
    expires_at: u64,
    choices: Vec<Choice>,
}
impl Menu {
    fn harnesses(
        &mut self,
        app: &crate::app::WorkbenchApp,
        cwd: &WorkspacePath,
        create_topic: bool,
    ) {
        for harness in [Harness::Pi, Harness::Codex, Harness::Claude] {
            if app.harness_configured(&harness) {
                self.push(
                    format!("New {harness:?}"),
                    ControlCommand::NewSession {
                        harness,
                        cwd: cwd.clone(),
                        create_topic,
                    },
                );
            }
        }
    }
    fn push(&mut self, label: impl AsRef<str>, command: ControlCommand) {
        self.choices.push(Choice {
            label: label.as_ref().chars().take(64).collect(),
            command,
        });
    }
    fn validate(&self) -> Result<(), DomainError> {
        if self.choices.len() > MAX_BUTTONS
            || self.text.chars().count() > 12_000
            || self.expires_at > MAX_SAFE_INTEGER
        {
            return Err(DomainError::Protocol("menu exceeds budget".into()));
        }
        for choice in &self.choices {
            if choice.label.is_empty()
                || choice.label.chars().count() > 64
                || matches!(choice.command, ControlCommand::Remove { .. })
                || serde_json::to_vec(&choice.command)
                    .map_err(|e| DomainError::Protocol(e.to_string()))?
                    .len()
                    > 8192
            {
                return Err(DomainError::Protocol("invalid menu choice".into()));
            }
        }
        Ok(())
    }
    pub(super) fn decode(text: &str) -> Result<Self, DomainError> {
        if text.len() > MAX_MENU_BYTES {
            return Err(DomainError::Protocol("menu exceeds budget".into()));
        }
        let menu: Self = serde_json::from_str(text)
            .map_err(|_| DomainError::Protocol("invalid menu archive".into()))?;
        menu.validate()?;
        Ok(menu)
    }
    fn encode(&self) -> Result<String, DomainError> {
        self.validate()?;
        let encoded =
            serde_json::to_string(self).map_err(|e| DomainError::Protocol(e.to_string()))?;
        if encoded.len() > MAX_MENU_BYTES {
            return Err(DomainError::Protocol("menu exceeds budget".into()));
        }
        Ok(encoded)
    }
}
fn page(page: MenuPage, create_topic: bool) -> ControlCommand {
    ControlCommand::Menu { page, create_topic }
}
fn short(text: &str) -> String {
    text.chars().take(120).collect()
}
pub(super) async fn build(
    context: &Context<impl BotApi>,
    record: &InboxRecord,
    requested: &MenuPage,
    create_topic: bool,
) -> Result<String, DomainError> {
    let notice = NoticeId::new(format!("menu-reply-{}", record.id.get()))?;
    if let Some(saved) = context.app.delivery_payloads().find_notice(&notice).await? {
        Menu::decode(&saved.text)?;
        return Ok(saved.text);
    }
    let topic = &record.command.topic;
    let binding = context.store.binding(topic).await?;
    let snapshot = match &binding {
        Some(session) => context.inspect(session).await?,
        None => None,
    };
    if let Some(snapshot) = &snapshot {
        authorize_workspace(&snapshot.cwd, &context.config.workspace).await?;
    }
    let mut menu = Menu {
        text: String::new(),
        expected_binding: binding,
        expires_at: super::runtime::now()
            .saturating_add(MENU_LIFETIME)
            .min(MAX_SAFE_INTEGER),
        choices: vec![],
    };
    match requested {
        MenuPage::Home => {
            menu.text = format!(
                "Workbench menu\nWorkspace: {}\n",
                context.config.workspace.as_str()
            );
            if let Some(snapshot) = &snapshot {
                menu.text.push_str(&format!(
                    "Session {} · {:?} · {:?}\n",
                    snapshot.id, snapshot.harness, snapshot.status
                ));
            }
            let cwd =
                authorize_workspace(&context.config.workspace, &context.config.workspace).await?;
            menu.harnesses(&context.app, &cwd, create_topic);
            menu.push(
                "Browse directories",
                page(MenuPage::Directories { cwd, after: None }, create_topic),
            );
            menu.push(
                "Sync sessions",
                ControlCommand::Sync {
                    cursor: None,
                    recent: 5,
                    forum: create_topic || record.command.topic.thread.is_some(),
                },
            );
            menu.push(
                "Open sessions",
                page(MenuPage::Sessions { cursor: None }, create_topic),
            );
            if let Some(snapshot) = &snapshot {
                let session = snapshot.id.clone();
                if snapshot.catalogue.models.is_empty() {
                    menu.push(
                        "Discover provider choices",
                        ControlCommand::Discover {
                            session: session.clone(),
                        },
                    );
                }
                menu.push("Queued inputs", ControlCommand::Queue);
                menu.push("Models", page(MenuPage::Models { offset: 0 }, create_topic));
                menu.push("Modes", page(MenuPage::Modes { offset: 0 }, create_topic));
                menu.push(
                    "Status / authorization",
                    ControlCommand::Status {
                        session: session.clone(),
                    },
                );
                menu.push(
                    "Export recent history",
                    ControlCommand::History {
                        session: session.clone(),
                        all: false,
                    },
                );
                menu.push(
                    "Export next history batch",
                    ControlCommand::History {
                        session: session.clone(),
                        all: true,
                    },
                );
                menu.push("Stop current turn", ControlCommand::Cancel { session });
            }
            let preferences = context.store.preferences(topic).await?;
            menu.text.push_str(&format!(
                "Notifications: {} · Silent: {}\n",
                preferences.notifications, preferences.silent
            ));
            menu.push(
                if preferences.notifications {
                    "Notifications off"
                } else {
                    "Notifications on"
                },
                ControlCommand::Notifications {
                    enabled: Some(!preferences.notifications),
                },
            );
            menu.push(
                if preferences.silent {
                    "Silent off"
                } else {
                    "Silent on"
                },
                ControlCommand::Silent {
                    enabled: Some(!preferences.silent),
                },
            );
            menu.push("Command help", ControlCommand::Help);
            menu.text.push_str("Quick New uses the configured workspace; Browse directories selects another authorized directory. /new HARNESS /absolute/path remains available. Model menus show only committed provider offerings, without loading a worker.\n");
        }
        MenuPage::Directories { cwd, .. } | MenuPage::Harnesses { cwd } => {
            let selected = authorize_workspace(cwd, &context.config.workspace).await?;
            if record.callback.is_some() && &selected != cwd {
                return Err(DomainError::InvalidAnswer(
                    "workspace identity changed".into(),
                ));
            }
            if let MenuPage::Directories { after, .. } = requested {
                menu.text = format!("Choose directory\n{}\n", selected.as_str());
                let result =
                    super::directories::list(selected.clone(), after.clone(), PAGE_SIZE).await?;
                // Refuse an obvious pathname replacement during enumeration.
                if authorize_workspace(&selected, &context.config.workspace).await? != selected {
                    return Err(DomainError::InvalidAnswer(
                        "workspace identity changed".into(),
                    ));
                }
                for name in result.names {
                    let child = WorkspacePath::new(
                        std::path::Path::new(selected.as_str())
                            .join(&name)
                            .to_str()
                            .ok_or_else(|| DomainError::Protocol("non-UTF8 directory".into()))?,
                    )?;
                    if authorize_workspace(&child, &context.config.workspace)
                        .await
                        .as_ref()
                        .ok()
                        != Some(&child)
                    {
                        continue;
                    }
                    menu.text.push_str(&format!("{name}\n"));
                    menu.push(
                        format!("Directory: {name}"),
                        page(
                            MenuPage::Directories {
                                cwd: child,
                                after: None,
                            },
                            create_topic,
                        ),
                    );
                }
                if result.too_large {
                    menu.text.push_str("More than 1024 entries: listing omitted, not a complete page. Use /new HARNESS /absolute/path or a narrower configured workspace.\n");
                } else if let Some(after) = result.next {
                    menu.push(
                        "Next directories",
                        page(
                            MenuPage::Directories {
                                cwd: selected.clone(),
                                after: Some(after),
                            },
                            create_topic,
                        ),
                    );
                }
                menu.push(
                    "First directories",
                    page(
                        MenuPage::Directories {
                            cwd: selected.clone(),
                            after: None,
                        },
                        create_topic,
                    ),
                );
                menu.push(
                    "Use this directory",
                    page(
                        MenuPage::Harnesses {
                            cwd: selected.clone(),
                        },
                        create_topic,
                    ),
                );
                let root =
                    authorize_workspace(&context.config.workspace, &context.config.workspace)
                        .await?;
                if let Some(parent) = std::path::Path::new(selected.as_str())
                    .parent()
                    .filter(|parent| parent.starts_with(root.as_ref()))
                {
                    menu.push(
                        "Parent directory",
                        page(
                            MenuPage::Directories {
                                cwd: WorkspacePath::new(parent.to_str().ok_or_else(|| {
                                    DomainError::Protocol("non-UTF8 directory".into())
                                })?)?,
                                after: None,
                            },
                            create_topic,
                        ),
                    );
                }
                menu.text.push_str("Names only: hidden, symlink and non-UTF8 directories are omitted. Pages use name cursors, not a filesystem snapshot; refresh from First after directory changes.\n");
            } else {
                menu.text = format!("Choose harness\nDirectory: {}\n", selected.as_str());
                menu.harnesses(&context.app, &selected, create_topic);
                menu.push(
                    "Back to directory",
                    page(
                        MenuPage::Directories {
                            cwd: selected,
                            after: None,
                        },
                        create_topic,
                    ),
                );
            }
        }
        MenuPage::Sessions { cursor } => {
            menu.text = "Open session · one bounded page\n".into();
            let result = context.app.list(cursor.clone(), Some(PAGE_SIZE)).await?;
            for session in result.sessions {
                if authorize_workspace(&session.cwd, &context.config.workspace)
                    .await
                    .is_err()
                {
                    continue;
                }
                let label = format!(
                    "#{} {:?} · {}",
                    session.created_seq.get(),
                    session.harness,
                    short(session.cwd.as_str())
                );
                if context
                    .store
                    .topic(&session.id)
                    .await?
                    .is_some_and(|bound| bound != *topic)
                {
                    menu.text.push_str(&format!(
                        "{label} · already bound to another topic; use that topic\n"
                    ));
                    continue;
                }
                menu.text.push_str(&format!("{label}\n"));
                menu.push(
                    label,
                    ControlCommand::Attach {
                        session: session.id,
                    },
                );
            }
            if menu.choices.is_empty() {
                menu.text.push_str("No openable sessions on this page.\n");
            }
            if let Some(cursor) = result.next_cursor {
                menu.push(
                    "Next session page",
                    page(
                        MenuPage::Sessions {
                            cursor: Some(cursor),
                        },
                        create_topic,
                    ),
                );
            }
            menu.push(
                "Latest session page",
                page(MenuPage::Sessions { cursor: None }, create_topic),
            );
        }
        MenuPage::Models { offset } | MenuPage::Modes { offset } => {
            let snapshot = snapshot
                .as_ref()
                .ok_or_else(|| DomainError::InvalidAnswer("no bound session".into()))?;
            let models = matches!(requested, MenuPage::Models { .. });
            let count = if models {
                snapshot.catalogue.models.len()
            } else {
                snapshot.catalogue.modes.len()
            };
            let choices: Vec<_> = if models {
                snapshot
                    .catalogue
                    .models
                    .iter()
                    .skip(*offset as usize)
                    .take(PAGE_SIZE)
                    .map(|item| {
                        (
                            item.name.as_str(),
                            ControlCommand::SetModel {
                                session: snapshot.id.clone(),
                                model: item.id.clone(),
                            },
                        )
                    })
                    .collect()
            } else {
                snapshot
                    .catalogue
                    .modes
                    .iter()
                    .skip(*offset as usize)
                    .take(PAGE_SIZE)
                    .map(|item| {
                        (
                            item.name.as_str(),
                            ControlCommand::SetMode {
                                session: snapshot.id.clone(),
                                mode: item.id.clone(),
                            },
                        )
                    })
                    .collect()
            };
            menu.text = format!(
                "{} · committed provider offerings\n",
                if models { "Models" } else { "Modes" }
            );
            for (name, command) in choices {
                menu.push(name, command);
            }
            if menu.choices.is_empty() {
                menu.text.push_str("No offerings in this cold page. Discover provider choices starts one budgeted provider session without a business prompt; reopen this menu when ready. This menu query itself stays cold.\n");
                menu.push(
                    "Discover provider choices",
                    ControlCommand::Discover {
                        session: snapshot.id.clone(),
                    },
                );
            }
            let next = (*offset as usize).saturating_add(PAGE_SIZE);
            if next < count {
                menu.push(
                    "Next choices",
                    page(
                        if models {
                            MenuPage::Models {
                                offset: next as u32,
                            }
                        } else {
                            MenuPage::Modes {
                                offset: next as u32,
                            }
                        },
                        create_topic,
                    ),
                );
            }
            if *offset != 0 {
                menu.push(
                    "First choices",
                    page(
                        if models {
                            MenuPage::Models { offset: 0 }
                        } else {
                            MenuPage::Modes { offset: 0 }
                        },
                        create_topic,
                    ),
                );
            }
        }
    }
    if !matches!(requested, MenuPage::Home) {
        menu.push("Main menu", page(MenuPage::Home, create_topic));
    }
    menu.text.push_str("Buttons expire after 10 minutes and stop working after topic rebinding. Use /menu for a fresh menu; commands remain available.");
    menu.encode()
}

pub(super) async fn sync_result(
    context: &Context<impl BotApi>,
    record: &InboxRecord,
    text: String,
    next: Option<crate::domain::query::ListCursor>,
    recent: u8,
    forum: bool,
) -> Result<String, DomainError> {
    let mut menu = Menu {
        text,
        expected_binding: context.store.binding(&record.command.topic).await?,
        expires_at: super::runtime::now().saturating_add(MENU_LIFETIME),
        choices: vec![],
    };
    if let Some(cursor) = next {
        menu.push(
            "Sync next session page",
            ControlCommand::Sync {
                cursor: Some(cursor),
                recent,
                forum,
            },
        );
    }
    menu.push(
        "Main menu",
        ControlCommand::Menu {
            page: MenuPage::Home,
            create_topic: forum && record.command.topic.thread.is_none(),
        },
    );
    menu.encode()
}
pub(super) async fn render(
    delivery: &DeliveryId,
    topic: &TopicKey,
    menu: Menu,
    store: &TelegramStore,
    now: u64,
) -> Result<Vec<DeliveryPart>, DomainError> {
    let mut parts = messages(topic, &menu.text);
    if now >= menu.expires_at || store.binding(topic).await? != menu.expected_binding {
        parts.extend(messages(
            topic,
            "Menu expired or topic binding changed. Use /menu.",
        ));
    } else {
        let mut rows = vec![];
        for (index, choice) in menu.choices.into_iter().enumerate() {
            let key = CallbackKey::for_option(delivery, index);
            let result = store
                .register_menu_callback(
                    key.clone(),
                    CallbackBinding {
                        topic: topic.clone(),
                        action: CallbackAction::Control {
                            command: choice.command,
                            expected_binding: menu.expected_binding.clone(),
                        },
                        expires_at: menu.expires_at,
                        used_by: None,
                    },
                    now,
                )
                .await;
            match result {
                Ok(()) => rows.push(vec![InlineButton {
                    text: choice.label,
                    callback_data: key,
                }]),
                Err(DomainError::Backpressure) => {
                    parts.extend(messages(topic, "Menu button capacity reached; use /help commands or retry /menu after old menus expire. Authorization button capacity is reserved."));
                    return Ok(parts.into_iter().map(DeliveryPart::Message).collect());
                }
                Err(error) => return Err(error),
            }
        }
        if let Some(last) = parts.last_mut() {
            last.reply_markup = Some(InlineKeyboard {
                inline_keyboard: rows,
            });
        }
    }
    Ok(parts.into_iter().map(DeliveryPart::Message).collect())
}
