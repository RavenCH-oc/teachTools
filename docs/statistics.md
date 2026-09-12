# Phase 10A Statistics Semantics

Teacher statistics are read-only projections of the local SQLite session data. The query engine reads `local_sessions`, `session_participants`, `session_questions`, and `submissions` and does not maintain a cache or a materialized statistics table. The latest submission revision for each `(session_question_id, participant_id)` pair is selected with a SQL window function before aggregation.

## Eligibility and denominators

Only session questions in `OPEN`, `LOCKED`, or `REVEALED` state are eligible. `HIDDEN` questions are excluded from all answered, graded, pending, response-rate, score, difficulty, and opportunity totals. `publishedQuestionCount` remains the count of all session snapshots, including hidden snapshots, so a teacher can distinguish published snapshots from currently eligible questions.

The participant denominator is every row in `session_participants` for the session. Presence, heartbeat, and connection state are not used. Session opportunities are `participantCount × eligibleQuestionCount`; a zero denominator produces a JSON `null` rate.

`gradedCount` and `pendingCount` are mutually exclusive latest-submission counts. Essay submissions are answered and pending until authoritative grading is recorded; they are not counted as correct, incorrect, accurate, or average-score observations while pending. Accuracy is `correctCount / gradedCount`. Average score is the arithmetic mean of authoritative integer scores for graded submissions. Participant and session `scoreRate` values use earned score divided by the maximum points of graded submissions only.

## Choice distributions and difficulty

True/false, single-choice, and multiple-choice questions expose an option distribution. `selectionRate` uses `answeredCount` as its denominator. Multiple-choice rates intentionally may sum to more than 1 because one answer can select several options. Fill-blank and essay questions expose an empty distribution; free-text answers are never returned as analytics data.

Difficulty ranking includes only questions with at least one graded latest submission and sorts by ascending accuracy, then descending graded count, then question position and ID for deterministic output.

The Phase 10A contract is Teacher-only. No Student HTTP route, public DTO, WebSocket message, protocol version, or migration is changed. Future export/reporting is a separate requirement and is not implemented in this phase.

## Phase 10C session analysis

Teacher session history is a bounded, read-only query over persisted SQLite `local_sessions` rows. Only `ENDED` sessions in the selected classroom are returned, newest first by durable `ended_at`; history pages default to 30 records and never exceed 50. The history DTO contains classroom/session metadata and aggregate counts only, not join codes, credentials, connection details, filesystem paths, or submissions. No separate history persistence model or migration is used.

The Session Analysis page reuses the Phase 10A statistics queries and snapshot question records. An `ACTIVE` session refreshes with one completion-based request at a time every two seconds; an `ENDED` session is loaded once. While the current question is `OPEN`, participation metrics and question basics remain visible but detailed correctness, score, distribution, difficulty, and participant grading fields are hidden. `LOCKED`, `REVEALED`, and ended sessions may show the complete Teacher analysis. Essay answers remain pending until authoritative grading, and no ranking or export is provided.

## Phase 13C selective XLSX export

Only ENDED Sessions may be exported. The Teacher analysis page offers three optional sections, all selected by default: SESSION_SUMMARY, QUESTION_STATISTICS and STUDENT_STATISTICS. At least one unique known section is required. The workbook includes only selected sheets, always ordered 課堂摘要, 題目統計, 學生統計. Native Save As supplies the destination and overwrite confirmation; cancellation does not invoke the export command.

The validated `export_session_report` IPC accepts sessionId, sections and outputPath and returns filename only. Rust verifies identity, sections and an absolute XLSX destination (a missing extension is added). One connection/read transaction validates Session existence and ENDED state and reads all inputs through connection-taking repository helpers. The transaction ends before rendering/writing. A report uses the existing Phase 10 calculation functions, with latest submission revisions and unchanged pending/graded denominators.

Question labels/order come from SessionQuestion snapshots, and student labels/seats from session_participants, never current Question Bank or roster values. As in existing Session History, classroom name is read from classes; no historical classroom-name snapshot exists. Available times are created_at, lobby_opened_at and ended_at, explicitly labelled in UTC; no ACTIVE start timestamp is invented.

Summary exports classroom/state/times, participants, published/eligible questions, answered/total opportunities, response rate, graded/pending counts, correctness, accuracy, earned/graded-possible score and score rate. Question rows export position/prompt/type, participants, answered/unanswered/response rate, graded/pending/correct/incorrect, accuracy, average score and points. Participant rows export seat/name, eligible/answered/unanswered, graded/pending/correct/incorrect, earned/graded-possible score, accuracy and score rate. Null rates/averages display a dash. HIDDEN questions are excluded from question rows and grading/opportunity denominators, but included in published-question count.

The renderer writes literal strings and numeric values, with percentage number formats and no formulas. It exports no UUIDs, raw answers, Essay bodies, credentials, internal paths or Peer Review records. XLSX bytes must finish generating before the target is opened. Generation failure leaves an existing target untouched. Write failures return a safe error and never success; direct completed-buffer writing is not an atomic replacement guarantee if the filesystem fails during the write. No temporary report files or database migrations are introduced.
