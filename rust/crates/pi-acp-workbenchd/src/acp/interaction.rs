//! Typed inbound interaction requests and their domain mapping.
use super::{codec::RequestId, dto::NativeSessionId};
use crate::domain::{error::DomainError, ids::InteractionId, interaction::*};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug)]
pub enum InboundRequest {
    Permission {
        id: RequestId,
        request: PermissionRequest,
    },
    Form {
        id: RequestId,
        request: FormRequest,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub session_id: NativeSessionId,
    pub tool_call: PermissionToolCall,
    pub options: Vec<PermissionOption>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionToolCall {
    pub tool_call_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub status: Option<super::dto::ToolStatus>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub option_id: String,
    pub name: String,
    pub kind: PermissionKind,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormRequest {
    pub session_id: NativeSessionId,
    pub mode: FormMode,
    pub message: String,
    pub requested_schema: FormSchema,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum FormMode {
    #[serde(rename = "form")]
    Form,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FormSchema {
    #[serde(rename = "type")]
    pub kind: ObjectType,
    pub properties: BTreeMap<String, SchemaField>,
    #[serde(default)]
    pub required: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum ObjectType {
    #[serde(rename = "object")]
    Object,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum SchemaField {
    String {
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        description: Option<String>,
        #[serde(rename = "maxLength", default)]
        max_length: Option<usize>,
        #[serde(rename = "enum", default)]
        values: Option<Vec<String>>,
        #[serde(rename = "oneOf", default)]
        one_of: Option<Vec<SchemaChoice>>,
    },
    Array {
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        description: Option<String>,
        items: ArrayItems,
    },
    Boolean {
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        description: Option<String>,
    },
    Integer {
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        minimum: Option<i64>,
        #[serde(default)]
        maximum: Option<i64>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SchemaChoice {
    #[serde(rename = "const")]
    pub value: String,
    #[serde(default)]
    pub title: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ArrayItems {
    pub any_of: Vec<SchemaChoice>,
}

impl InboundRequest {
    pub fn id(&self) -> &RequestId {
        match self {
            Self::Permission { id, .. } | Self::Form { id, .. } => id,
        }
    }
    pub fn session(&self) -> &NativeSessionId {
        match self {
            Self::Permission { request, .. } => &request.session_id,
            Self::Form { request, .. } => &request.session_id,
        }
    }
    pub fn to_domain(&self, id: InteractionId) -> Result<Interaction, DomainError> {
        let interaction = match self {
            Self::Permission { request, .. } => Interaction {
                id,
                kind: InteractionKind::Permission,
                title: request.tool_call.title.clone(),
                detail: request.tool_call.tool_call_id.clone(),
                fields: vec![],
                expires_at: None,
                options: request
                    .options
                    .iter()
                    .map(|option| InteractionOption {
                        id: option.option_id.clone(),
                        label: option.name.clone(),
                    })
                    .collect(),
            },
            Self::Form { request, .. } => {
                if request
                    .requested_schema
                    .required
                    .iter()
                    .any(|name| !request.requested_schema.properties.contains_key(name))
                {
                    return Err(DomainError::Protocol(
                        "required form property missing".into(),
                    ));
                }
                let mut fields = vec![];
                for (name, schema) in &request.requested_schema.properties {
                    let (title, kind) = match schema {
                        SchemaField::String {
                            title,
                            max_length,
                            values,
                            one_of,
                            ..
                        } => {
                            if values.is_some() && one_of.is_some() {
                                return Err(DomainError::Protocol("ambiguous form choices".into()));
                            }
                            let kind = if let Some(options) = one_of {
                                FieldKind::Choice {
                                    multiple: false,
                                    options: choices(options),
                                }
                            } else if let Some(options) = values {
                                FieldKind::Choice {
                                    multiple: false,
                                    options: options
                                        .iter()
                                        .map(|id| InteractionOption {
                                            id: id.clone(),
                                            label: id.clone(),
                                        })
                                        .collect(),
                                }
                            } else {
                                FieldKind::Text {
                                    max_length: max_length.unwrap_or(100_000),
                                }
                            };
                            (title, kind)
                        }
                        SchemaField::Array { title, items, .. } => (
                            title,
                            FieldKind::Choice {
                                multiple: true,
                                options: choices(&items.any_of),
                            },
                        ),
                        SchemaField::Boolean { title, .. } => (title, FieldKind::Boolean),
                        SchemaField::Integer {
                            title,
                            minimum,
                            maximum,
                            ..
                        } => (
                            title,
                            FieldKind::Integer {
                                min: *minimum,
                                max: *maximum,
                            },
                        ),
                    };
                    fields.push(InteractionField {
                        name: name.clone(),
                        label: title.clone().unwrap_or_else(|| name.clone()),
                        required: request.requested_schema.required.contains(name),
                        kind,
                    });
                }
                Interaction {
                    id,
                    kind: InteractionKind::Elicitation,
                    title: request.message.clone(),
                    detail: String::new(),
                    fields,
                    options: vec![],
                    expires_at: None,
                }
            }
        };
        interaction.validate_definition()?;
        Ok(interaction)
    }
}
fn choices(options: &[SchemaChoice]) -> Vec<InteractionOption> {
    options
        .iter()
        .map(|option| InteractionOption {
            id: option.value.clone(),
            label: option.title.clone().unwrap_or_else(|| option.value.clone()),
        })
        .collect()
}
#[derive(Clone, Debug, Serialize)]
pub struct PermissionResponse {
    pub outcome: PermissionOutcome,
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "lowercase")]
pub enum PermissionOutcome {
    Selected {
        #[serde(rename = "optionId")]
        option_id: String,
    },
    Cancelled,
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "action", rename_all = "lowercase")]
pub enum FormResponse {
    Accept {
        content: BTreeMap<String, FormValue>,
    },
    Decline,
    Cancel,
}
#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum FormValue {
    Text(String),
    Selected(Vec<String>),
    Boolean(bool),
    Integer(i64),
}
