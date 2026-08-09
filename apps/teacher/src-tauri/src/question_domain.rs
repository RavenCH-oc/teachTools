#![allow(dead_code)]

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

use crate::error::AppError;

pub const QUESTION_CONFIG_VERSION: i64 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuestionType {
    TrueFalse,
    SingleChoice,
    MultipleChoice,
    FillBlank,
    Essay,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceOption {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FillBlankDefinition {
    pub id: String,
    pub accepted_answers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FillBlankNormalization {
    pub trim: bool,
    pub unicode_normalization: String,
    pub case_sensitive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrueFalseConfig {
    pub correct_answer: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SingleChoiceConfig {
    pub options: Vec<ChoiceOption>,
    pub correct_option_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MultipleChoiceConfig {
    pub options: Vec<ChoiceOption>,
    pub correct_option_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FillBlankConfig {
    pub blanks: Vec<FillBlankDefinition>,
    pub normalization: FillBlankNormalization,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EssayConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rubric_reference: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum QuestionConfiguration {
    TrueFalse(TrueFalseConfig),
    SingleChoice(SingleChoiceConfig),
    MultipleChoice(MultipleChoiceConfig),
    FillBlank(FillBlankConfig),
    Essay(EssayConfig),
}

impl QuestionConfiguration {
    pub fn validate_for(&self, question_type: &QuestionType) -> Result<(), AppError> {
        match (question_type, self) {
            (QuestionType::TrueFalse, Self::TrueFalse(_))
            | (QuestionType::Essay, Self::Essay(_)) => Ok(()),
            (QuestionType::SingleChoice, Self::SingleChoice(config)) => validate_choices(
                &config.options,
                std::slice::from_ref(&config.correct_option_id),
            ),
            (QuestionType::MultipleChoice, Self::MultipleChoice(config)) => {
                validate_choices(&config.options, &config.correct_option_ids)
            }
            (QuestionType::FillBlank, Self::FillBlank(config)) => validate_fill_blanks(config),
            _ => Err(AppError::Validation(
                "question type and answer configuration do not match".to_owned(),
            )),
        }
    }
}

fn validate_choices(options: &[ChoiceOption], correct_ids: &[String]) -> Result<(), AppError> {
    if options.len() < 2 {
        return Err(AppError::Validation(
            "a choice question needs at least two options".to_owned(),
        ));
    }
    let mut ids = HashSet::new();
    for option in options {
        if option.id.trim().is_empty() || option.text.trim().is_empty() {
            return Err(AppError::Validation(
                "choice IDs and text must not be empty".to_owned(),
            ));
        }
        if !ids.insert(&option.id) {
            return Err(AppError::Validation("choice IDs must be unique".to_owned()));
        }
    }
    let mut correct = HashSet::new();
    for id in correct_ids {
        if !ids.contains(id) || !correct.insert(id) {
            return Err(AppError::Validation(
                "correct choice IDs must exist and be unique".to_owned(),
            ));
        }
    }
    if correct_ids.is_empty() {
        return Err(AppError::Validation(
            "at least one correct choice is required".to_owned(),
        ));
    }
    Ok(())
}

fn validate_fill_blanks(config: &FillBlankConfig) -> Result<(), AppError> {
    if config.blanks.is_empty() || config.normalization.unicode_normalization != "NFKC" {
        return Err(AppError::Validation(
            "fill-blank configuration is invalid".to_owned(),
        ));
    }
    let mut ids = HashSet::new();
    for blank in &config.blanks {
        if blank.id.trim().is_empty() || !ids.insert(&blank.id) || blank.accepted_answers.is_empty()
        {
            return Err(AppError::Validation(
                "blank IDs and accepted answers are invalid".to_owned(),
            ));
        }
        let mut normalized = HashSet::new();
        for answer in &blank.accepted_answers {
            let canonical: String = answer.nfkc().collect();
            if canonical.trim().is_empty() || !normalized.insert(canonical.trim().to_lowercase()) {
                return Err(AppError::Validation(
                    "accepted answers must be non-empty and unique".to_owned(),
                ));
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StudentAnswer {
    TrueFalse {
        value: bool,
    },
    SingleChoice {
        #[serde(rename = "optionId")]
        option_id: String,
    },
    MultipleChoice {
        #[serde(rename = "optionIds")]
        option_ids: Vec<String>,
    },
    FillBlank {
        values: std::collections::BTreeMap<String, String>,
    },
    Essay {
        text: String,
    },
}
