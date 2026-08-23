# 資料模型

## 分類與所有權

領域模型分為持久課堂資料與 session runtime 資料。Classroom、Student、Course、Lesson、QuestionSet、Question、QuestionAsset、Rubric 與 Group preset 為 SQLite 長期資料。Session、SessionQuestion、Participant、Submission、Grade、StudentQuestion、StudentQuestionVote、Group、GroupMember、PeerReviewAssignment 與 PeerReview 在 session 期間是 backend runtime 資料；結束後按 archive policy 匯入 SQLite 歷史資料。

每個 aggregate 都要有明確 root 和 transaction boundary。Session 是 runtime aggregate root；QuestionSet 是教師題庫 aggregate root；Student 是名冊 aggregate root。Persistence DTO 不得直接等同 domain entity，transport DTO 也不得取代 domain model。

## 核心實體

| 模型 | 角色與關係 |
| --- | --- |
| Classroom | 教師管理的課堂設定與班級集合 |
| Student | 長期名冊身分；永久 UUID、座號、名稱 |
| Course / Lesson | 課程及教學單元 |
| QuestionSet / Question / QuestionAsset | 可重用題庫、題目與資產 |
| Session / SessionQuestion | 一次教學執行與其發佈題目快照 |
| Participant | session 範圍內的參與者，可選擇關聯 Student |
| Submission / Grade | 作答及權威評分結果 |
| StudentQuestion / StudentQuestionVote | 學生提問及投票 |
| Group / GroupMember | session runtime 分組 |
| PeerReviewAssignment / PeerReview | 同儕互評的指派及送出結果 |
| Rubric / RubricCriterion | 可重用評分規準 |

## Student 與 Participant

Student 是教師管理且可跨 session 重用的長期身分。Participant 是僅在一個 session 中出現的執行身分，具有 session_id、participant_id、optional student_id、display_name、seat_number 與 temporary credential。訪客、臨時學生或尚未確認名冊的學生都可只有 Participant。

固定教室加入流程為座號解析 known Student、顯示預期姓名、學生確認後建立 Participant。座號不是驗證憑證；credential 必須為不可預測、可撤銷且可過期的 session-scoped token。

## 題目模型

Question 在 TypeScript domain 中使用 discriminated union，而非以一串 type 加大量 optional 欄位表示。初始支援 true_false、single_choice、multiple_choice、fill_blank、essay；未來可加入 matching、ordering、audio、drawing、ai_assisted。

共用欄位為 id、type、prompt/content、assets、points、answer_config、grading_config、metadata、created_at、updated_at。結構化且需要查詢或完整性約束的資料使用關聯欄位；依題型變動的設定使用受驗證的 JSON configuration。SessionQuestion 必須保存發佈當下的題目快照，避免教師後續修改題庫影響已進行或已封存的 session。

## Identity、時間與完整性

所有 local、cloud、transport 的跨系統 ID 使用 UUIDv7。UUIDv7 可排序、可離線分散產生且與 PostgreSQL/SQLite 相容；資料庫 sequence 不可作為全域 identity。created_at、updated_at、occurred_at 與 archive timestamp 均以 UTC 儲存與序列化。

資料 schema 需以 foreign key、unique constraint、check constraint、index 與 transaction 表達 domain 規則。Question type、session state、question state、submission identity 和同儕互評唯一性均必須受資料庫與 application service 共同保護。

## Submission 與 Grade

Submission 有穩定 submission_id，作為 retry 與 idempotency 的鍵。學生端只送出答案，不可送出 authoritative score 或 correct 值；權威 backend 產生 Grade、score、correct 與統計。重送、取代答案、題目鎖定後的行為及衝突回應，由 SessionBackend contract 定義並由兩種 backend 一致實作。
# Phase 9 live quiz tables

`session_questions` stores a validated immutable source snapshot with a nullable traceability link to `questions`. `session_question_assets` owns copied managed media under the application data directory. `submissions` stores immutable answer revisions; its UUID primary key provides idempotency, and `(session_question_id, participant_id, revision)` provides ordered per-student history.

The database enforces a single active local session and a single `OPEN`/`LOCKED` session question through partial unique indexes. Correct answer and grading snapshot columns are teacher/backend-only and are never projected into Student public views.
