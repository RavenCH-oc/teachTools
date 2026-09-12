use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::error::AppError;
use crate::infrastructure::persistence::database::Database;
use crate::infrastructure::persistence::repositories::live_quiz::{
    SessionQuestionRecord, SubmissionRecord,
};
use crate::infrastructure::persistence::repositories::statistics::{
    StatisticsRepository, StatisticsSnapshot,
};
use crate::question_domain::{QuestionConfiguration, QuestionType, StudentAnswer};

const ELIGIBLE_STATES: [&str; 3] = ["OPEN", "LOCKED", "REVEALED"];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceDistributionDto {
    pub option_id: String,
    pub label: String,
    pub selection_count: i64,
    pub selection_rate: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuestionStatisticsDto {
    pub session_question_id: String,
    pub position: i64,
    pub question_type: String,
    pub prompt: String,
    pub participant_count: i64,
    pub answered_count: i64,
    pub unanswered_count: i64,
    pub response_rate: Option<f64>,
    pub graded_count: i64,
    pub pending_count: i64,
    pub correct_count: i64,
    pub incorrect_count: i64,
    pub accuracy: Option<f64>,
    pub average_score: Option<f64>,
    pub max_points: i64,
    pub choice_distribution: Vec<ChoiceDistributionDto>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantSessionStatisticsDto {
    pub participant_id: String,
    pub seat_number: i64,
    pub display_name: String,
    pub eligible_question_count: i64,
    pub answered_count: i64,
    pub unanswered_count: i64,
    pub graded_count: i64,
    pub pending_count: i64,
    pub correct_count: i64,
    pub incorrect_count: i64,
    pub earned_score: i64,
    pub graded_possible_score: i64,
    pub accuracy: Option<f64>,
    pub score_rate: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatisticsDto {
    pub session_id: String,
    pub session_state: String,
    pub participant_count: i64,
    pub published_question_count: i64,
    pub eligible_question_count: i64,
    pub answered_opportunity_count: i64,
    pub total_opportunity_count: i64,
    pub response_rate: Option<f64>,
    pub graded_submission_count: i64,
    pub pending_submission_count: i64,
    pub correct_count: i64,
    pub incorrect_count: i64,
    pub accuracy: Option<f64>,
    pub earned_score_total: i64,
    pub graded_possible_score_total: i64,
    pub score_rate: Option<f64>,
    pub question_summaries: Vec<QuestionStatisticsDto>,
    pub participant_summaries: Vec<ParticipantSessionStatisticsDto>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuestionDifficultyDto {
    pub session_question_id: String,
    pub position: i64,
    pub prompt: String,
    pub accuracy: f64,
    pub graded_count: i64,
}

#[derive(Clone)]
pub struct StatisticsService {
    database: Database,
}

impl StatisticsService {
    pub fn initialize(database: Database) -> Self {
        Self { database }
    }

    pub fn question_statistics(
        &self,
        session_id: &str,
        session_question_id: &str,
    ) -> Result<QuestionStatisticsDto, AppError> {
        let snapshot = StatisticsRepository::snapshot(&self.database, session_id)?;
        let latest = latest_by_pair(&snapshot);
        let question = snapshot
            .questions
            .iter()
            .find(|question| question.id == session_question_id && is_eligible(&question.state))
            .ok_or_else(|| AppError::NotFound("eligible session question".to_owned()))?;
        question_statistics(&snapshot, question, &latest)
    }

    pub fn list_question_statistics(
        &self,
        session_id: &str,
    ) -> Result<Vec<QuestionStatisticsDto>, AppError> {
        let snapshot = StatisticsRepository::snapshot(&self.database, session_id)?;
        let latest = latest_by_pair(&snapshot);
        snapshot
            .questions
            .iter()
            .filter(|question| is_eligible(&question.state))
            .map(|question| question_statistics(&snapshot, question, &latest))
            .collect()
    }

    pub fn participant_statistics(
        &self,
        session_id: &str,
        participant_id: &str,
    ) -> Result<ParticipantSessionStatisticsDto, AppError> {
        let snapshot = StatisticsRepository::snapshot(&self.database, session_id)?;
        let participant = snapshot
            .participants
            .iter()
            .find(|participant| participant.id == participant_id)
            .ok_or_else(|| AppError::NotFound("session participant".to_owned()))?;
        let latest = latest_by_pair(&snapshot);
        participant_statistics(&snapshot, participant, &latest)
    }

    pub fn session_statistics(&self, session_id: &str) -> Result<SessionStatisticsDto, AppError> {
        let snapshot = StatisticsRepository::snapshot(&self.database, session_id)?;
        let latest = latest_by_pair(&snapshot);
        session_statistics(&snapshot, &latest)
    }

    pub fn difficult_questions(
        &self,
        session_id: &str,
    ) -> Result<Vec<QuestionDifficultyDto>, AppError> {
        let snapshot = StatisticsRepository::snapshot(&self.database, session_id)?;
        let latest = latest_by_pair(&snapshot);
        let mut questions = snapshot
            .questions
            .iter()
            .filter(|question| is_eligible(&question.state))
            .map(|question| {
                question_statistics(&snapshot, question, &latest).map(|stats| {
                    (stats.graded_count > 0).then_some(QuestionDifficultyDto {
                        session_question_id: stats.session_question_id,
                        position: stats.position,
                        prompt: stats.prompt,
                        accuracy: stats.accuracy.unwrap_or(0.0),
                        graded_count: stats.graded_count,
                    })
                })
            })
            .collect::<Result<Vec<Option<_>>, _>>()?
            .into_iter()
            .flatten()
            .filter(|question| question.graded_count > 0)
            .collect::<Vec<_>>();
        questions.sort_by(|left, right| {
            left.accuracy
                .total_cmp(&right.accuracy)
                .then_with(|| right.graded_count.cmp(&left.graded_count))
                .then_with(|| left.position.cmp(&right.position))
                .then_with(|| left.session_question_id.cmp(&right.session_question_id))
        });
        Ok(questions)
    }
}

pub(super) fn statistics_from_snapshot(
    snapshot: &StatisticsSnapshot,
) -> Result<SessionStatisticsDto, AppError> {
    session_statistics(snapshot, &latest_by_pair(snapshot))
}

#[derive(Default)]
struct Aggregate {
    answered_count: i64,
    graded_count: i64,
    pending_count: i64,
    correct_count: i64,
    incorrect_count: i64,
    earned_score: i64,
    graded_possible_score: i64,
}

impl Aggregate {
    fn observe(
        &mut self,
        submission: &SubmissionRecord,
        question: &SessionQuestionRecord,
    ) -> Result<(), AppError> {
        if submission.max_score != question.points || submission.max_score <= 0 {
            return Err(AppError::Storage);
        }
        self.answered_count = checked_add(self.answered_count, 1)?;
        match submission.grading_status.as_str() {
            "pending" => {
                self.pending_count = checked_add(self.pending_count, 1)?;
            }
            "graded" => {
                let score = submission.score.ok_or(AppError::Storage)?;
                if score < 0 || score > question.points || submission.is_correct.is_none() {
                    return Err(AppError::Storage);
                }
                self.graded_count = checked_add(self.graded_count, 1)?;
                self.graded_possible_score =
                    checked_add(self.graded_possible_score, question.points)?;
                self.earned_score = checked_add(self.earned_score, score)?;
                if submission.is_correct == Some(true) {
                    self.correct_count = checked_add(self.correct_count, 1)?;
                } else {
                    self.incorrect_count = checked_add(self.incorrect_count, 1)?;
                }
            }
            _ => return Err(AppError::Storage),
        }
        Ok(())
    }
}

fn session_statistics(
    snapshot: &StatisticsSnapshot,
    latest: &HashMap<(&str, &str), &SubmissionRecord>,
) -> Result<SessionStatisticsDto, AppError> {
    let eligible_questions = snapshot
        .questions
        .iter()
        .filter(|question| is_eligible(&question.state))
        .collect::<Vec<_>>();
    let question_summaries = eligible_questions
        .iter()
        .map(|question| question_statistics(snapshot, question, latest))
        .collect::<Result<Vec<_>, _>>()?;
    let participant_summaries = snapshot
        .participants
        .iter()
        .map(|participant| participant_statistics(snapshot, participant, latest))
        .collect::<Result<Vec<_>, _>>()?;
    let participant_count = count(snapshot.participants.len())?;
    let eligible_question_count = count(eligible_questions.len())?;
    let total_opportunity_count = checked_mul(participant_count, eligible_question_count)?;
    let answered_opportunity_count = sum_i64(
        question_summaries
            .iter()
            .map(|question| question.answered_count),
    )?;
    let graded_submission_count = sum_i64(
        question_summaries
            .iter()
            .map(|question| question.graded_count),
    )?;
    let pending_submission_count = sum_i64(
        question_summaries
            .iter()
            .map(|question| question.pending_count),
    )?;
    let correct_count = sum_i64(
        question_summaries
            .iter()
            .map(|question| question.correct_count),
    )?;
    let incorrect_count = sum_i64(
        question_summaries
            .iter()
            .map(|question| question.incorrect_count),
    )?;
    let earned_score_total = sum_i64(
        participant_summaries
            .iter()
            .map(|participant| participant.earned_score),
    )?;
    let graded_possible_score_total = sum_i64(
        participant_summaries
            .iter()
            .map(|participant| participant.graded_possible_score),
    )?;

    Ok(SessionStatisticsDto {
        session_id: snapshot.session_id.clone(),
        session_state: snapshot.session_state.clone(),
        participant_count,
        published_question_count: count(snapshot.questions.len())?,
        eligible_question_count,
        answered_opportunity_count,
        total_opportunity_count,
        response_rate: ratio(answered_opportunity_count, total_opportunity_count),
        graded_submission_count,
        pending_submission_count,
        correct_count,
        incorrect_count,
        accuracy: ratio(correct_count, graded_submission_count),
        earned_score_total,
        graded_possible_score_total,
        score_rate: ratio(earned_score_total, graded_possible_score_total),
        question_summaries,
        participant_summaries,
    })
}

fn question_statistics(
    snapshot: &StatisticsSnapshot,
    question: &SessionQuestionRecord,
    latest: &HashMap<(&str, &str), &SubmissionRecord>,
) -> Result<QuestionStatisticsDto, AppError> {
    let participant_count = count(snapshot.participants.len())?;
    let mut aggregate = Aggregate::default();
    let mut submissions = Vec::new();
    for participant in &snapshot.participants {
        if let Some(submission) = latest.get(&(question.id.as_str(), participant.id.as_str())) {
            aggregate.observe(submission, question)?;
            submissions.push(*submission);
        }
    }
    let unanswered_count = participant_count
        .checked_sub(aggregate.answered_count)
        .ok_or(AppError::Storage)?;
    let choice_distribution =
        choice_distribution(question, &submissions, aggregate.answered_count)?;
    Ok(QuestionStatisticsDto {
        session_question_id: question.id.clone(),
        position: question.position,
        question_type: question.question_type.clone(),
        prompt: question.prompt.clone(),
        participant_count,
        answered_count: aggregate.answered_count,
        unanswered_count,
        response_rate: ratio(aggregate.answered_count, participant_count),
        graded_count: aggregate.graded_count,
        pending_count: aggregate.pending_count,
        correct_count: aggregate.correct_count,
        incorrect_count: aggregate.incorrect_count,
        accuracy: ratio(aggregate.correct_count, aggregate.graded_count),
        average_score: (aggregate.graded_count > 0)
            .then_some(aggregate.earned_score as f64 / aggregate.graded_count as f64),
        max_points: question.points,
        choice_distribution,
    })
}

fn participant_statistics(
    snapshot: &StatisticsSnapshot,
    participant: &crate::infrastructure::persistence::repositories::local_session::ParticipantRecord,
    latest: &HashMap<(&str, &str), &SubmissionRecord>,
) -> Result<ParticipantSessionStatisticsDto, AppError> {
    let eligible_questions = snapshot
        .questions
        .iter()
        .filter(|question| is_eligible(&question.state))
        .collect::<Vec<_>>();
    let mut aggregate = Aggregate::default();
    for question in &eligible_questions {
        if let Some(submission) = latest.get(&(question.id.as_str(), participant.id.as_str())) {
            aggregate.observe(submission, question)?;
        }
    }
    let eligible_question_count = count(eligible_questions.len())?;
    let unanswered_count = eligible_question_count
        .checked_sub(aggregate.answered_count)
        .ok_or(AppError::Storage)?;
    Ok(ParticipantSessionStatisticsDto {
        participant_id: participant.id.clone(),
        seat_number: participant.seat_number,
        display_name: participant.display_name.clone(),
        eligible_question_count,
        answered_count: aggregate.answered_count,
        unanswered_count,
        graded_count: aggregate.graded_count,
        pending_count: aggregate.pending_count,
        correct_count: aggregate.correct_count,
        incorrect_count: aggregate.incorrect_count,
        earned_score: aggregate.earned_score,
        graded_possible_score: aggregate.graded_possible_score,
        accuracy: ratio(aggregate.correct_count, aggregate.graded_count),
        score_rate: ratio(aggregate.earned_score, aggregate.graded_possible_score),
    })
}

fn choice_distribution(
    question: &SessionQuestionRecord,
    submissions: &[&SubmissionRecord],
    answered_count: i64,
) -> Result<Vec<ChoiceDistributionDto>, AppError> {
    let kind = question_type(&question.question_type)?;
    let mut options =
        match serde_json::from_value::<QuestionConfiguration>(question.answer_config.clone())
            .map_err(|_| AppError::Storage)?
        {
            QuestionConfiguration::TrueFalse(_) if kind == QuestionType::TrueFalse => vec![
                ("true".to_owned(), "正確".to_owned()),
                ("false".to_owned(), "錯誤".to_owned()),
            ],
            QuestionConfiguration::SingleChoice(config) if kind == QuestionType::SingleChoice => {
                config
                    .options
                    .into_iter()
                    .map(|option| (option.id, option.text))
                    .collect()
            }
            QuestionConfiguration::MultipleChoice(config)
                if kind == QuestionType::MultipleChoice =>
            {
                config
                    .options
                    .into_iter()
                    .map(|option| (option.id, option.text))
                    .collect()
            }
            QuestionConfiguration::FillBlank(_) if kind == QuestionType::FillBlank => {
                return Ok(Vec::new())
            }
            QuestionConfiguration::Essay(_) if kind == QuestionType::Essay => return Ok(Vec::new()),
            _ => return Err(AppError::Storage),
        };
    let valid_ids = options
        .iter()
        .map(|(id, _)| id.clone())
        .collect::<HashSet<_>>();
    let mut counts = HashMap::<String, i64>::new();
    for submission in submissions {
        for option_id in selected_option_ids(submission)? {
            if !valid_ids.contains(&option_id) {
                return Err(AppError::Storage);
            }
            let current = counts.get(&option_id).copied().unwrap_or(0);
            counts.insert(option_id, checked_add(current, 1)?);
        }
    }
    Ok(options
        .drain(..)
        .map(|(option_id, label)| {
            let selection_count = counts.get(&option_id).copied().unwrap_or(0);
            ChoiceDistributionDto {
                option_id,
                label,
                selection_count,
                selection_rate: ratio(selection_count, answered_count),
            }
        })
        .collect())
}

fn selected_option_ids(submission: &SubmissionRecord) -> Result<Vec<String>, AppError> {
    let answer: StudentAnswer =
        serde_json::from_value(submission.answer_json.clone()).map_err(|_| AppError::Storage)?;
    match answer {
        StudentAnswer::TrueFalse { value } => Ok(vec![value.to_string()]),
        StudentAnswer::SingleChoice { option_id } => Ok(vec![option_id]),
        StudentAnswer::MultipleChoice { option_ids } => Ok(option_ids),
        StudentAnswer::FillBlank { .. } | StudentAnswer::Essay { .. } => Ok(Vec::new()),
    }
}

fn latest_by_pair(snapshot: &StatisticsSnapshot) -> HashMap<(&str, &str), &SubmissionRecord> {
    snapshot
        .latest_submissions
        .iter()
        .map(|submission| {
            (
                (
                    submission.session_question_id.as_str(),
                    submission.participant_id.as_str(),
                ),
                submission,
            )
        })
        .collect()
}

fn question_type(value: &str) -> Result<QuestionType, AppError> {
    match value {
        "true_false" => Ok(QuestionType::TrueFalse),
        "single_choice" => Ok(QuestionType::SingleChoice),
        "multiple_choice" => Ok(QuestionType::MultipleChoice),
        "fill_blank" => Ok(QuestionType::FillBlank),
        "essay" => Ok(QuestionType::Essay),
        _ => Err(AppError::Storage),
    }
}

fn is_eligible(state: &str) -> bool {
    ELIGIBLE_STATES.contains(&state)
}

fn count(value: usize) -> Result<i64, AppError> {
    i64::try_from(value).map_err(|_| AppError::Storage)
}

fn checked_add(left: i64, right: i64) -> Result<i64, AppError> {
    left.checked_add(right).ok_or(AppError::Storage)
}

fn checked_mul(left: i64, right: i64) -> Result<i64, AppError> {
    left.checked_mul(right).ok_or(AppError::Storage)
}

fn sum_i64(mut values: impl Iterator<Item = i64>) -> Result<i64, AppError> {
    values.try_fold(0_i64, checked_add)
}

fn ratio(numerator: i64, denominator: i64) -> Option<f64> {
    (denominator > 0).then_some(numerator as f64 / denominator as f64)
}

#[cfg(test)]
mod tests {
    use super::{ratio, StatisticsService};
    use crate::infrastructure::persistence::database::Database;
    use crate::infrastructure::persistence::repositories::live_quiz::{
        LiveQuizRepository, SubmissionRecord,
    };
    use crate::infrastructure::persistence::repositories::local_session::{
        LocalSessionRepository, NewLocalSession,
    };
    use crate::infrastructure::persistence::repositories::{
        ClassroomRepository, NewClassroom, NewQuestion, NewQuestionSet, NewStudent,
        QuestionRepository, QuestionSetRepository, StudentRepository,
    };
    use rusqlite::params;

    struct Fixture {
        _directory: tempfile::TempDir,
        database: Database,
        session_id: String,
        source_question_id: String,
        question_ids: Vec<String>,
        participant_ids: Vec<String>,
    }

    fn id(number: u32) -> String {
        format!("01900000-0000-7000-8000-{number:012x}")
    }

    fn fixture() -> Fixture {
        let directory = tempfile::tempdir().expect("directory");
        let database = Database::open(directory.path().join("classroom.sqlite3"));
        database.initialize().expect("database");
        let classroom = ClassroomRepository::create(
            &database,
            NewClassroom {
                name: "Statistics".to_owned(),
                academic_year: None,
            },
        )
        .expect("classroom");
        let session_id = id(1);
        LocalSessionRepository::create(
            &database,
            NewLocalSession {
                id: session_id.clone(),
                classroom_id: classroom.id.clone(),
                server_instance_id: id(2),
                join_code: "STAT1234".to_owned(),
            },
        )
        .expect("session");
        database
            .connection()
            .expect("connection")
            .execute(
                "UPDATE local_sessions SET state='ACTIVE' WHERE id=?1",
                [&session_id],
            )
            .expect("active session");

        let mut participant_ids = Vec::new();
        for seat in 1..=30_i64 {
            let student = StudentRepository::create(
                &database,
                NewStudent {
                    class_id: classroom.id.clone(),
                    seat_number: seat,
                    name: format!("Student {seat}"),
                },
            )
            .expect("student");
            let participant_id = id(100 + seat as u32);
            database
                .connection()
                .expect("connection")
                .execute(
                    "INSERT INTO session_participants(id,session_id,student_id,seat_number,display_name,credential_hash,joined_at,updated_at) VALUES(?1,?2,?3,?4,?5,'hash','now','now')",
                    params![participant_id, session_id, student.id, seat, format!("Student {seat}")],
                )
                .expect("participant");
            participant_ids.push(participant_id);
        }

        let set = QuestionSetRepository::create(
            &database,
            NewQuestionSet {
                lesson_id: None,
                title: "Stats set".to_owned(),
                description: None,
            },
        )
        .expect("set");
        let source = QuestionRepository::create(
            &database,
            NewQuestion {
                question_set_id: set.id,
                question_type: "true_false".to_owned(),
                prompt: "Source prompt".to_owned(),
                points: 2,
                position: 0,
                answer_config: serde_json::json!({"correctAnswer": true}),
                grading_config: serde_json::json!({}),
                metadata: serde_json::json!({}),
            },
        )
        .expect("source");
        let questions = [
            (
                id(300),
                "true_false",
                "True or false",
                2_i64,
                0_i64,
                "OPEN",
                serde_json::json!({"correctAnswer": true}),
            ),
            (
                id(301),
                "essay",
                "Essay",
                5,
                1,
                "REVEALED",
                serde_json::json!({}),
            ),
            (
                id(302),
                "multiple_choice",
                "Choose two",
                4,
                2,
                "REVEALED",
                serde_json::json!({"options":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"correctOptionIds":["a","b"]}),
            ),
            (
                id(303),
                "fill_blank",
                "Fill blank",
                3,
                3,
                "REVEALED",
                serde_json::json!({"blanks":[{"id":"blank-1","acceptedAnswers":["answer"]}],"normalization":{"trim":true,"unicodeNormalization":"NFKC","caseSensitive":false}}),
            ),
            (
                id(304),
                "true_false",
                "Hidden",
                2,
                4,
                "HIDDEN",
                serde_json::json!({"correctAnswer": true}),
            ),
        ];
        for (question_id, question_type, prompt, points, position, state, answer_config) in
            &questions
        {
            database
                .connection()
                .expect("connection")
                .execute(
                    "INSERT INTO session_questions(id,session_id,source_question_id,question_type,prompt,points,position,answer_config,grading_config,metadata,config_version,state,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'{}','{}',1,?9,'now','now')",
                    params![question_id, session_id, source.id, question_type, prompt, points, position, answer_config.to_string(), state],
                )
                .expect("session question");
        }

        for (index, participant_id) in participant_ids.iter().take(20).enumerate() {
            insert_submission(
                &database,
                SubmissionInput {
                    question_id: &id(300),
                    participant_id,
                    revision: 1,
                    answer: serde_json::json!({"type":"true_false","value":index != 0 && index < 15}),
                    grading_status: "graded",
                    is_correct: Some(index != 0 && index < 15),
                    score: Some(if index != 0 && index < 15 { 2 } else { 0 }),
                    max_score: 2,
                    submission_id: &id(500 + index as u32),
                },
            );
            if index == 0 {
                insert_submission(
                    &database,
                    SubmissionInput {
                        question_id: &id(300),
                        participant_id,
                        revision: 2,
                        answer: serde_json::json!({"type":"true_false","value":true}),
                        grading_status: "graded",
                        is_correct: Some(true),
                        score: Some(2),
                        max_score: 2,
                        submission_id: &id(550),
                    },
                );
            }
        }
        for (index, participant_id) in participant_ids.iter().take(3).enumerate() {
            insert_submission(
                &database,
                SubmissionInput {
                    question_id: &id(301),
                    participant_id,
                    revision: 1,
                    answer: serde_json::json!({"type":"essay","text":"response"}),
                    grading_status: "pending",
                    is_correct: None,
                    score: None,
                    max_score: 5,
                    submission_id: &id(600 + index as u32),
                },
            );
        }
        insert_submission(
            &database,
            SubmissionInput {
                question_id: &id(302),
                participant_id: &participant_ids[0],
                revision: 1,
                answer: serde_json::json!({"type":"multiple_choice","optionIds":["a","b"]}),
                grading_status: "graded",
                is_correct: Some(true),
                score: Some(4),
                max_score: 4,
                submission_id: &id(610),
            },
        );
        insert_submission(
            &database,
            SubmissionInput {
                question_id: &id(302),
                participant_id: &participant_ids[1],
                revision: 1,
                answer: serde_json::json!({"type":"multiple_choice","optionIds":["a"]}),
                grading_status: "graded",
                is_correct: Some(false),
                score: Some(0),
                max_score: 4,
                submission_id: &id(612),
            },
        );
        insert_submission(
            &database,
            SubmissionInput {
                question_id: &id(302),
                participant_id: &participant_ids[1],
                revision: 2,
                answer: serde_json::json!({"type":"multiple_choice","optionIds":["b"]}),
                grading_status: "graded",
                is_correct: Some(false),
                score: Some(0),
                max_score: 4,
                submission_id: &id(611),
            },
        );
        insert_submission(
            &database,
            SubmissionInput {
                question_id: &id(303),
                participant_id: &participant_ids[0],
                revision: 1,
                answer: serde_json::json!({"type":"fill_blank","values":{"blank-1":"answer"}}),
                grading_status: "pending",
                is_correct: None,
                score: None,
                max_score: 3,
                submission_id: &id(620),
            },
        );
        insert_submission(
            &database,
            SubmissionInput {
                question_id: &id(304),
                participant_id: &participant_ids[0],
                revision: 1,
                answer: serde_json::json!({"type":"true_false","value":true}),
                grading_status: "graded",
                is_correct: Some(true),
                score: Some(2),
                max_score: 2,
                submission_id: &id(630),
            },
        );
        Fixture {
            _directory: directory,
            database,
            session_id,
            source_question_id: source.id,
            question_ids: questions.into_iter().map(|question| question.0).collect(),
            participant_ids,
        }
    }

    struct SubmissionInput<'a> {
        question_id: &'a str,
        participant_id: &'a str,
        revision: i64,
        answer: serde_json::Value,
        grading_status: &'a str,
        is_correct: Option<bool>,
        score: Option<i64>,
        max_score: i64,
        submission_id: &'a str,
    }

    fn insert_submission(database: &Database, input: SubmissionInput<'_>) {
        database
            .connection()
            .expect("connection")
            .execute(
                "INSERT INTO submissions(id,session_question_id,participant_id,revision,answer_json,grading_status,is_correct,score,max_score,submitted_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'now')",
                params![input.submission_id, input.question_id, input.participant_id, input.revision, input.answer.to_string(), input.grading_status, input.is_correct.map(i64::from), input.score, input.max_score],
            )
            .expect("submission");
    }

    #[test]
    fn rates_are_nullable_when_the_denominator_is_zero() {
        assert_eq!(ratio(0, 0), None);
        assert_eq!(ratio(3, 4), Some(0.75));
    }

    #[test]
    fn service_is_constructible_without_cache_or_shared_connection() {
        let directory = tempfile::tempdir().expect("directory");
        let database = Database::open(directory.path().join("classroom.sqlite3"));
        database.initialize().expect("database");
        let _service = StatisticsService::initialize(database);
    }

    #[test]
    fn aggregates_latest_revisions_pending_essays_distributions_and_difficulty() {
        let fixture = fixture();
        let service = StatisticsService::initialize(fixture.database.clone());
        let session = service
            .session_statistics(&fixture.session_id)
            .expect("session statistics");
        assert_eq!(session.participant_count, 30);
        assert_eq!(session.published_question_count, 5);
        assert_eq!(session.eligible_question_count, 4);
        assert_eq!(session.total_opportunity_count, 120);
        assert_eq!(session.answered_opportunity_count, 26);
        assert_eq!(session.graded_submission_count, 22);
        assert_eq!(session.pending_submission_count, 4);
        assert_eq!(session.correct_count, 16);
        assert_eq!(session.incorrect_count, 6);
        assert_eq!(session.earned_score_total, 34);
        assert_eq!(session.graded_possible_score_total, 48);
        assert_eq!(session.question_summaries.len(), 4);
        assert_eq!(session.participant_summaries.len(), 30);

        let true_false = service
            .question_statistics(&fixture.session_id, &fixture.question_ids[0])
            .expect("true false statistics");
        assert_eq!(true_false.answered_count, 20);
        assert_eq!(true_false.correct_count, 15);
        assert_eq!(true_false.incorrect_count, 5);
        assert_eq!(true_false.choice_distribution[0].selection_count, 15);
        assert_eq!(true_false.choice_distribution[1].selection_count, 5);
        assert_eq!(true_false.choice_distribution[0].selection_rate, Some(0.75));

        let multiple_choice = service
            .question_statistics(&fixture.session_id, &fixture.question_ids[2])
            .expect("multiple choice statistics");
        assert_eq!(multiple_choice.choice_distribution[0].selection_count, 1);
        assert_eq!(multiple_choice.choice_distribution[1].selection_count, 2);
        assert_eq!(
            multiple_choice.choice_distribution[1].selection_rate,
            Some(1.0)
        );

        let essay = service
            .question_statistics(&fixture.session_id, &fixture.question_ids[1])
            .expect("essay statistics");
        assert_eq!(essay.answered_count, 3);
        assert_eq!(essay.pending_count, 3);
        assert_eq!(essay.correct_count, 0);
        assert_eq!(essay.accuracy, None);
        assert_eq!(essay.average_score, None);

        let fill_blank = service
            .question_statistics(&fixture.session_id, &fixture.question_ids[3])
            .expect("fill blank statistics");
        assert!(fill_blank.choice_distribution.is_empty());
        let participant = service
            .participant_statistics(&fixture.session_id, &fixture.participant_ids[0])
            .expect("participant statistics");
        assert_eq!(participant.eligible_question_count, 4);
        assert_eq!(participant.answered_count, 4);
        assert_eq!(participant.graded_count, 2);
        assert_eq!(participant.pending_count, 2);
        assert_eq!(participant.earned_score, 6);
        assert_eq!(participant.graded_possible_score, 6);
        let absent = service
            .participant_statistics(&fixture.session_id, &fixture.participant_ids[29])
            .expect("absent participant statistics");
        assert_eq!(absent.unanswered_count, 4);
        assert_eq!(absent.accuracy, None);

        let difficulty = service
            .difficult_questions(&fixture.session_id)
            .expect("difficulty");
        assert_eq!(difficulty.len(), 2);
        assert_eq!(difficulty[0].session_question_id, fixture.question_ids[2]);
        assert_eq!(difficulty[1].session_question_id, fixture.question_ids[0]);
        assert_eq!(
            service
                .session_statistics(&fixture.session_id)
                .expect("repeat"),
            session
        );
    }

    #[test]
    fn snapshot_statistics_ignore_source_edits_and_support_ended_sessions() {
        let fixture = fixture();
        let service = StatisticsService::initialize(fixture.database.clone());
        fixture
            .database
            .connection()
            .expect("connection")
            .execute(
                "UPDATE questions SET prompt='Changed source' WHERE id=?1",
                [&fixture.source_question_id],
            )
            .expect("source update");
        fixture
            .database
            .connection()
            .expect("connection")
            .execute(
                "DELETE FROM questions WHERE id=?1",
                [&fixture.source_question_id],
            )
            .expect("source delete");
        fixture
            .database
            .connection()
            .expect("connection")
            .execute(
                "UPDATE local_sessions SET state='ENDED' WHERE id=?1",
                [&fixture.session_id],
            )
            .expect("end session");
        let stats = service
            .question_statistics(&fixture.session_id, &fixture.question_ids[0])
            .expect("ended statistics");
        assert_eq!(stats.prompt, "True or false");
        assert_eq!(
            service
                .session_statistics(&fixture.session_id)
                .expect("ended session statistics")
                .session_state,
            "ENDED"
        );
        assert!(service
            .question_statistics(&fixture.session_id, &fixture.question_ids[4])
            .is_err());
    }

    #[test]
    fn lifecycle_states_remain_eligible_and_reopen_uses_new_revision() {
        let fixture = fixture();
        let service = StatisticsService::initialize(fixture.database.clone());
        fixture
            .database
            .connection()
            .expect("connection")
            .execute(
                "UPDATE session_questions SET state='LOCKED' WHERE id=?1",
                [&fixture.question_ids[0]],
            )
            .expect("lock question");
        assert_eq!(
            service
                .question_statistics(&fixture.session_id, &fixture.question_ids[0])
                .expect("locked statistics")
                .answered_count,
            20
        );
        fixture
            .database
            .connection()
            .expect("connection")
            .execute(
                "UPDATE session_questions SET state='OPEN' WHERE id=?1",
                [&fixture.question_ids[0]],
            )
            .expect("reopen question");
        insert_submission(
            &fixture.database,
            SubmissionInput {
                question_id: &fixture.question_ids[0],
                participant_id: &fixture.participant_ids[0],
                revision: 3,
                answer: serde_json::json!({"type":"true_false","value":false}),
                grading_status: "graded",
                is_correct: Some(false),
                score: Some(0),
                max_score: 2,
                submission_id: &id(999),
            },
        );
        let reopened = service
            .question_statistics(&fixture.session_id, &fixture.question_ids[0])
            .expect("reopened statistics");
        assert_eq!(reopened.correct_count, 14);
        assert_eq!(reopened.incorrect_count, 6);
    }

    #[test]
    fn single_choice_distribution_uses_snapshot_options() {
        let fixture = fixture();
        let question_id = id(305);
        fixture
            .database
            .connection()
            .expect("connection")
            .execute(
                "INSERT INTO session_questions(id,session_id,question_type,prompt,points,position,answer_config,grading_config,metadata,config_version,state,created_at,updated_at) VALUES(?1,?2,'single_choice','Single',1,5,'{\"options\":[{\"id\":\"a\",\"text\":\"A\"},{\"id\":\"b\",\"text\":\"B\"}],\"correctOptionId\":\"b\"}','{}','{}',1,'HIDDEN','now','now')",
                params![question_id, fixture.session_id],
            )
            .expect("single choice");
        let question = LiveQuizRepository::get_question(&fixture.database, &question_id)
            .expect("question")
            .expect("question exists");
        let submission = SubmissionRecord {
            id: id(306),
            session_question_id: question_id,
            participant_id: fixture.participant_ids[0].clone(),
            revision: 1,
            answer_json: serde_json::json!({"type":"single_choice","optionId":"b"}),
            grading_status: "graded".to_owned(),
            is_correct: Some(true),
            score: Some(1),
            max_score: 1,
            submitted_at: "now".to_owned(),
        };
        let distribution =
            super::choice_distribution(&question, &[&submission], 1).expect("distribution");
        assert_eq!(distribution[0].selection_count, 0);
        assert_eq!(distribution[1].selection_count, 1);
        assert_eq!(distribution[1].selection_rate, Some(1.0));
    }

    #[test]
    fn zero_participants_produce_null_rates_and_no_difficulty() {
        let directory = tempfile::tempdir().expect("directory");
        let database = Database::open(directory.path().join("classroom.sqlite3"));
        database.initialize().expect("database");
        let classroom = ClassroomRepository::create(
            &database,
            NewClassroom {
                name: "Empty".to_owned(),
                academic_year: None,
            },
        )
        .expect("classroom");
        let session_id = id(900);
        LocalSessionRepository::create(
            &database,
            NewLocalSession {
                id: session_id.clone(),
                classroom_id: classroom.id,
                server_instance_id: id(901),
                join_code: "EMPTY123".to_owned(),
            },
        )
        .expect("session");
        database
            .connection()
            .expect("connection")
            .execute(
                "UPDATE local_sessions SET state='ENDED' WHERE id=?1",
                [&session_id],
            )
            .expect("ended");
        database
            .connection()
            .expect("connection")
            .execute(
                "INSERT INTO session_questions(id,session_id,question_type,prompt,points,position,answer_config,grading_config,metadata,config_version,state,created_at,updated_at) VALUES(?1,?2,'true_false','Empty',1,0,'{\"correctAnswer\":true}','{}','{}',1,'REVEALED','now','now')",
                params![id(902), session_id],
            )
            .expect("question");
        let service = StatisticsService::initialize(database);
        let stats = service.session_statistics(&session_id).expect("statistics");
        assert_eq!(stats.total_opportunity_count, 0);
        assert_eq!(stats.response_rate, None);
        assert_eq!(stats.question_summaries[0].response_rate, None);
        assert!(service
            .difficult_questions(&session_id)
            .expect("difficulty")
            .is_empty());
    }
}
