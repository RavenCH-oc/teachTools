use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::PersistenceService;
use crate::error::AppError;
use crate::infrastructure::persistence::database::Database;
use crate::infrastructure::persistence::repositories::{
    LessonRepository, NewQuestion, NewQuestionSet, Question, QuestionRepository, QuestionSet,
    QuestionSetRepository,
};
use crate::question_domain::{QuestionConfiguration, QuestionType, QUESTION_CONFIG_VERSION};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionSetDto {
    pub id: String,
    pub lesson_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionDto {
    pub id: String,
    pub question_set_id: String,
    #[serde(rename = "type")]
    pub question_type: QuestionType,
    pub prompt: String,
    pub points: i64,
    pub position: i64,
    pub answer_config: QuestionConfiguration,
    pub grading_config: Value,
    pub metadata: Value,
    pub config_version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateQuestionSetRequest {
    pub lesson_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateQuestionSetRequest {
    pub lesson_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateQuestionRequest {
    pub question_set_id: String,
    #[serde(rename = "type")]
    pub question_type: QuestionType,
    pub prompt: String,
    pub points: i64,
    pub position: i64,
    pub answer_config: QuestionConfiguration,
    #[serde(default = "empty_object")]
    pub grading_config: Value,
    #[serde(default = "empty_object")]
    pub metadata: Value,
    #[serde(default = "default_config_version")]
    pub config_version: i64,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateQuestionRequest {
    pub question_set_id: String,
    #[serde(rename = "type")]
    pub question_type: QuestionType,
    pub prompt: String,
    pub points: i64,
    pub position: i64,
    pub answer_config: QuestionConfiguration,
    #[serde(default = "empty_object")]
    pub grading_config: Value,
    #[serde(default = "empty_object")]
    pub metadata: Value,
    #[serde(default = "default_config_version")]
    pub config_version: i64,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderQuestionsRequest {
    pub question_set_id: String,
    pub ordered_question_ids: Vec<String>,
}

fn empty_object() -> Value {
    serde_json::json!({})
}
fn default_config_version() -> i64 {
    QUESTION_CONFIG_VERSION
}
fn clean(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_owned();
        (!value.is_empty()).then_some(value)
    })
}
fn validate_json_object(value: &Value, label: &str) -> Result<(), AppError> {
    if !value.is_object()
        || !serde_json::to_vec(value)
            .map(|bytes| bytes.len() <= 32_768)
            .unwrap_or(false)
    {
        return Err(AppError::Validation(format!(
            "{label} must be a bounded JSON object"
        )));
    }
    Ok(())
}
fn type_name(value: &QuestionType) -> &'static str {
    match value {
        QuestionType::TrueFalse => "true_false",
        QuestionType::SingleChoice => "single_choice",
        QuestionType::MultipleChoice => "multiple_choice",
        QuestionType::FillBlank => "fill_blank",
        QuestionType::Essay => "essay",
    }
}
#[allow(clippy::too_many_arguments)]
fn validate_question_input(
    database: &Database,
    question_set_id: &str,
    question_type: &QuestionType,
    prompt: &str,
    points: i64,
    position: i64,
    config_version: i64,
    answer_config: &QuestionConfiguration,
    grading_config: &Value,
    metadata: &Value,
) -> Result<(), AppError> {
    if QuestionSetRepository::get(database, question_set_id)?.is_none() {
        return Err(AppError::NotFound("question set".to_owned()));
    }
    if prompt.trim().is_empty() {
        return Err(AppError::Validation("prompt must not be empty".to_owned()));
    }
    if points <= 0 || position < 0 {
        return Err(AppError::Validation(
            "points must be positive and position must not be negative".to_owned(),
        ));
    }
    if config_version != QUESTION_CONFIG_VERSION {
        return Err(AppError::Validation(
            "unsupported question config version".to_owned(),
        ));
    }
    answer_config.validate_for(question_type)?;
    validate_json_object(grading_config, "grading config")?;
    validate_json_object(metadata, "metadata")
}
fn to_question_type(raw: &str) -> Result<QuestionType, AppError> {
    serde_json::from_value(Value::String(raw.to_owned())).map_err(|_| AppError::Storage)
}
fn question_dto(raw: Question) -> Result<QuestionDto, AppError> {
    if raw.points <= 0 || raw.position < 0 || raw.prompt.trim().is_empty() {
        return Err(AppError::Storage);
    }
    let question_type = to_question_type(&raw.question_type)?;
    let answer_config: QuestionConfiguration =
        serde_json::from_value(raw.answer_config).map_err(|_| AppError::Storage)?;
    answer_config
        .validate_for(&question_type)
        .map_err(|_| AppError::Storage)?;
    validate_json_object(&raw.grading_config, "grading config").map_err(|_| AppError::Storage)?;
    validate_json_object(&raw.metadata, "metadata").map_err(|_| AppError::Storage)?;
    Ok(QuestionDto {
        id: raw.id,
        question_set_id: raw.question_set_id,
        question_type,
        prompt: raw.prompt,
        points: raw.points,
        position: raw.position,
        answer_config,
        grading_config: raw.grading_config,
        metadata: raw.metadata,
        config_version: QUESTION_CONFIG_VERSION,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
    })
}
impl PersistenceService {
    pub fn list_question_sets(&self) -> Result<Vec<QuestionSetDto>, AppError> {
        Ok(QuestionSetRepository::list(&self.database)?
            .into_iter()
            .map(Into::into)
            .collect())
    }
    pub fn get_question_set(&self, id: String) -> Result<QuestionSetDto, AppError> {
        QuestionSetRepository::get(&self.database, &id)?
            .map(Into::into)
            .ok_or(AppError::NotFound("question set".to_owned()))
    }
    pub fn create_question_set(
        &self,
        request: CreateQuestionSetRequest,
    ) -> Result<QuestionSetDto, AppError> {
        if let Some(lesson_id) = &request.lesson_id {
            if LessonRepository::get(&self.database, lesson_id)?.is_none() {
                return Err(AppError::NotFound("lesson".to_owned()));
            }
        }
        Ok(QuestionSetRepository::create(
            &self.database,
            NewQuestionSet {
                lesson_id: request.lesson_id,
                title: request.title.trim().to_owned(),
                description: clean(request.description),
            },
        )?
        .into())
    }
    pub fn update_question_set(
        &self,
        id: String,
        request: UpdateQuestionSetRequest,
    ) -> Result<QuestionSetDto, AppError> {
        if let Some(lesson_id) = &request.lesson_id {
            if LessonRepository::get(&self.database, lesson_id)?.is_none() {
                return Err(AppError::NotFound("lesson".to_owned()));
            }
        }
        Ok(QuestionSetRepository::update(
            &self.database,
            &id,
            request.lesson_id,
            request.title.trim().to_owned(),
            clean(request.description),
        )?
        .into())
    }
    pub fn delete_question_set(&self, id: String) -> Result<(), AppError> {
        QuestionSetRepository::delete(&self.database, &id)
    }
    pub fn list_questions(&self, question_set_id: String) -> Result<Vec<QuestionDto>, AppError> {
        if QuestionSetRepository::get(&self.database, &question_set_id)?.is_none() {
            return Err(AppError::NotFound("question set".to_owned()));
        }
        QuestionRepository::list_by_question_set(&self.database, &question_set_id)?
            .into_iter()
            .map(question_dto)
            .collect()
    }
    pub fn get_question(&self, id: String) -> Result<QuestionDto, AppError> {
        QuestionRepository::get(&self.database, &id)?
            .map(question_dto)
            .transpose()?
            .ok_or(AppError::NotFound("question".to_owned()))
    }
    pub fn create_question(&self, request: CreateQuestionRequest) -> Result<QuestionDto, AppError> {
        validate_question_input(
            &self.database,
            &request.question_set_id,
            &request.question_type,
            &request.prompt,
            request.points,
            request.position,
            request.config_version,
            &request.answer_config,
            &request.grading_config,
            &request.metadata,
        )?;
        let raw = QuestionRepository::create(
            &self.database,
            NewQuestion {
                question_set_id: request.question_set_id,
                question_type: type_name(&request.question_type).to_owned(),
                prompt: request.prompt.trim().to_owned(),
                points: request.points,
                position: request.position,
                answer_config: serde_json::to_value(request.answer_config)
                    .map_err(|_| AppError::Validation("answer config must be JSON".to_owned()))?,
                grading_config: request.grading_config,
                metadata: request.metadata,
            },
        )?;
        question_dto(raw)
    }
    pub fn update_question(
        &self,
        id: String,
        request: UpdateQuestionRequest,
    ) -> Result<QuestionDto, AppError> {
        validate_question_input(
            &self.database,
            &request.question_set_id,
            &request.question_type,
            &request.prompt,
            request.points,
            request.position,
            request.config_version,
            &request.answer_config,
            &request.grading_config,
            &request.metadata,
        )?;
        let raw = QuestionRepository::update(
            &self.database,
            &id,
            NewQuestion {
                question_set_id: request.question_set_id,
                question_type: type_name(&request.question_type).to_owned(),
                prompt: request.prompt.trim().to_owned(),
                points: request.points,
                position: request.position,
                answer_config: serde_json::to_value(request.answer_config)
                    .map_err(|_| AppError::Validation("answer config must be JSON".to_owned()))?,
                grading_config: request.grading_config,
                metadata: request.metadata,
            },
        )?;
        question_dto(raw)
    }
    pub fn delete_question(&self, id: String) -> Result<(), AppError> {
        QuestionRepository::delete(&self.database, &id)
    }
    pub fn reorder_questions(
        &self,
        request: ReorderQuestionsRequest,
    ) -> Result<Vec<QuestionDto>, AppError> {
        if QuestionSetRepository::get(&self.database, &request.question_set_id)?.is_none() {
            return Err(AppError::NotFound("question set".to_owned()));
        }
        let current =
            QuestionRepository::list_by_question_set(&self.database, &request.question_set_id)?;
        let mut expected = current
            .iter()
            .map(|question| question.id.clone())
            .collect::<Vec<_>>();
        expected.sort();
        let mut actual = request.ordered_question_ids.clone();
        actual.sort();
        if request.ordered_question_ids.len() != current.len() || actual != expected {
            return Err(AppError::Validation(
                "ordered question IDs must exactly match the question set".to_owned(),
            ));
        }
        if request
            .ordered_question_ids
            .windows(2)
            .any(|pair| pair[0] == pair[1])
        {
            return Err(AppError::Validation(
                "ordered question IDs must be unique".to_owned(),
            ));
        }
        QuestionRepository::reorder(
            &self.database,
            &request.question_set_id,
            &request.ordered_question_ids,
        )?;
        self.list_questions(request.question_set_id)
    }
}
impl From<QuestionSet> for QuestionSetDto {
    fn from(value: QuestionSet) -> Self {
        Self {
            id: value.id,
            lesson_id: value.lesson_id,
            title: value.title,
            description: value.description,
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::question_domain::{
        ChoiceOption, EssayConfig, FillBlankConfig, FillBlankDefinition, FillBlankNormalization,
        MultipleChoiceConfig, SingleChoiceConfig, TrueFalseConfig,
    };

    fn metadata() -> Value {
        serde_json::json!({})
    }
    fn request(
        set: &str,
        question_type: QuestionType,
        answer_config: QuestionConfiguration,
        points: i64,
    ) -> CreateQuestionRequest {
        CreateQuestionRequest {
            question_set_id: set.to_owned(),
            question_type,
            prompt: "Prompt".to_owned(),
            points,
            position: 0,
            answer_config,
            grading_config: serde_json::json!({}),
            metadata: metadata(),
            config_version: 1,
        }
    }

    #[test]
    fn question_set_and_all_question_types_round_trip_with_conflicts() {
        let directory = tempfile::tempdir().expect("directory");
        let service = PersistenceService::initialize(directory.path()).expect("service");
        let set = service
            .create_question_set(CreateQuestionSetRequest {
                lesson_id: None,
                title: "Set".to_owned(),
                description: None,
            })
            .expect("set");
        let set = service
            .update_question_set(
                set.id.clone(),
                UpdateQuestionSetRequest {
                    lesson_id: None,
                    title: "Updated Set".to_owned(),
                    description: Some("Description".to_owned()),
                },
            )
            .expect("update set");
        let requests = vec![
            request(
                &set.id,
                QuestionType::TrueFalse,
                QuestionConfiguration::TrueFalse(TrueFalseConfig {
                    correct_answer: true,
                }),
                1,
            ),
            request(
                &set.id,
                QuestionType::SingleChoice,
                QuestionConfiguration::SingleChoice(SingleChoiceConfig {
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
                }),
                2,
            ),
            request(
                &set.id,
                QuestionType::MultipleChoice,
                QuestionConfiguration::MultipleChoice(MultipleChoiceConfig {
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
                    correct_option_ids: vec!["a".to_owned()],
                }),
                3,
            ),
            request(
                &set.id,
                QuestionType::FillBlank,
                QuestionConfiguration::FillBlank(FillBlankConfig {
                    blanks: vec![FillBlankDefinition {
                        id: "one".to_owned(),
                        accepted_answers: vec!["One".to_owned()],
                    }],
                    normalization: FillBlankNormalization {
                        trim: true,
                        unicode_normalization: "NFKC".to_owned(),
                        case_sensitive: false,
                    },
                }),
                4,
            ),
            request(
                &set.id,
                QuestionType::Essay,
                QuestionConfiguration::Essay(EssayConfig {
                    rubric_reference: None,
                }),
                5,
            ),
        ];
        let created = requests
            .into_iter()
            .map(|request| service.create_question(request).expect("question"))
            .collect::<Vec<_>>();
        let updated = service
            .update_question(
                created[0].id.clone(),
                UpdateQuestionRequest {
                    question_set_id: set.id.clone(),
                    question_type: QuestionType::TrueFalse,
                    prompt: "Updated prompt".to_owned(),
                    points: 2,
                    position: 1,
                    answer_config: QuestionConfiguration::TrueFalse(TrueFalseConfig {
                        correct_answer: false,
                    }),
                    grading_config: serde_json::json!({}),
                    metadata: metadata(),
                    config_version: 1,
                },
            )
            .expect("update question");
        assert_eq!(updated.prompt, "Updated prompt");
        assert_eq!(
            service.list_questions(set.id.clone()).expect("list").len(),
            5
        );
        assert_eq!(
            service
                .get_question(created[0].id.clone())
                .expect("get")
                .question_type,
            QuestionType::TrueFalse
        );
        assert!(service.delete_question_set(set.id.clone()).is_err());
        service
            .delete_question(created[0].id.clone())
            .expect("delete one");
        assert_eq!(
            service
                .list_questions(set.id.clone())
                .expect("list after delete")
                .len(),
            4
        );
        for question in created.into_iter().skip(1) {
            service
                .delete_question(question.id)
                .expect("delete question");
        }
        service.delete_question_set(set.id).expect("delete set");
    }

    #[test]
    fn malformed_question_configuration_fails_as_storage_error() {
        let directory = tempfile::tempdir().expect("directory");
        let service = PersistenceService::initialize(directory.path()).expect("service");
        let set = service
            .create_question_set(CreateQuestionSetRequest {
                lesson_id: None,
                title: "Set".to_owned(),
                description: None,
            })
            .expect("set");
        let question = service
            .create_question(request(
                &set.id,
                QuestionType::TrueFalse,
                QuestionConfiguration::TrueFalse(TrueFalseConfig {
                    correct_answer: true,
                }),
                1,
            ))
            .expect("question");
        let database = Database::open(directory.path().join("classroom.sqlite3"));
        database
            .connection()
            .expect("connection")
            .execute(
                "UPDATE questions SET answer_config='not-json' WHERE id=?1",
                [&question.id],
            )
            .expect("tamper");
        assert!(matches!(
            service.get_question(question.id),
            Err(AppError::Storage)
        ));
    }

    #[test]
    fn reorder_questions_is_atomic_and_deterministic() {
        let directory = tempfile::tempdir().expect("directory");
        let service = PersistenceService::initialize(directory.path()).expect("service");
        let set = service
            .create_question_set(CreateQuestionSetRequest {
                lesson_id: None,
                title: "Set".to_owned(),
                description: None,
            })
            .expect("set");
        let questions = (0..3)
            .map(|position| {
                service
                    .create_question(CreateQuestionRequest {
                        position,
                        ..request(
                            &set.id,
                            QuestionType::TrueFalse,
                            QuestionConfiguration::TrueFalse(TrueFalseConfig {
                                correct_answer: true,
                            }),
                            1,
                        )
                    })
                    .expect("question")
            })
            .collect::<Vec<_>>();
        let ordered = vec![
            questions[2].id.clone(),
            questions[0].id.clone(),
            questions[1].id.clone(),
        ];
        let saved = service
            .reorder_questions(ReorderQuestionsRequest {
                question_set_id: set.id.clone(),
                ordered_question_ids: ordered.clone(),
            })
            .expect("reorder");
        assert_eq!(
            saved
                .iter()
                .map(|question| question.id.clone())
                .collect::<Vec<_>>(),
            ordered
        );
        assert!(matches!(
            service.reorder_questions(ReorderQuestionsRequest {
                question_set_id: set.id.clone(),
                ordered_question_ids: vec![
                    questions[0].id.clone(),
                    questions[0].id.clone(),
                    questions[1].id.clone()
                ],
            }),
            Err(AppError::Validation(_))
        ));
        assert_eq!(
            service
                .list_questions(set.id)
                .expect("list")
                .iter()
                .map(|question| question.position)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
    }
}
