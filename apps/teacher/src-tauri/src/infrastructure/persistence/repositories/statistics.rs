use crate::error::AppError;
use crate::infrastructure::persistence::database::Database;

use super::{live_quiz::SessionQuestionRecord, local_session::LocalSessionRepository};
use super::{live_quiz::SubmissionRecord, local_session::ParticipantRecord};

/// The complete read-only input used by the statistics application service.
///
/// The submission query deliberately uses a window function so every
/// participant/question pair contributes at most its latest accepted revision.
#[derive(Debug)]
pub struct StatisticsSnapshot {
    pub session_id: String,
    pub session_state: String,
    pub participants: Vec<ParticipantRecord>,
    pub questions: Vec<SessionQuestionRecord>,
    pub latest_submissions: Vec<SubmissionRecord>,
}

pub struct StatisticsRepository;

impl StatisticsRepository {
    pub fn snapshot(database: &Database, session_id: &str) -> Result<StatisticsSnapshot, AppError> {
        let session = LocalSessionRepository::get_by_id(database, session_id)?
            .ok_or_else(|| AppError::NotFound("local session".to_owned()))?;
        let participants = LocalSessionRepository::list_participants(database, session_id)?;
        let questions = super::live_quiz::LiveQuizRepository::list_questions(database, session_id)?;
        let latest_submissions = list_latest_submissions(database, session_id)?;

        Ok(StatisticsSnapshot {
            session_id: session.id,
            session_state: session.state,
            participants,
            questions,
            latest_submissions,
        })
    }
}

fn list_latest_submissions(
    database: &Database,
    session_id: &str,
) -> Result<Vec<SubmissionRecord>, AppError> {
    let connection = database.connection()?;
    latest_submissions_on(&connection, session_id)
}

pub(super) fn latest_submissions_on(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> Result<Vec<SubmissionRecord>, AppError> {
    let mut statement = connection.prepare(
        "WITH ranked AS (
            SELECT s.id, s.session_question_id, s.participant_id, s.revision,
                   s.answer_json, s.grading_status, s.is_correct, s.score,
                   s.max_score, s.submitted_at,
                   ROW_NUMBER() OVER (
                       PARTITION BY s.session_question_id, s.participant_id
                       ORDER BY s.revision DESC
                   ) AS revision_rank
            FROM submissions s
            JOIN session_questions q ON q.id = s.session_question_id
            JOIN session_participants p
              ON p.id = s.participant_id
             AND p.session_id = q.session_id
            WHERE q.session_id = ?1
              AND q.state IN ('OPEN', 'LOCKED', 'REVEALED')
        )
        SELECT id, session_question_id, participant_id, revision, answer_json,
               grading_status, is_correct, score, max_score, submitted_at
        FROM ranked
        WHERE revision_rank = 1
        ORDER BY session_question_id, participant_id",
    )?;
    let rows = statement
        .query_map([session_id], submission_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn submission_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SubmissionRecord> {
    Ok(SubmissionRecord {
        id: row.get(0)?,
        session_question_id: row.get(1)?,
        participant_id: row.get(2)?,
        revision: row.get(3)?,
        answer_json: serde_json::from_str(&row.get::<_, String>(4)?).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                4,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        grading_status: row.get(5)?,
        is_correct: row.get::<_, Option<i64>>(6)?.map(|value| value != 0),
        score: row.get(7)?,
        max_score: row.get(8)?,
        submitted_at: row.get(9)?,
    })
}

#[cfg(test)]
mod tests {
    use super::StatisticsRepository;
    use crate::infrastructure::persistence::database::Database;
    use crate::infrastructure::persistence::repositories::local_session::NewLocalSession;
    use crate::infrastructure::persistence::repositories::{
        ClassroomRepository, NewClassroom, NewQuestion, NewQuestionSet, NewStudent,
        QuestionRepository, QuestionSetRepository, StudentRepository,
    };

    #[test]
    fn snapshot_uses_latest_revision_and_excludes_hidden_questions() {
        let directory = tempfile::tempdir().expect("directory");
        let database = Database::open(directory.path().join("classroom.sqlite3"));
        database.initialize().expect("database");
        let classroom = ClassroomRepository::create(
            &database,
            NewClassroom {
                name: "Class".to_owned(),
                academic_year: None,
            },
        )
        .expect("classroom");
        let student = StudentRepository::create(
            &database,
            NewStudent {
                class_id: classroom.id.clone(),
                seat_number: 1,
                name: "Ada".to_owned(),
            },
        )
        .expect("student");
        let session = NewLocalSession {
            id: "01900000-0000-7000-8000-000000000001".to_owned(),
            classroom_id: classroom.id,
            server_instance_id: "01900000-0000-7000-8000-000000000002".to_owned(),
            join_code: "ABC12345".to_owned(),
        };
        let session =
            super::super::local_session::LocalSessionRepository::create(&database, session)
                .expect("session");
        let set = QuestionSetRepository::create(
            &database,
            NewQuestionSet {
                lesson_id: None,
                title: "Set".to_owned(),
                description: None,
            },
        )
        .expect("set");
        let source = QuestionRepository::create(
            &database,
            NewQuestion {
                question_set_id: set.id,
                question_type: "true_false".to_owned(),
                prompt: "Prompt".to_owned(),
                points: 2,
                position: 0,
                answer_config: serde_json::json!({"correctAnswer": true}),
                grading_config: serde_json::json!({}),
                metadata: serde_json::json!({}),
            },
        )
        .expect("source");
        database
            .connection()
            .expect("connection")
            .execute(
                "UPDATE local_sessions SET state='ACTIVE' WHERE id=?1",
                [&session.id],
            )
            .expect("activate");
        database
            .connection()
            .expect("connection")
            .execute(
                "INSERT INTO session_participants(id,session_id,student_id,seat_number,display_name,credential_hash,joined_at,updated_at) VALUES(?1,?2,?3,1,'Ada','hash','now','now')",
                rusqlite::params!["01900000-0000-7000-8000-000000000003", session.id, student.id],
            )
            .expect("participant");
        database
            .connection()
            .expect("connection")
            .execute(
                "INSERT INTO session_questions(id,session_id,source_question_id,question_type,prompt,points,position,answer_config,grading_config,metadata,config_version,state,created_at,updated_at) VALUES(?1,?2,?3,'true_false','Prompt',2,0,'{\"correctAnswer\":true}','{}','{}',1,'OPEN','now','now')",
                rusqlite::params!["01900000-0000-7000-8000-000000000004", session.id, source.id],
            )
            .expect("question");
        database
            .connection()
            .expect("connection")
            .execute(
                "INSERT INTO session_questions(id,session_id,source_question_id,question_type,prompt,points,position,answer_config,grading_config,metadata,config_version,state,created_at,updated_at) VALUES(?1,?2,?3,'true_false','Hidden',2,1,'{\"correctAnswer\":true}','{}','{}',1,'HIDDEN','now','now')",
                rusqlite::params!["01900000-0000-7000-8000-000000000005", session.id, source.id],
            )
            .expect("hidden question");
        database
            .connection()
            .expect("connection")
            .execute(
                "INSERT INTO submissions(id,session_question_id,participant_id,revision,answer_json,grading_status,is_correct,score,max_score,submitted_at) VALUES('01900000-0000-7000-8000-000000000006','01900000-0000-7000-8000-000000000004','01900000-0000-7000-8000-000000000003',1,'{\"type\":\"true_false\",\"value\":false}','graded',0,0,2,'now'),('01900000-0000-7000-8000-000000000007','01900000-0000-7000-8000-000000000004','01900000-0000-7000-8000-000000000003',2,'{\"type\":\"true_false\",\"value\":true}','graded',1,2,2,'now')",
                [],
            )
            .expect("submissions");

        let snapshot = StatisticsRepository::snapshot(&database, &session.id).expect("snapshot");
        assert_eq!(snapshot.questions.len(), 2);
        assert_eq!(snapshot.latest_submissions.len(), 1);
        assert_eq!(snapshot.latest_submissions[0].revision, 2);
    }
}
