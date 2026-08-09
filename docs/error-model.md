# 應用程式錯誤模型

## 統一錯誤格式

所有 application service 與 SessionBackend 錯誤轉換為安全的 application error：

    code
    safe_message
    technical_context
    retryable

safe_message 可直接顯示給教師或學生。technical_context 只供受控 diagnostics 使用，必須 redact secrets、token、個資、答案和原始資料庫 payload。UI 不可顯示 raw SQL error、Rust Debug error、panic、stack trace 或 Supabase internal response。

## 錯誤碼

| 類別 | Code | 預設處理 |
| --- | --- | --- |
| 輸入 | VALIDATION | 修正輸入，不重試 |
| 查詢 | NOT_FOUND | 顯示不存在或已刪除 |
| 競爭 | CONFLICT | 重新取得最新狀態 |
| 身分 | UNAUTHORIZED | 重新加入或登入 |
| 權限 | FORBIDDEN | 停止並提示權限不足 |
| 生命周期 | SESSION_CLOSED | 停止課堂操作 |
| 題目 | QUESTION_LOCKED | 顯示已截止作答 |
| 網路 | NETWORK | 可在退避後重試 |
| backend | BACKEND_UNAVAILABLE | 可重試或切換為可用模式 |
| schema | SCHEMA_INCOMPATIBLE | 阻擋 cloud runtime 並完成 migration |
| migration | MIGRATION_FAILED | fail closed，提供受控診斷 |
| storage | STORAGE | 不重試破壞性操作，要求修復 |
| 未預期 | INTERNAL | 產生 correlation id，安全失敗 |

## 轉換規則

transport、SQLite、Rust、PostgREST 或 Supabase Realtime 的原始錯誤只能在 backend adapter 轉換。domain 層只處理 application error code 與可測試的結果。每一個 command 都必須區分可安全重試的網路失敗與已套用但尚未收到回應的結果；submission 使用 idempotency query 解決後者。

每個 error 應攜帶 correlation id、actor 類型、session ID 的安全雜湊或可控參照及 operation name；不得附帶完整答案、token、姓名或 secret。
