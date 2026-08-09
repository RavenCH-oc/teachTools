# Classroom

Classroom 是一個教師主控、學生以瀏覽器加入的課堂互動教學軟體。它採用 local-first 資料策略，並提供 BYO Supabase 雲端執行層：教師擁有並設定自己的 Supabase 專案，而課程、學生名冊與歷史資料仍以教師電腦上的 SQLite 為權威來源。

## Phase 0 狀態

本倉庫目前只完成架構與工程契約基線。尚未建立 React、Tauri、Rust、SQLite schema、Supabase migration、學生網頁、HTTP/WebSocket 伺服器、評分引擎、安裝程式、AI 功能或 CI/CD。

Phase 1 開始前，所有實作必須遵循本倉庫的文件，尤其是 SessionBackend 抽象、資料權責、狀態機、錯誤模型、安全邊界與 migration 策略。

## 技術方向

- 前端：React、TypeScript、Vite
- 桌面端：Tauri 2、Rust
- 本機持久化：SQLite
- 本機課堂網路：Rust HTTP 與 WebSocket server
- 雲端執行層：Supabase、PostgreSQL、Realtime、RLS、SQL migrations
- 共用驗證：TypeScript、Zod
- 測試方向：Vitest、React Testing Library、cargo test
- 資料庫語言：SQL

Python 不是本產品 runtime、sidecar、server、migration、匯入匯出或 helper 的一部分。若未來需要例外，必須先新增 ADR 並取得明確核准。

## 架構文件

- [系統架構](docs/architecture.md)
- [資料模型](docs/data-model.md)
- [Session 與題目生命週期](docs/session-lifecycle.md)
- [SessionBackend 契約](docs/backend-contract.md)
- [安全模型](docs/security-model.md)
- [Cloud migration 策略](docs/migration-strategy.md)
- [應用程式錯誤模型](docs/error-model.md)
- [工程規範](docs/engineering-rules.md)
- [Architecture Decision Records](docs/adr/)

## 下一步

Phase 1 應先建立可編譯的 monorepo 骨架與 domain/contract 套件，再以測試落實狀態機、submission idempotency 和 authoritative grading。實作不得繞過文件所定義的 application service 與 SessionBackend 邊界。
