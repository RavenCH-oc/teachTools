# 工程規範

## 基準技術

正式實作使用 TypeScript、React、Vite、Tauri 2、Rust、SQLite、Supabase/PostgreSQL/Realtime/RLS、SQL、Zod、Vitest、React Testing Library 與 cargo test。Supabase Edge Functions 如有需要使用 TypeScript。

禁止加入 Python runtime、sidecar、FastAPI、Flask、Django、Python PDF/Excel/migration/WebSocket/HTTP/helper。也不採用 Electron、C#、Java 或 Go，除非新的 ADR 明確說明理由、替代方案與後果。

## TypeScript

TypeScript 必須 strict，禁止未經說明的 any。共用 types 定義一次；transport DTO、domain model 與 UI state 保持分離。所有 runtime boundary 使用 Zod 驗證。React component 不可直接查詢 SQLite/Supabase、不可包含 grading 邏輯，且不得用 string 加 optional fields 取代 discriminated union。

## Rust

使用 stable Rust。production code 禁止 unsafe、unwrap() 與 expect()；任何例外都需 ADR。重要操作回傳 Result 並在明確 error boundary 轉換為安全錯誤。blocking work 不可阻塞 async executor；SQLite transaction boundary 必須明確。避免 global mutable state 和未經架構說明的 Arc<Mutex<T>>。

Tauri command 保持 thin，只負責 DTO、授權入口與 application service 呼叫。業務邏輯不得置於 command；network layer 與 domain logic 分離；serde DTO 需要版本與驗證策略。panic/backtrace 不可傳送給 client。

## SQL 與資料

SQLite、PostgreSQL schema 以 domain semantics 為先。所有 production schema 變更使用 migration，不使用 auto-sync。外鍵、unique/check constraints、indexes、transactions 與資料完整性不可只依 UI 保護。ID 使用 UUIDv7；持久化與 transport 時間使用 UTC。

## 測試與品質

每個 domain state transition、非法 transition、submission idempotency、grading authority、授權隔離、migration 相容性和 RLS policy 都需可自動化測試。TypeScript 使用 Vitest 與 React Testing Library；Rust 使用 cargo test。測試不得依賴真實教師資料、secret 或雲端專案。

## 安全、隱私與日誌

最小化 cloud 資料與 telemetry。不得將 credential、participant token、完整答案、完整 HTTP body、不必要姓名、敏感 SQL payload 或 debug stack trace 寫入 log。所有新 feature 必須說明其 actor、授權、資料所有權、archive、retention 與失敗行為。

## Repository 與 Git

Phase 0 只包含 README、.gitignore、docs 與 ADR。未來預期的 top-level layout 為 apps、packages、supabase、docs，但在建立 Phase 1 實作前不預先建立空目錄。提交前執行 git diff --cached --check，並確認沒有 secret、binary build output 或無關檔案。
