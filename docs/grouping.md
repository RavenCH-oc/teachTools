# Grouping foundation

Phase 11A建立分組的本機 persistence/application foundation；Phase 11B、11C、11D 已依序補上 Teacher preset、Session grouping，以及 Student self-selection / delivery；Phase 11E 完成跨功能整合與 lifecycle closeout。Peer review、group statistics、group scoring、competition、export 與 cloud 同步仍未實作。

## Student 與 Participant

`Student` 是 Classroom 長期名冊身分。`Participant` 是單一 Session 的出席身分。GroupPreset 使用 Student membership；SessionGroupingDraft 與 immutable SessionGroupSet 只使用 Participant membership，不以 Student ID 作為 Session 分組的權威身份。

## Preset

既有 `group_presets` 保留作為 Classroom-scoped root，新增 normalized `group_preset_groups` 與 `group_preset_members`。既有 `group_presets.configuration` 是 legacy/reserved configuration 欄位；Phase 11A grouping 不讀取、不寫入，也不把它當作 membership source。新的 normalized tables 是 GroupPreset 結構與 membership 的唯一 authoritative source；其他 legacy 功能若使用 `configuration` 仍保留該欄位，不透過 grouping migration 清理。

Group name 會 trim、限制長度並在同一 preset 內保持唯一；position 在同一 preset 內唯一且 deterministic。Student 只能加入同 Classroom 的 preset，且同一 Student 在同一 preset 最多屬於一組。刪除 Student 會 cascade 移除 preset membership，但保留 preset 與其 groups；刪除 preset 會安全 cascade children。

Phase 11B 的 Teacher preset manager 以 Classroom ownership 查詢所有 preset。Teacher 在 frontend 使用 `PresetEditorDraft` 編輯名稱、groups、positions 與 Student assignments；按下儲存時由單一 transactional application operation 驗證並 replace normalized groups/memberships。既有 group ID 在未刪除時保留，新 group 只在成功 commit 時建立；刪除 group 會讓其 Student 回到未分組，不會刪除 Student。預設名稱與組別名稱使用 trim/NFKC normalized duplicate policy；同一 Classroom 不允許重複 preset name。Student list 依 `seat_number ASC`、name、ID deterministic 排序，新加入 Classroom 的 Student 不會自動加入任何 preset。

## Session draft

`SessionGroupingDraft` 屬於單一 Session，狀態只有 `DRAFT`、`OPEN`、`FINALIZED`、`CANCELLED`。一個 Session 最多一個非終端 draft。Draft groups 有 name、position 與 optional capacity；未分組 participant 不建立虛擬 group。

只有 `LOBBY` 或 `ACTIVE` Session 能建立、開啟或修改 draft。`OPEN` draft 支援 Teacher-controlled Student self-selection：Teacher 定義 groups/capacity，學生只能在既有 groups 間選擇或移動，不能建立、改名或刪除 group。容量與移動在 SQLite `BEGIN IMMEDIATE` transaction 中驗證；滿組時回傳 `GROUP_FULL`，原 membership 保持不變。

## Immutable GroupSet revisions

Teacher finalize draft 後建立 durable UUID 的 `SessionGroupSet`，revision 由 transaction 內的 `MAX(revision)+1` 決定，並受 `UNIQUE(session_id, revision)` 保護。每個 revision 的 groups、names、positions 與 participant membership 都是 snapshot；後續 draft 或 preset 變更不會修改舊 revision。capacity 是 draft-time policy，未寫入正式 GroupSet；clone current 時以 `NULL` capacity（unlimited）建立新 draft，Teacher 可在 draft 階段重新設定 capacity。current grouping 是該 Session 最高 finalized revision。Session End 後保留所有 GroupSet revisions；新加入的 late participant 不會改動既有 revision，而是維持未分組，Teacher 可由 current revision clone 新 draft。

## Session end and retention

Session End 與 stale-session recovery 在同一 database transaction 將 `DRAFT`/`OPEN` draft 設為 `CANCELLED`，不會自動 finalize。`FINALIZED` 與 `CANCELLED` draft metadata/children 目前保留，沒有 background cleanup；正式 GroupSet 永久保留供歷史、audit 與未來 Peer Review 以 `sessionGroupSetId` 引用。

## Future boundaries

Student projection 只可顯示 group name、current count、capacity、Session display names 與自己的 group，不得暴露 Student metadata、credential、IP、connection ID、score 或 answer。Grouping 不承擔 presence、quiz 或 statistics authority。本階段不加入 grouping scoring、leaderboard、statistics 或 peer-review schema；未來 Peer Review 可用 durable `sessionGroupSetId` 明確引用當時的 immutable revision，不需回查可變 preset 或 draft。

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

## Phase 11E integration closeout

Preset 對 Session grouping 只有 creation-source 關係。Draft 建立後，preset 的 rename、reorder、membership change 或 delete 都不會回寫該 draft，也不會修改任何 finalized GroupSet revision。Roster Student 刪除會移除 preset membership；若該 Student 已有 historical Participant，`session_participants.student_id` 依既有 FK 語意變為 `NULL`，但 Participant display snapshot 與以 `participant_id` 保存的 GroupSet membership 不變。

Preset、random 與 manual 三種來源最後都進入同一 `SessionGroupingDraft` lifecycle。Random 僅保證組間人數差不超過一，不保證順序；manual 起始時所有 Participant 都在 editable unassigned pool。OPEN 後 Teacher 與 Student move 使用相同的 capacity policy 與 atomic single-participant transaction，Teacher 沒有繞過 capacity 的隱性權限。兩方同時 move 同一 Participant 時，SQLite 依 transaction 順序序列化；最後狀態可以是任一成功操作的結果，但資料庫唯一約束確保不會出現 duplicate 或 half move。

Presence 不是 grouping authority。Participant offline 不會被移除或 unassign；reconnect 仍由既有 authenticated ParticipantTransport 取得當下 `session_sync`。DRAFT 不提供自行選組，OPEN 提供必要的 current draft projection，FINALIZED 只提供自己的正式組別，CANCELLED 不提供可選狀態（若已有正式 revision，則回退顯示 current finalized group）。Late participant 不會加入舊 revision；clone current 後會出現在未分組 pool，下一個 OPEN draft 可選組並由後續 revision 納入。

Session End 與 stale restart recovery 都只會取消尚可變的 DRAFT/OPEN，不會自動產生 revision；既有正式 GroupSet 永久保留。Teacher 的 Live Quiz、Session Grouping 與 Session Analysis 頁面各自擁有並在 unmount 清理 polling；切頁不停止 Local Server、不建立第二個 Session，也不讓 grouping sync 重置 Student 的 question answer、pending submission、heartbeat、media 或 reconnect generation。

Phase 11 UI policy 是 functional integration first；純外觀、animation 與 drag/drop polish 延後處理。

### Phase 11E-H1 reconnect restoration

Authenticated `LOBBY` 與 `ACTIVE` 連線都必須收到 authoritative `session_sync`，不依賴 Teacher 再次操作。Initial authentication、grouping event 與 quiz event 共用 `student_sync`，從 persisted Session 讀取實際 state，不將大廳硬編碼為 ACTIVE。Student 大廳與進行中課堂沿用相同 grouping UI。

Projection precedence 維持 `OPEN draft > current finalized GroupSet > none`。尚未 OPEN 的下一版 DRAFT 不會遮住 current finalized group；cancel OPEN 會恢復 current finalized projection；未分配的正式 Participant 仍收到 `groupingMode: finalized` 與 `currentGroup: null`。每次 sync 都替換 frontend grouping state，null/absent 表示清除；舊 socket generation 仍由既有 ParticipantTransport 拒絕，沒有額外 grouping cache 或 reconnect 機制。

### Final closeout evidence

H1 診斷狀態為 `CONFIRMED_LOBBY_SYNC_DEFECT`：舊版 LOBBY participant authentication 沒有 initial `session_sync`，grouping live event 卻硬編碼 Session state 為 ACTIVE，Student grouping 也只在 live state rendering。這條 path 可造成 finalize live delivery 正常、refresh 恢復 authoritative LOBBY 後 grouping UI 消失；formal GroupSet 並未因此遺失。ACTIVE finalized reconnect 在舊版已有 coverage 並可正常。第一次真人 QA 的 authoritative Session state 未保存，標記為 `NOT_RECONSTRUCTED`，不宣稱已百分之百重建原始 QA 根因。

本次 closeout 由使用者確認：Phase 11E Human QA、Phase 11E-H1 Human QA 與 Functional UI QA 均為 PASS；QA1–QA10 全部 PASS。H1 targeted retest 包含 finalized refresh、Wi-Fi reconnect、DRAFT 不遮蔽 finalized、OPEN self-selection refresh、新 revision finalize 後 refresh，以及 hotfix 後 QA6–QA10 regression，全部 PASS。紀錄為 `HUMAN_QA_RECONNECT_RESTORATION_PASS`，原使用者可見問題為 `RESOLVED`；這是使用者提供的真人驗收，不以 automated tests 冒充。

LOBBY／ACTIVE auth 後的 sync 共用安全 projection；ENDED、auth failure 與 credential lifecycle 仍沿用既有 contract。`LOCAL_PROTOCOL_VERSION` 維持 1：Student bundle/server 同 build 部署，grouping 是 optional extension，既有 required shape 未破壞，TS/Rust parser 與 fixtures 保持 parity；H1 沒有新增 message shape。

Phase 11A–11E 與 H1 的功能範圍已完成。Grouping foundation 已具備供下一階段 Peer Review 引用 immutable `sessionGroupSetId` 的條件，但 Peer Review 本身尚未實作，cosmetic UI polish 仍延後。歷史 QuestionBank async timing／Presence timing 偶發觀察保留追蹤；只有本次標準 final gates 通過後，才可將其歸類為 `NON_BLOCKING_FLAKY_OBSERVATIONS`。

Final concurrency review 補強 OPEN structure lock：bulk draft save 除了 application precheck，也必須在 `BEGIN IMMEDIATE` transaction 內重新確認仍為 DRAFT，避免 precheck 後 OPEN／Student move 已 commit，舊 bulk save 卻覆蓋 live selection。Deterministic stale-save regression 驗證拒絕時 groups、capacity、membership 與 timestamps 全部不變；OPEN 仍只允許既有 atomic single-participant moves 與 lifecycle control。

Final automated verification：pnpm typecheck/test/build/lint PASS（144 tests），cargo fmt/check/test/clippy PASS（71 tests，標準 parallel）。QuestionBank async timing 在首輪完整 suite 再次出現一次；一次 focused 診斷與後續一次標準完整 suite 通過，沒有改題庫或無限 retry。Presence 本輪通過；上述歷史觀察分類為 `NON_BLOCKING_FLAKY_OBSERVATIONS`。Tauri smoke 確認 Student dist 重建、Vite/Cargo、Teacher 視窗與正常關閉，沒有 startup panic／EBUSY；逐頁功能證據來自既有 frontend tests 與使用者確認的 Functional UI QA，不宣稱本次 automation 逐頁操作了 native WebView。
