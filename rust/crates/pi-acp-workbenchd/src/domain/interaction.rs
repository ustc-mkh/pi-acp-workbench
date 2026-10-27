use super::{error::DomainError, ids::InteractionId};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
pub enum InteractionKind {
    Permission,
    Elicitation,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Interaction {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<QuestionPresentation>,
    pub id: InteractionId,
    pub kind: InteractionKind,
    pub title: String,
    pub detail: String,
    pub fields: Vec<InteractionField>,
    #[serde(default)]
    pub options: Vec<InteractionOption>,
    pub expires_at: Option<u64>,
}
/// Display hints for Pi RPC questions. Answers still use the validated
/// permission/form contract and the original interaction identity.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuestionPresentation {
    pub method: QuestionMethod,
    pub title: String,
    pub message: String,
    pub placeholder: String,
    pub prefill: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum QuestionMethod {
    Select,
    Confirm,
    Input,
    Editor,
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
pub struct InteractionOption {
    pub id: String,
    pub label: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InteractionField {
    pub name: String,
    pub label: String,
    pub required: bool,
    pub kind: FieldKind,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum FieldKind {
    Text {
        max_length: usize,
    },
    Choice {
        options: Vec<InteractionOption>,
        multiple: bool,
    },
    Boolean,
    Integer {
        min: Option<i64>,
        max: Option<i64>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
pub enum FieldValue {
    Text(String),
    Selected(Vec<String>),
    Boolean(bool),
    Integer(i64),
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
pub enum InteractionResponse {
    /// Admission has already bound this literal text to a specific interaction.
    /// The domain normalizes it against that interaction, never against a newer one.
    Text(String),
    Permission {
        option: String,
    },
    Form {
        fields: BTreeMap<String, FieldValue>,
    },
    Decline,
    Cancel,
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
pub struct InteractionAnswer {
    pub interaction: InteractionId,
    pub response: InteractionResponse,
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
pub enum InteractionResolution {
    Answered(InteractionAnswer),
    Cancelled { interaction: InteractionId },
}

impl Interaction {
    pub fn validate_definition(&self) -> Result<(), DomainError> {
        let invalid = || DomainError::InvalidAnswer("invalid interaction definition".into());
        if let Some(question) = &self.question {
            if question.title.len() > 10000
                || question.message.len() > 40000
                || question.placeholder.len() > 10000
                || question.prefill.chars().count() > 10000
            {
                return Err(invalid());
            }
            match question.method {
                QuestionMethod::Select | QuestionMethod::Confirm
                    if self.kind == InteractionKind::Permission => {}
                QuestionMethod::Input | QuestionMethod::Editor
                    if self.kind == InteractionKind::Elicitation
                        && self.fields.len() == 1
                        && self.fields[0].name == "value"
                        && matches!(self.fields[0].kind, FieldKind::Text { .. }) => {}
                _ => return Err(invalid()),
            }
        }
        let valid_options = |options: &[InteractionOption]| {
            !options.is_empty()
                && options.len() <= 64
                && options
                    .iter()
                    .all(|option| !option.id.is_empty() && option.id.len() <= 200)
                && options
                    .iter()
                    .map(|option| &option.id)
                    .collect::<BTreeSet<_>>()
                    .len()
                    == options.len()
        };
        match self.kind {
            InteractionKind::Permission
                if self.fields.is_empty() && valid_options(&self.options) =>
            {
                Ok(())
            }
            InteractionKind::Elicitation
                if self.options.is_empty()
                    && !self.fields.is_empty()
                    && self.fields.len() <= 32 =>
            {
                let mut names = BTreeSet::new();
                for field in &self.fields {
                    if field.name.is_empty() || field.name.len() > 200 || !names.insert(&field.name)
                    {
                        return Err(invalid());
                    }
                    match &field.kind {
                        FieldKind::Text { max_length }
                            if *max_length > 0 && *max_length <= 100_000 => {}
                        FieldKind::Choice { options, .. } if valid_options(options) => {}
                        FieldKind::Boolean => {}
                        FieldKind::Integer { min, max } if !matches!((min, max), (Some(min), Some(max)) if min > max) =>
                            {}
                        _ => return Err(invalid()),
                    }
                }
                Ok(())
            }
            _ => Err(invalid()),
        }
    }
    pub fn validate_answer(
        &self,
        answer: InteractionAnswer,
        now: u64,
    ) -> Result<InteractionAnswer, DomainError> {
        if answer.interaction != self.id {
            return Err(DomainError::InteractionNotFound);
        }
        if self.expires_at.is_some_and(|expiry| now >= expiry) {
            return Err(DomainError::InteractionExpired);
        }
        let invalid = || DomainError::InvalidAnswer("answer does not match the interaction".into());
        let response = match answer.response {
            InteractionResponse::Text(text) => match self.kind {
                InteractionKind::Permission => InteractionResponse::Permission {
                    option: text.trim().into(),
                },
                InteractionKind::Elicitation if self.fields.len() == 1 => {
                    let field = &self.fields[0];
                    let value = match &field.kind {
                        FieldKind::Text { .. } => FieldValue::Text(text),
                        FieldKind::Choice { .. } => FieldValue::Selected(vec![text]),
                        FieldKind::Boolean => {
                            FieldValue::Boolean(text.parse().map_err(|_| invalid())?)
                        }
                        FieldKind::Integer { .. } => {
                            FieldValue::Integer(text.parse().map_err(|_| invalid())?)
                        }
                    };
                    InteractionResponse::Form {
                        fields: BTreeMap::from([(field.name.clone(), value)]),
                    }
                }
                _ => return Err(invalid()),
            },
            response => response,
        };
        match &response {
            InteractionResponse::Permission { option }
                if self.kind == InteractionKind::Permission =>
            {
                if !self.options.iter().any(|candidate| candidate.id == *option) {
                    return Err(invalid());
                }
            }
            InteractionResponse::Form { fields } if self.kind == InteractionKind::Elicitation => {
                if fields
                    .keys()
                    .any(|name| !self.fields.iter().any(|field| field.name == *name))
                {
                    return Err(invalid());
                }
                for field in &self.fields {
                    match fields.get(&field.name) {
                        None if field.required => return Err(invalid()),
                        None => {}
                        Some(value) if field.accepts(value) => {}
                        Some(_) => return Err(invalid()),
                    }
                }
            }
            InteractionResponse::Decline | InteractionResponse::Cancel => {}
            _ => return Err(invalid()),
        }
        Ok(InteractionAnswer {
            interaction: self.id.clone(),
            response,
        })
    }
}
impl InteractionField {
    fn accepts(&self, value: &FieldValue) -> bool {
        match (&self.kind, value) {
            (FieldKind::Text { max_length }, FieldValue::Text(text)) => {
                (!self.required || !text.trim().is_empty()) && text.chars().count() <= *max_length
            }
            (FieldKind::Choice { options, multiple }, FieldValue::Selected(selected)) => {
                (!self.required || !selected.is_empty())
                    && (*multiple || selected.len() <= 1)
                    && selected.iter().collect::<BTreeSet<_>>().len() == selected.len()
                    && selected
                        .iter()
                        .all(|id| options.iter().any(|option| option.id == *id))
            }
            (FieldKind::Boolean, FieldValue::Boolean(_)) => true,
            (FieldKind::Integer { min, max }, FieldValue::Integer(value)) => {
                min.is_none_or(|min| *value >= min) && max.is_none_or(|max| *value <= max)
            }
            _ => false,
        }
    }
}
