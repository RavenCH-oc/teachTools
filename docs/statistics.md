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
