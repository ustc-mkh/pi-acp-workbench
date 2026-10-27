use super::{error::DomainError, ids::InteractionId, interaction::*};
use std::collections::BTreeMap;

fn form() -> Interaction {
    Interaction {
        question: None,
        id: InteractionId::generate(),
        kind: InteractionKind::Elicitation,
        title: "Questions".into(),
        detail: String::new(),
        options: vec![],
        expires_at: Some(100),
        fields: vec![
            InteractionField {
                name: "text".into(),
                label: "Text".into(),
                required: true,
                kind: FieldKind::Text { max_length: 20 },
            },
            InteractionField {
                name: "choice".into(),
                label: "Choice".into(),
                required: true,
                kind: FieldKind::Choice {
                    multiple: true,
                    options: vec![
                        InteractionOption {
                            id: "a:b".into(),
                            label: "Colon".into(),
                        },
                        InteractionOption {
                            id: "其它".into(),
                            label: "Unicode".into(),
                        },
                    ],
                },
            },
            InteractionField {
                name: "flag".into(),
                label: "Flag".into(),
                required: false,
                kind: FieldKind::Boolean,
            },
            InteractionField {
                name: "count".into(),
                label: "Count".into(),
                required: false,
                kind: FieldKind::Integer {
                    min: Some(1),
                    max: Some(10),
                },
            },
        ],
    }
}
fn fields() -> BTreeMap<String, FieldValue> {
    BTreeMap::from([
        ("text".into(), FieldValue::Text("你好".into())),
        (
            "choice".into(),
            FieldValue::Selected(vec!["a:b".into(), "其它".into()]),
        ),
        ("flag".into(), FieldValue::Boolean(true)),
        ("count".into(), FieldValue::Integer(3)),
    ])
}

#[test]
fn form_answers_validate_required_types_choices_and_ranges() {
    let interaction = form();
    interaction.validate_definition().unwrap();
    let answer = |fields| InteractionAnswer {
        interaction: interaction.id.clone(),
        response: InteractionResponse::Form { fields },
    };
    interaction.validate_answer(answer(fields()), 99).unwrap();
    for invalid in 0..6 {
        let mut fields = fields();
        match invalid {
            0 => {
                fields.remove("text");
            }
            1 => {
                fields.insert("extra".into(), FieldValue::Boolean(false));
            }
            2 => {
                fields.insert(
                    "choice".into(),
                    FieldValue::Selected(vec!["unknown".into()]),
                );
            }
            3 => {
                fields.insert(
                    "choice".into(),
                    FieldValue::Selected(vec!["a:b".into(), "a:b".into()]),
                );
            }
            4 => {
                fields.insert("count".into(), FieldValue::Integer(11));
            }
            _ => {
                fields.insert("flag".into(), FieldValue::Text("true".into()));
            }
        }
        assert!(
            interaction.validate_answer(answer(fields), 99).is_err(),
            "case {invalid}"
        );
    }
    assert!(matches!(
        interaction.validate_answer(answer(fields()), 100),
        Err(DomainError::InteractionExpired)
    ));
    for response in [InteractionResponse::Decline, InteractionResponse::Cancel] {
        interaction
            .validate_answer(
                InteractionAnswer {
                    interaction: interaction.id.clone(),
                    response,
                },
                99,
            )
            .unwrap();
    }
}

#[test]
fn unsupported_or_ambiguous_form_definitions_are_rejected() {
    let mut interaction = form();
    interaction.fields.push(interaction.fields[0].clone());
    assert!(interaction.validate_definition().is_err());
    let mut interaction = form();
    interaction.fields[0].kind = FieldKind::Integer {
        min: Some(20),
        max: Some(1),
    };
    assert!(interaction.validate_definition().is_err());
}

#[test]
fn plain_text_normalizes_only_against_the_bound_single_field() {
    let mut interaction = form();
    interaction.fields.truncate(1);
    let answer = interaction
        .validate_answer(
            InteractionAnswer {
                interaction: interaction.id.clone(),
                response: InteractionResponse::Text("你好".into()),
            },
            1,
        )
        .unwrap();
    assert!(
        matches!(answer.response, InteractionResponse::Form { fields }
        if fields.get("text") == Some(&FieldValue::Text("你好".into())))
    );
    assert!(interaction
        .validate_answer(
            InteractionAnswer {
                interaction: InteractionId::generate(),
                response: InteractionResponse::Text("wrong target".into()),
            },
            1
        )
        .is_err());
}
