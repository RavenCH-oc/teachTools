use super::*;
use std::io::{Cursor, Read};

const SESSION: &str = "01900000-0000-7000-8000-000000000001";
fn fixture() -> (tempfile::TempDir, Database) {
    let directory = tempfile::tempdir().expect("temporary report fixture");
    let database = Database::open(directory.path().join("classroom.sqlite3"));
    database.initialize().expect("initialize");
    database.connection().expect("connection").execute_batch(&format!(r#"
        INSERT INTO classes VALUES('class','=1+1',NULL,'2026-09-12T00:00:00Z','2026-09-12T00:00:00Z');
        INSERT INTO students VALUES('student','class',1,'Current student','now','now');
        INSERT INTO local_sessions(id,classroom_id,server_instance_id,state,join_mode,join_code,created_at,ended_at,updated_at)
        VALUES('{SESSION}','class','server','ENDED','roster_match','SECRET-JOIN','2026-09-12T00:00:00Z','2026-09-12T01:00:00Z','now');
        INSERT INTO session_participants(id,session_id,student_id,seat_number,display_name,credential_hash,joined_at,updated_at)
        VALUES('participant','{SESSION}','student',1,'+Historical student','SECRET-CREDENTIAL','now','now');
        INSERT INTO question_sets(id,title,created_at,updated_at) VALUES('set','set','now','now');
        INSERT INTO questions(id,question_set_id,type,prompt,points,answer_config,created_at,updated_at)
        VALUES('source','set','true_false','Current source',4,'{{"correctAnswer":true}}','now','now');
        INSERT INTO session_questions(id,session_id,source_question_id,question_type,prompt,points,position,answer_config,grading_config,metadata,config_version,state,created_at,updated_at)
        VALUES('question','{SESSION}','source','true_false','@Historical question',4,0,'{{"correctAnswer":true}}','{{}}','{{}}',1,'REVEALED','now','now');
        INSERT INTO session_questions(id,session_id,question_type,prompt,points,position,answer_config,grading_config,metadata,config_version,state,created_at,updated_at)
        VALUES('essay','{SESSION}','essay','Essay prompt',8,1,'{{}}','{{}}','{{}}',1,'REVEALED','now','now'),
              ('hidden','{SESSION}','essay','Hidden prompt',8,2,'{{}}','{{}}','{{}}',1,'HIDDEN','now','now');
        INSERT INTO submissions VALUES('submission-old','question','participant',1,'{{"type":"true_false","value":false}}','graded',0,0,4,'now'),
              ('submission-new','question','participant',2,'{{"type":"true_false","value":true}}','graded',1,4,4,'now'),
              ('essay-submission','essay','participant',1,'{{"type":"essay","text":"SECRET-ESSAY"}}','pending',NULL,NULL,8,'now');
    "#)).expect("fixture data");
    (directory, database)
}
fn request(path: &Path, sections: Vec<ExportSection>) -> ExportRequest {
    ExportRequest {
        session_id: SESSION.to_owned(),
        sections,
        output_path: path.to_string_lossy().into_owned(),
    }
}
fn xml(bytes: &[u8], name: &str) -> String {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("valid XLSX ZIP");
    let mut text = String::new();
    zip.by_name(name)
        .expect("ZIP entry")
        .read_to_string(&mut text)
        .expect("XML");
    text
}
#[test]
fn session_report_enforces_state_and_validates_request_before_output() {
    let (directory, database) = fixture();
    let service = SessionReportService::initialize(database.clone());
    let path = directory.path().join("report.xlsx");
    for state in ["CREATED", "LOBBY", "ACTIVE"] {
        database
            .connection()
            .expect("connection")
            .execute("UPDATE local_sessions SET state=?1", [state])
            .expect("state");
        assert_eq!(
            service
                .export(request(&path, vec![ExportSection::SessionSummary]))
                .unwrap_err(),
            ReportError::SessionNotEnded
        );
        assert!(!path.exists());
    }
    database
        .connection()
        .expect("connection")
        .execute("UPDATE local_sessions SET state='ENDED'", [])
        .expect("end");
    for sections in [
        vec![],
        vec![ExportSection::SessionSummary, ExportSection::SessionSummary],
    ] {
        assert_eq!(
            service.export(request(&path, sections)).unwrap_err(),
            ReportError::InvalidSections
        );
    }
    let mut invalid = request(&path, vec![ExportSection::SessionSummary]);
    invalid.session_id = "invalid".into();
    assert_eq!(
        service.export(invalid).unwrap_err(),
        ReportError::InvalidSessionId
    );
    let mut missing = request(&path, vec![ExportSection::SessionSummary]);
    missing.session_id = "01900000-0000-7000-8000-000000000099".into();
    assert_eq!(
        service.export(missing).unwrap_err(),
        ReportError::SessionNotFound
    );
    assert!(serde_json::from_str::<ExportRequest>(
        r#"{"sessionId":"x","sections":["UNKNOWN"],"outputPath":"x.xlsx"}"#
    )
    .is_err());
}
#[test]
fn session_report_selected_sheets_have_fixed_order_and_literal_numeric_cells() {
    let (directory, database) = fixture();
    let service = SessionReportService::initialize(database);
    let path = directory.path().join("report.xlsx");
    let options = [
        ExportSection::SessionSummary,
        ExportSection::QuestionStatistics,
        ExportSection::StudentStatistics,
    ];
    let names = ["課堂摘要", "題目統計", "學生統計"];
    for mask in 1..8 {
        let selected = (0..3)
            .rev()
            .filter(|i| mask & (1 << i) != 0)
            .map(|i| options[i])
            .collect();
        service
            .export(request(&path, selected))
            .expect("export ended");
        let bytes = std::fs::read(&path).expect("read");
        assert!(!bytes.is_empty());
        let workbook = xml(&bytes, "xl/workbook.xml");
        let expected = (0..3).filter(|i| mask & (1 << i) != 0).collect::<Vec<_>>();
        assert_eq!(workbook.matches("<sheet ").count(), expected.len());
        let mut last = 0;
        for i in expected {
            let position = workbook.find(names[i]).expect("selected worksheet");
            assert!(position > last);
            last = position;
        }
    }
    let bytes = std::fs::read(&path).expect("read");
    let strings = xml(&bytes, "xl/sharedStrings.xml");
    for text in ["=1+1", "+Historical student", "@Historical question"] {
        assert!(strings.contains(text));
    }
    for secret in [
        "SECRET-JOIN",
        "SECRET-CREDENTIAL",
        "SECRET-ESSAY",
        "Current source",
        "Current student",
        SESSION,
        "Hidden prompt",
    ] {
        assert!(!strings.contains(secret));
    }
    for index in 1..=3 {
        let sheet = xml(&bytes, &format!("xl/worksheets/sheet{index}.xml"));
        assert!(!sheet.contains("<f>"));
        assert!(sheet.contains("state=\"frozen\""));
        assert!(sheet.contains("<v>1</v>"));
    }
    assert!(xml(&bytes, "xl/styles.xml").contains("0.00%"));
    assert!(
        xml(&bytes, "xl/worksheets/sheet2.xml").contains("wrapText=\"1\"")
            || xml(&bytes, "xl/styles.xml").contains("wrapText=\"1\"")
    );
}
#[test]
fn session_report_reuses_latest_revision_pending_and_historical_semantics() {
    let (_directory, database) = fixture();
    database.connection().expect("connection").execute_batch("UPDATE questions SET prompt='Changed source',position=8; UPDATE students SET name='Renamed roster',seat_number=9;").expect("source edits");
    let snapshot = session_report::read(&database, SESSION).expect("snapshot");
    let report = statistics_from_snapshot(&snapshot.statistics).expect("statistics");
    let existing = super::super::statistics::StatisticsService::initialize(database)
        .session_statistics(SESSION)
        .expect("existing statistics");
    assert_eq!(report, existing);
    assert_eq!(report.published_question_count, 3);
    assert_eq!(report.eligible_question_count, 2);
    assert_eq!(report.graded_submission_count, 1);
    assert_eq!(report.pending_submission_count, 1);
    assert_eq!(report.earned_score_total, 4);
    assert_eq!(report.graded_possible_score_total, 4);
    assert_eq!(report.score_rate, Some(1.0));
    assert_eq!(report.question_summaries[0].prompt, "@Historical question");
    assert_eq!(report.question_summaries[0].position, 0);
    assert_eq!(report.question_summaries[1].average_score, None);
    assert_eq!(
        report.participant_summaries[0].display_name,
        "+Historical student"
    );
    assert_eq!(report.participant_summaries[0].seat_number, 1);
}
#[test]
fn session_report_output_validation_cancellation_free_write_errors_and_generation_safety() {
    let (directory, database) = fixture();
    let service = SessionReportService::initialize(database.clone());
    for name in ["report.exe", "report.txt"] {
        assert_eq!(
            service
                .export(request(
                    &directory.path().join(name),
                    vec![ExportSection::SessionSummary]
                ))
                .unwrap_err(),
            ReportError::InvalidOutputPath
        );
    }
    let no_extension = directory.path().join("report");
    let result = service
        .export(request(&no_extension, vec![ExportSection::SessionSummary]))
        .expect("extension");
    assert_eq!(result.filename, "report.xlsx");
    assert!(!no_extension.exists());
    assert!(directory.path().join("report.xlsx").exists());
    let missing_parent = directory.path().join("missing").join("report.xlsx");
    assert_eq!(
        service
            .export(request(
                &missing_parent,
                vec![ExportSection::SessionSummary]
            ))
            .unwrap_err(),
        ReportError::Write
    );
    let path = directory.path().join("existing.xlsx");
    std::fs::write(&path, b"original").expect("existing file");
    database
        .connection()
        .expect("connection")
        .execute("UPDATE classes SET name=?1", ["x".repeat(40_000)])
        .expect("unrenderable string");
    assert_eq!(
        service
            .export(request(&path, vec![ExportSection::SessionSummary]))
            .unwrap_err(),
        ReportError::Generation
    );
    assert_eq!(std::fs::read(&path).expect("unchanged"), b"original");
}
