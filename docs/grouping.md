# Grouping foundation

Phase 11A建立分組的本機 persistence/application foundation；Phase 11B、11C、11D 已依序補上 Teacher preset、Session grouping，以及 Student self-selection / delivery。Peer review、group statistics、group scoring、competition、export 與 cloud 同步仍未實作。

## Student 與 Participant

`Student` 是 Classroom 長期名冊身分。`Participant` 是單一 Session 的出席身分。GroupPreset 使用 Student membership；SessionGroupingDraft 與 immutable SessionGroupSet 只使用 Participant membership，不以 Student ID 作為 Session 分組的權威身份。

## Preset

既有 `group_presets` 保留作為 Classroom-scoped root，新增 normalized `group_preset_groups` 與 `group_preset_members`。既有 `group_presets.configuration` 是 legacy/reserved configuration 欄位；Phase 11A grouping 不讀取、不寫入，也不把它當作 membership source。新的 normalized tables 是 GroupPreset 結構與 membership 的唯一 authoritative source；其他 legacy 功能若使用 `configuration` 仍保留該欄位，不透過 grouping migration 清理。

Group name 會 trim、限制長度並在同一 preset 內保持唯一；position 在同一 preset 內唯一且 deterministic。Student 只能加入同 Classroom 的 preset，且同一 Student 在同一 preset 最多屬於一組。刪除 Student 會 cascade 移除 preset membership，但保留 preset 與其 groups；刪除 preset 會安全 cascade children。

Phase 11B 的 Teacher preset manager 以 Classroom ownership 查詢所有 preset。Teacher 在 frontend 使用 `PresetEditorDraft` 編輯名稱、groups、positions 與 Student assignments；按下儲存時由單一 transactional application operation 驗證並 replace normalized groups/memberships。既有 group ID 在未刪除時保留，新 group 只在成功 commit 時建立；刪除 group 會讓其 Student 回到未分組，不會刪除 Student。預設名稱與組別名稱使用 trim/NFKC normalized duplicate policy；同一 Classroom 不允許重複 preset name。Student list 依 `seat_number ASC`、name、ID deterministic 排序，新加入 Classroom 的 Student 不會自動加入任何 preset。

## Session draft

`SessionGroupingDraft` 屬於單一 Session，狀態只有 `DRAFT`、`OPEN`、`FINALIZED`、`CANCELLED`。一個 Session 最多一個非終端 draft。Draft groups 有 name、position 與 optional capacity；未分組 participant 不建立虛擬 group。

只有 `LOBBY` 或 `ACTIVE` Session 能建立、開啟或修改 draft。`OPEN` draft 是未來 Teacher-controlled Student self-selection 的 persistence seam：Teacher 定義 groups/capacity，學生只能在既有 groups 間選擇或移動，不能建立、改名或刪除 group。容量與移動在 SQLite `BEGIN IMMEDIATE` transaction 中驗證；滿組時回傳 `GROUP_FULL`，原 membership 保持不變。

## Immutable GroupSet revisions

Teacher finalize draft 後建立 durable UUID 的 `SessionGroupSet`，revision 由 transaction 內的 `MAX(revision)+1` 決定，並受 `UNIQUE(session_id, revision)` 保護。每個 revision 的 groups、names、positions 與 participant membership 都是 snapshot；後續 draft 或 preset 變更不會修改舊 revision。capacity 是 draft-time policy，未寫入正式 GroupSet；clone current 時以 `NULL` capacity（unlimited）建立新 draft，Teacher 未來可在 draft 階段重新設定 capacity。current grouping 是該 Session 最高 finalized revision。Session End 後保留所有 GroupSet revisions；新加入的 late participant 不會改動既有 revision，而是維持未分組，Teacher 未來可由 current revision clone 新 draft。

## Session end and retention

Session End 與 stale-session recovery 在同一 database transaction 將 `DRAFT`/`OPEN` draft 設為 `CANCELLED`，不會自動 finalize。`FINALIZED` 與 `CANCELLED` draft metadata/children 目前保留，沒有 background cleanup；正式 GroupSet 永久保留供歷史、audit 與未來 Peer Review 以 `sessionGroupSetId` 引用。

## Future boundaries

Phase 11D 才會新增 Student self-selection transport。Student projection 只可顯示 group name、current count、capacity、Session display names 與自己的 group，不得暴露 Student metadata、credential、IP 或 connection ID。本階段不加入 grouping scoring、leaderboard、statistics 或 peer-review schema。

## Phase 11C Teacher session grouping

Phase 11C 將 Teacher 分組編輯器接到既有 local session。Teacher 從 Lobby 或 Live Quiz 開啟「課堂分組」後，頁面永遠重新查詢 backend authoritative session、participants、current GroupSet 與 active draft；不依賴 Lobby component 的 local React state，也不會建立第二個 Session 或重新啟動 Local Server。

Session participant 與名冊 Student 的橋接只使用 `session_participants.student_id` 的 exact durable identity。Preset membership 以 `student_id` 查詢同一 Session 的 participant；缺席 Student 會被忽略，`student_id IS NULL` 或沒有對應 membership 的 participant 保持未分組。display name、seat number、模糊比對與 frontend assignment 均不是 identity fallback。跨 Classroom preset 會 fail closed。

Teacher command surface 為 `get_session_grouping`、`create_grouping_draft_from_preset`、`create_random_grouping_draft`、`create_manual_grouping_draft`、`clone_current_grouping_draft`、`update_session_grouping_draft`、`cancel_session_grouping_draft` 與 `finalize_session_grouping_draft`。Draft 編輯在一次 transaction 中保存 groups、順序、名稱、capacity 與 participant assignment；頁面可新增、改名、刪除、排序、分配、取消或套用。套用前的 current GroupSet 永不被草稿修改，finalize 產生下一個 immutable revision。Ended session 只讀；Lobby/Active session 才可變更。

Random source 使用作業系統 random bytes 產生 deterministic-independent shuffle key，僅用於平衡分組，不作 authentication 或 security token。新增或重新連線的 late participant 不會修改已 finalized revision，會在下一個 draft 中顯示為未分組。SQLite migration 0001–0005 維持不變；沒有新增 schema 或 application dependency。

## Phase 11D Student self-selection and delivery

Teacher 可將已完成結構與 capacity 的 `DRAFT` 開放為 `OPEN`。`OPEN` 沒有回到 `DRAFT` 的 transition：為避免 Teacher 的 stale bulk editor 覆蓋學生剛完成的選組，OPEN 時組別結構與 capacity 固定，Teacher 與 Student 都只透過 single-participant、`BEGIN IMMEDIATE` 的即時 move 操作變更 membership。Teacher 可 finalize 產生 immutable GroupSet revision，或 cancel 草稿；UI 將這兩種操作清楚表達為停止/結束自行選組的既有 state-model 行為。

Student 只可經既有 authenticated Participant WebSocket 發送 `select_group`。request 不帶 participant、student 或 session authority；server 從 authenticated connection 取得 Participant，驗證 draft/session ownership、OPEN state 與 target group，再使用既有 atomic capacity transaction。滿組會回 `GROUP_FULL`，move 到滿組失敗時原 membership 保持不變；重複選擇同一組為 idempotent，退出分組使用 `groupId: null`。

`session_sync` 會提供每位 authenticated Student 的安全 grouping projection。OPEN draft 可看到同一 Session 內所有可選 groups、member count、capacity 與 display names；finalized GroupSet 只會提供自己的 group 與同組 members。projection 不包含 credential、credential hash、IP、connection ID、Student permanent metadata 或其他 Session 資料。每次 OPEN membership 變更、finalize 或 cancel 都透過既有單一 ParticipantTransport 觸發每條連線重建自身 `session_sync` projection；Wi-Fi reconnect 也走既有 `participant_auth → session_sync`，不另建 grouping transport。

Late participant 不會修改既有 finalized GroupSet，初始為未分組；當 Teacher 開啟新的 OPEN draft 後，可與同 Session participant 一樣選擇 group。Session end 會取消 mutable draft，Student 不再收到或操作 self-selection UI。
