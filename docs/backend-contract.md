# SessionBackend 契約

## 責任與一致性

SessionBackend 代表課堂 session 的 command、query 與 realtime 行為。LocalBackend 以教師電腦的 Rust LAN server 與 SQLite 實作；SupabaseBackend 以受 RLS 保護的 Supabase runtime layer 實作。兩者必須回傳相同的 domain outcome、錯誤碼、idempotency 語意與 realtime event envelope，transport 實作差異不得洩漏至 React UI。

每個 backend 公開 capabilities。required capability 在所有正式 backend 都必須實作；optional capability 若未啟用，應在 session 建立前明確回報，而不是執行到一半失敗。

## Commands

| Command | 必要行為 |
| --- | --- |
| createSession | 建立 CREATED session 與 UUIDv7 identity |
| openLobby / updateSessionState | 驗證 Session state transition |
| publishQuestion / openQuestion / lockQuestion / revealQuestion | 驗證題目 runtime transition 並發送事件 |
| joinSession / reconnectParticipant | 建立或恢復具 session token 的 Participant |
| submitAnswer | 以 submission_id 進行 idempotent、權威評分的作答處理 |
| submitStudentQuestion / voteStudentQuestion | 驗證參與者與投票唯一性 |
| assignGroups | 建立或更新 session 分組與成員權限 |
| createPeerReviewAssignments / submitPeerReview | 保護指派唯一性、禁止未授權或自評濫用 |
| endSession / archiveSession | 停止互動並執行 archive boundary |

所有 command 都需要 actor context、request identity、validated DTO 與可安全顯示的 outcome。命令不可相信 client 傳來的 participant、score、correct、role 或已揭曉答案。

## Queries

getSession、getParticipant、listParticipants、getCurrentQuestion、getSubmissions、getStatistics、getStudentQuestions、getGroups、getPeerReviewState 必須依 actor 的授權範圍做資料最小化。學生不可讀取其他學生的 submission、尚未公開的正解或不屬於自己的 peer review。

## Realtime

subscribeToSessionEvents 回傳共用 domain event envelope：

    event_id
    event_type
    session_id
    entity_id
    occurred_at (UTC)
    revision 或 sequence
    payload

事件包括 participant_joined、participant_reconnected、participant_disconnected、session_state_changed、question_published、question_opened、question_locked、question_revealed、submission_received、statistics_updated、student_question_created、student_question_voted、group_updated、peer_review_assigned、peer_review_submitted。

Local mode 使用 WebSocket；cloud mode 使用 Supabase Realtime。訂閱端以 event_id 與 revision/sequence 去重並能在 reconnect 後 query 最新 snapshot。

## Submission idempotency

submission_id 為穩定、以瀏覽器 Web Crypto 產生的 client-generated UUID（支援 `randomUUID()`，並以 UUIDv4 `getRandomValues()` fallback）；第一次成功處理會持久化 request 的語意結果；相同 identity 與相同 payload 重送回傳原結果；相同 identity 搭配不同 payload 回傳 CONFLICT。任何 timeout、重連或重試都不得產生重複作答、重複評分或雙重統計。題目鎖定時的處理永遠基於 backend 的原子 state 檢查。

## Capabilities

required capabilities：session lifecycle、participant join/reconnect、question lifecycle、submission idempotency、authoritative grading、realtime events、archive。

optional capabilities：student questions/voting、groups、peer review、future custom question types。UI 必須依 capability flag 隱藏或停用不支援的工作流程。
# Phase 9 local live quiz transport

The authenticated local WebSocket protocol adds `session_sync`, `question_state_changed`, `question_revealed`, `submit_answer`, `submission_acknowledged`, and `submission_result`. `submit_answer` carries a UUID submission ID and typed answer only. The server performs replay lookup before rejecting a locked question, then creates immutable revisions transactionally for distinct IDs. Student public DTOs never contain answer config, grading config, other participants' answers, or scores.

Session media is served by an authenticated header-based route. The route also requires the owning `SessionQuestion` to be `OPEN`, `LOCKED`, or `REVEALED`; `HIDDEN` question assets are not downloadable. The URL contains only a session-asset ID; credential, participant ID, and filesystem path never appear in a URL or public DTO.

The shared local protocol supports `server_hello`, `ping`, `pong`, `participant_auth`, `participant_authenticated`, `session_state_changed`, and controlled errors. No question, answer, score, roster, or participant-list message is public. `participant_auth` sends the temporary credential only in the WebSocket message body. `AUTH_FAILED`, `SESSION_ENDED`, and `SERVER_INSTANCE_MISMATCH` are authoritative credential outcomes; `AUTH_TIMEOUT` is transient and must keep the stored credential eligible for reconnect.

After `participant_authenticated`, the Student client sends the existing typed `ping` message every 3 seconds and the server replies with `pong`. Each authenticated `ping` renews that connection's non-persistent presence lease. Teacher participant queries treat a participant as online only while at least one authenticated connection has been seen within 7 seconds; raw WebSocket counts do not define presence.
