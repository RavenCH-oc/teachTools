# Grouping foundation

Phase 11A建立分組的本機 persistence/application foundation；本階段沒有 Teacher UI、Student UI、Student HTTP/WebSocket grouping protocol、random grouping、preset apply、peer review 或 grouping statistics。

## Student 與 Participant

`Student` 是 Classroom 長期名冊身分。`Participant` 是單一 Session 的出席身分。GroupPreset 使用 Student membership；SessionGroupingDraft 與 immutable SessionGroupSet 只使用 Participant membership，不以 Student ID 作為 Session 分組的權威身份。

## Preset

既有 `group_presets` 保留作為 Classroom-scoped root，新增 normalized `group_preset_groups` 與 `group_preset_members`。既有 `group_presets.configuration` 是 legacy/reserved configuration 欄位；Phase 11A grouping 不讀取、不寫入，也不把它當作 membership source。新的 normalized tables 是 GroupPreset 結構與 membership 的唯一 authoritative source；其他 legacy 功能若使用 `configuration` 仍保留該欄位，不透過 grouping migration 清理。

Group name 會 trim、限制長度並在同一 preset 內保持唯一；position 在同一 preset 內唯一且 deterministic。Student 只能加入同 Classroom 的 preset，且同一 Student 在同一 preset 最多屬於一組。刪除 Student 會 cascade 移除 preset membership，但保留 preset 與其 groups；刪除 preset 會安全 cascade children。

## Session draft

`SessionGroupingDraft` 屬於單一 Session，狀態只有 `DRAFT`、`OPEN`、`FINALIZED`、`CANCELLED`。一個 Session 最多一個非終端 draft。Draft groups 有 name、position 與 optional capacity；未分組 participant 不建立虛擬 group。

只有 `LOBBY` 或 `ACTIVE` Session 能建立、開啟或修改 draft。`OPEN` draft 是未來 Teacher-controlled Student self-selection 的 persistence seam：Teacher 定義 groups/capacity，學生只能在既有 groups 間選擇或移動，不能建立、改名或刪除 group。容量與移動在 SQLite `BEGIN IMMEDIATE` transaction 中驗證；滿組時回傳 `GROUP_FULL`，原 membership 保持不變。

## Immutable GroupSet revisions

Teacher finalize draft 後建立 durable UUID 的 `SessionGroupSet`，revision 由 transaction 內的 `MAX(revision)+1` 決定，並受 `UNIQUE(session_id, revision)` 保護。每個 revision 的 groups、names、positions 與 participant membership 都是 snapshot；後續 draft 或 preset 變更不會修改舊 revision。capacity 是 draft-time policy，未寫入正式 GroupSet；clone current 時以 `NULL` capacity（unlimited）建立新 draft，Teacher 未來可在 draft 階段重新設定 capacity。current grouping 是該 Session 最高 finalized revision。Session End 後保留所有 GroupSet revisions；新加入的 late participant 不會改動既有 revision，而是維持未分組，Teacher 未來可由 current revision clone 新 draft。

## Session end and retention

Session End 與 stale-session recovery 在同一 database transaction 將 `DRAFT`/`OPEN` draft 設為 `CANCELLED`，不會自動 finalize。`FINALIZED` 與 `CANCELLED` draft metadata/children 目前保留，沒有 background cleanup；正式 GroupSet 永久保留供歷史、audit 與未來 Peer Review 以 `sessionGroupSetId` 引用。

## Future boundaries

Phase 11D 才會新增 Student self-selection transport。Student projection 只可顯示 group name、current count、capacity、Session display names 與自己的 group，不得暴露 Student metadata、credential、IP 或 connection ID。本階段不加入 grouping scoring、leaderboard、statistics 或 peer-review schema。
