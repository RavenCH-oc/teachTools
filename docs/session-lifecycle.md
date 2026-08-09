# Session 與題目生命週期

## Session 狀態

    CREATED → LOBBY → ACTIVE → PAUSED → ACTIVE → ENDED → ARCHIVED

Session state 為 CREATED、LOBBY、ACTIVE、PAUSED、ENDED、ARCHIVED。有效轉換如下：

| 目前狀態 | 允許轉換 |
| --- | --- |
| CREATED | LOBBY、ENDED |
| LOBBY | ACTIVE、ENDED |
| ACTIVE | PAUSED、ENDED |
| PAUSED | ACTIVE、ENDED |
| ENDED | ARCHIVED |
| ARCHIVED | 無 |

ARCHIVED 不可轉回 ACTIVE。若教師需要重新開課，系統提供明確的 restore 或 clone 語意，而不是回寫舊 session：restore 只能恢復尚未封存的可恢復 runtime，clone 會建立新的 Session 與新 identity。

非法轉換必須回傳 CONFLICT 或 SESSION_CLOSED，而不得部分套用。重啟或網路中斷後，backend 以已持久化的 state、revision 和事件序列重建；任何不確定的 command 必須藉由 idempotency key 或 query 確認，而不是猜測是否成功。

## 題目 runtime 狀態

每個 SessionQuestion 獨立管理 HIDDEN、OPEN、LOCKED、REVEALED：

    HIDDEN → OPEN → LOCKED → REVEALED

有效轉換為 HIDDEN→OPEN、OPEN→LOCKED、LOCKED→REVEALED。HIDDEN 可在 session 尚未結束前被取代或取消發佈；REVEALED 為終態。若產品需要允許教師從 REVEALED 重新出題，必須建立新的 SessionQuestion instance，保留原題目的結果與審計軌跡。

題目狀態轉換只能由 domain/application service 執行。React 按鈕僅發出意圖，不能直接更改 UI state 當作真實結果；backend 成功後以 query 或 domain event 更新 UI。

## 鎖題與作答

OPEN 期間可接受 Submission。LOCKED 後，新 submission 預設拒絕並回傳 QUESTION_LOCKED；已存在 submission 的 replacement 規則必須在 command 中明示並記錄 revision。重複 request 使用 submission_id 取得同一結果，不能重複評分或重複更新統計。

## 封存邊界

endSession 停止新的 classroom interaction，archiveSession 將 final runtime 資料、grades、統計與必要 audit metadata 轉入 SQLite 歷史資料。封存完成後 session 變為不可變；Supabase runtime copy 可按 retention policy 清除或匿名化。
