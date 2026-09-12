//! XLSX rendering receives only the report model; it performs no database reads.
use super::session_report::{ExportSection, Report, ReportError};
use rust_xlsxwriter::{Format, Workbook, Worksheet, XlsxError};

enum Cell<'a> {
    Text(&'a str),
    Number(f64),
    Rate(Option<f64>),
    Optional(Option<f64>),
}
fn count(value: i64) -> Cell<'static> {
    Cell::Number(value as f64)
}
fn write_cell(
    sheet: &mut Worksheet,
    row: u32,
    column: u16,
    value: Cell<'_>,
) -> Result<(), XlsxError> {
    match value {
        Cell::Text(value) => {
            sheet.write_string(row, column, value)?;
        }
        Cell::Number(value) => {
            sheet.write_number(row, column, value)?;
        }
        Cell::Rate(Some(value)) => {
            sheet.write_number_with_format(
                row,
                column,
                value,
                &Format::new().set_num_format("0.00%"),
            )?;
        }
        Cell::Optional(Some(value)) => {
            sheet.write_number(row, column, value)?;
        }
        Cell::Rate(None) | Cell::Optional(None) => {
            sheet.write_string(row, column, "—")?;
        }
    }
    Ok(())
}
fn header<'a>(
    workbook: &'a mut Workbook,
    name: &str,
    labels: &[&str],
) -> Result<&'a mut Worksheet, XlsxError> {
    let sheet = workbook.add_worksheet();
    sheet.set_name(name)?;
    sheet.set_freeze_panes(1, 0)?;
    let bold = Format::new().set_bold();
    for (column, label) in labels.iter().enumerate() {
        sheet.write_string_with_format(0, column as u16, *label, &bold)?;
        sheet.set_column_width(column as u16, 18)?;
    }
    Ok(sheet)
}
fn row(sheet: &mut Worksheet, index: usize, cells: Vec<Cell<'_>>) -> Result<(), XlsxError> {
    let index = u32::try_from(index).map_err(|_| XlsxError::RowColumnLimitError)?;
    for (column, cell) in cells.into_iter().enumerate() {
        write_cell(sheet, index, column as u16, cell)?;
    }
    Ok(())
}
fn kind(value: &str) -> &str {
    match value {
        "true_false" => "是非題",
        "single_choice" => "單選題",
        "multiple_choice" => "複選題",
        "fill_blank" => "填空題",
        "essay" => "論述題",
        _ => value,
    }
}
fn timestamp(value: &str) -> String {
    value.replace('T', " ").replace('Z', " UTC")
}

pub(super) fn render(report: &Report, sections: &[ExportSection]) -> Result<Vec<u8>, ReportError> {
    render_workbook(report, sections).map_err(|_| ReportError::Generation)
}
fn render_workbook(report: &Report, sections: &[ExportSection]) -> Result<Vec<u8>, XlsxError> {
    let mut workbook = Workbook::new();
    let stats = &report.statistics;
    // Membership only: checkbox click order never changes worksheet order.
    if sections.contains(&ExportSection::SessionSummary) {
        let sheet = header(&mut workbook, "課堂摘要", &["欄位", "值"])?;
        sheet.set_column_width(0, 26)?;
        sheet.set_column_width(1, 42)?;
        let created = timestamp(&report.created_at);
        let lobby = report.lobby_opened_at.as_deref().map(timestamp);
        let ended = report.ended_at.as_deref().map(timestamp);
        let fields = vec![
            ("班級", Cell::Text(&report.classroom_name)),
            ("課堂狀態", Cell::Text("已結束")),
            ("建立時間（UTC）", Cell::Text(&created)),
            (
                "開放大廳時間（UTC）",
                Cell::Text(lobby.as_deref().unwrap_or("—")),
            ),
            (
                "結束時間（UTC）",
                Cell::Text(ended.as_deref().unwrap_or("—")),
            ),
            ("參與學生", count(stats.participant_count)),
            ("已發布題數", count(stats.published_question_count)),
            ("可作答題數", count(stats.eligible_question_count)),
            ("已作答機會", count(stats.answered_opportunity_count)),
            ("總作答機會", count(stats.total_opportunity_count)),
            ("整體作答率", Cell::Rate(stats.response_rate)),
            ("已評分作答", count(stats.graded_submission_count)),
            ("待評分作答", count(stats.pending_submission_count)),
            ("答對", count(stats.correct_count)),
            ("答錯", count(stats.incorrect_count)),
            ("答對率", Cell::Rate(stats.accuracy)),
            ("已評分得分", count(stats.earned_score_total)),
            ("已評分滿分", count(stats.graded_possible_score_total)),
            ("得分率", Cell::Rate(stats.score_rate)),
        ];
        for (index, (label, value)) in fields.into_iter().enumerate() {
            row(sheet, index + 1, vec![Cell::Text(label), value])?;
        }
    }
    if sections.contains(&ExportSection::QuestionStatistics) {
        let sheet = header(
            &mut workbook,
            "題目統計",
            &[
                "題號",
                "題目",
                "題型",
                "參與學生",
                "作答數",
                "未作答數",
                "作答率",
                "已評分",
                "待評分",
                "答對",
                "答錯",
                "答對率",
                "平均得分",
                "題目配分",
            ],
        )?;
        sheet.set_column_width(1, 60)?;
        sheet.set_column_format(1, &Format::new().set_text_wrap())?;
        for (index, q) in stats.question_summaries.iter().enumerate() {
            row(
                sheet,
                index + 1,
                vec![
                    Cell::Number(q.position as f64 + 1.0),
                    Cell::Text(&q.prompt),
                    Cell::Text(kind(&q.question_type)),
                    count(q.participant_count),
                    count(q.answered_count),
                    count(q.unanswered_count),
                    Cell::Rate(q.response_rate),
                    count(q.graded_count),
                    count(q.pending_count),
                    count(q.correct_count),
                    count(q.incorrect_count),
                    Cell::Rate(q.accuracy),
                    Cell::Optional(q.average_score),
                    count(q.max_points),
                ],
            )?;
        }
    }
    if sections.contains(&ExportSection::StudentStatistics) {
        let sheet = header(
            &mut workbook,
            "學生統計",
            &[
                "座號",
                "姓名",
                "可作答題數",
                "已作答",
                "未作答",
                "已評分",
                "待評分",
                "答對",
                "答錯",
                "已評分得分",
                "已評分滿分",
                "答對率",
                "得分率",
            ],
        )?;
        sheet.set_column_width(1, 24)?;
        for (index, p) in stats.participant_summaries.iter().enumerate() {
            row(
                sheet,
                index + 1,
                vec![
                    count(p.seat_number),
                    Cell::Text(&p.display_name),
                    count(p.eligible_question_count),
                    count(p.answered_count),
                    count(p.unanswered_count),
                    count(p.graded_count),
                    count(p.pending_count),
                    count(p.correct_count),
                    count(p.incorrect_count),
                    count(p.earned_score),
                    count(p.graded_possible_score),
                    Cell::Rate(p.accuracy),
                    Cell::Rate(p.score_rate),
                ],
            )?;
        }
    }
    workbook.save_to_buffer()
}
