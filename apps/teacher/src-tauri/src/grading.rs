#![allow(dead_code)]

use std::collections::HashSet;

use unicode_normalization::UnicodeNormalization;

use crate::question_domain::{
    ChoiceOption, FillBlankConfig, QuestionConfiguration, QuestionType, StudentAnswer,
};

#[derive(Debug, Clone, PartialEq)]
pub struct GradePart {
    pub id: String,
    pub correct: bool,
}
#[derive(Debug, Clone, PartialEq)]
pub enum GradeResult {
    Graded {
        correct: bool,
        score: i64,
        max_score: i64,
        parts: Vec<GradePart>,
    },
    Pending {
        max_score: i64,
    },
}
#[derive(Debug, Clone, PartialEq)]
pub enum GradingError {
    InvalidAnswer(String),
    InvalidQuestionConfiguration(String),
    UnsupportedQuestionVersion,
}

pub fn grade_question(
    question_type: &QuestionType,
    config: &QuestionConfiguration,
    points: i64,
    answer: &StudentAnswer,
) -> Result<GradeResult, GradingError> {
    if points <= 0 {
        return Err(GradingError::InvalidQuestionConfiguration(
            "points must be positive".to_owned(),
        ));
    }
    if !answer_matches_type(question_type, answer) {
        return Err(GradingError::InvalidAnswer(
            "answer type does not match question type".to_owned(),
        ));
    }
    match (question_type, config, answer) {
        (
            QuestionType::TrueFalse,
            QuestionConfiguration::TrueFalse(config),
            StudentAnswer::TrueFalse { value },
        ) => {
            let correct = *value == config.correct_answer;
            Ok(graded(correct, points, Vec::new()))
        }
        (
            QuestionType::SingleChoice,
            QuestionConfiguration::SingleChoice(config),
            StudentAnswer::SingleChoice { option_id },
        ) => {
            ensure_option(&config.options, option_id)?;
            Ok(graded(
                *option_id == config.correct_option_id,
                points,
                Vec::new(),
            ))
        }
        (
            QuestionType::MultipleChoice,
            QuestionConfiguration::MultipleChoice(config),
            StudentAnswer::MultipleChoice { option_ids },
        ) => {
            ensure_unique_options(&config.options, option_ids)?;
            let expected: HashSet<&String> = config.correct_option_ids.iter().collect();
            let actual: HashSet<&String> = option_ids.iter().collect();
            Ok(graded(expected == actual, points, Vec::new()))
        }
        (
            QuestionType::FillBlank,
            QuestionConfiguration::FillBlank(config),
            StudentAnswer::FillBlank { values },
        ) => grade_fill_blank(config, values, points),
        (QuestionType::Essay, QuestionConfiguration::Essay(_), StudentAnswer::Essay { .. }) => {
            Ok(GradeResult::Pending { max_score: points })
        }
        _ => Err(GradingError::InvalidQuestionConfiguration(
            "question type and configuration do not match".to_owned(),
        )),
    }
}

fn answer_matches_type(question_type: &QuestionType, answer: &StudentAnswer) -> bool {
    matches!(
        (question_type, answer),
        (QuestionType::TrueFalse, StudentAnswer::TrueFalse { .. })
            | (
                QuestionType::SingleChoice,
                StudentAnswer::SingleChoice { .. }
            )
            | (
                QuestionType::MultipleChoice,
                StudentAnswer::MultipleChoice { .. }
            )
            | (QuestionType::FillBlank, StudentAnswer::FillBlank { .. })
            | (QuestionType::Essay, StudentAnswer::Essay { .. })
    )
}
fn graded(correct: bool, points: i64, parts: Vec<GradePart>) -> GradeResult {
    GradeResult::Graded {
        correct,
        score: if correct { points } else { 0 },
        max_score: points,
        parts,
    }
}
fn ensure_option(options: &[ChoiceOption], option_id: &str) -> Result<(), GradingError> {
    if options.iter().any(|option| option.id == option_id) {
        Ok(())
    } else {
        Err(GradingError::InvalidAnswer(
            "unknown choice option".to_owned(),
        ))
    }
}
fn ensure_unique_options(
    options: &[ChoiceOption],
    option_ids: &[String],
) -> Result<(), GradingError> {
    let mut seen = HashSet::new();
    for id in option_ids {
        ensure_option(options, id).map_err(|_| {
            GradingError::InvalidAnswer("unknown or duplicate choice option".to_owned())
        })?;
        if !seen.insert(id) {
            return Err(GradingError::InvalidAnswer(
                "duplicate choice option".to_owned(),
            ));
        }
    }
    Ok(())
}
fn normalize(value: &str, config: &crate::question_domain::FillBlankNormalization) -> String {
    let value: String = value.nfkc().collect();
    let value = if config.trim {
        value.trim().to_owned()
    } else {
        value
    };
    if config.case_sensitive {
        value
    } else {
        value.to_lowercase()
    }
}
fn grade_fill_blank(
    config: &FillBlankConfig,
    values: &std::collections::BTreeMap<String, String>,
    points: i64,
) -> Result<GradeResult, GradingError> {
    if values
        .keys()
        .any(|key| !config.blanks.iter().any(|blank| blank.id == *key))
    {
        return Err(GradingError::InvalidAnswer(
            "unknown fill-blank ID".to_owned(),
        ));
    }
    let parts = config
        .blanks
        .iter()
        .map(|blank| {
            let actual = values
                .get(&blank.id)
                .map(|value| normalize(value, &config.normalization));
            let correct = actual
                .map(|value| {
                    blank
                        .accepted_answers
                        .iter()
                        .any(|answer| normalize(answer, &config.normalization) == value)
                })
                .unwrap_or(false);
            GradePart {
                id: blank.id.clone(),
                correct,
            }
        })
        .collect::<Vec<_>>();
    Ok(graded(parts.iter().all(|part| part.correct), points, parts))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::Value;

    #[derive(Deserialize)]
    struct Vector {
        question: Value,
        answer: StudentAnswer,
        expected: Expected,
    }
    #[derive(Deserialize)]
    struct Expected {
        status: String,
        correct: Option<bool>,
        score: Option<i64>,
        #[serde(rename = "maxScore")]
        max_score: i64,
    }

    #[test]
    fn shared_vectors_match_rust_grading() {
        let vectors: Vec<Vector> = serde_json::from_str(include_str!(
            "../../../../packages/grading/test-vectors/grading-vectors.json"
        ))
        .expect("vectors");
        for vector in vectors {
            let question_type: QuestionType = serde_json::from_value(Value::String(
                vector.question["type"].as_str().expect("type").to_owned(),
            ))
            .expect("question type");
            let config: QuestionConfiguration =
                serde_json::from_value(vector.question["answerConfig"].clone()).expect("config");
            let points = vector.question["points"].as_i64().expect("points");
            let result =
                grade_question(&question_type, &config, points, &vector.answer).expect("grade");
            match result {
                GradeResult::Graded {
                    correct,
                    score,
                    max_score,
                    ..
                } => {
                    assert_eq!(vector.expected.status, "graded");
                    assert_eq!(vector.expected.correct, Some(correct));
                    assert_eq!(vector.expected.score, Some(score));
                    assert_eq!(max_score, vector.expected.max_score);
                }
                GradeResult::Pending { max_score } => {
                    assert_eq!(vector.expected.status, "pending");
                    assert_eq!(max_score, vector.expected.max_score);
                }
            }
        }
    }

    #[test]
    fn invalid_answer_is_structured() {
        let question_type = QuestionType::SingleChoice;
        let config =
            QuestionConfiguration::SingleChoice(crate::question_domain::SingleChoiceConfig {
                options: vec![
                    ChoiceOption {
                        id: "a".to_owned(),
                        text: "A".to_owned(),
                    },
                    ChoiceOption {
                        id: "b".to_owned(),
                        text: "B".to_owned(),
                    },
                ],
                correct_option_id: "a".to_owned(),
            });
        assert!(matches!(
            grade_question(
                &question_type,
                &config,
                1,
                &StudentAnswer::SingleChoice {
                    option_id: "missing".to_owned()
                }
            ),
            Err(GradingError::InvalidAnswer(_))
        ));
    }
}
