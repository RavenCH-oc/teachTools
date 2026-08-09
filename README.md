# Classroom

Classroom 是教師主控、學生以瀏覽器加入的課堂互動教學軟體。本倉庫目前處於 Phase 1：Monorepo / Application Skeleton。

## Current implementation phase: Phase 6

Phase 6 adds the local Question image/PDF media foundation: Rust-validated imports into app-managed storage, persisted QuestionAsset metadata and checksums, safe Teacher previews, PDF page references, lifecycle cleanup, and answer-safe public media projection. Student media delivery, quiz sessions, HTTP/WebSocket, Supabase, OCR, and AI remain out of scope.

The older Phase 0/1 historical notes below are preserved for context; the Phase 6 statement above is the current implementation boundary.

本階段已建立：

- pnpm workspace root
- Teacher React + TypeScript + Vite web shell
- Teacher Tauri 2 / Rust runtime skeleton
- Student React + TypeScript + Vite responsive web shell
- @classtools/domain
- @classtools/backend-contract
- @classtools/shared
- @classtools/validation
- @classtools/grading
- strict TypeScript、ESLint、Vitest 與 React Testing Library smoke tests

本階段刻意尚未建立 SQLite schema、Supabase client/migrations、local HTTP/WebSocket server、QR、grading engine、登入、資料 repositories 或 Phase 2 domain workflows。

## Development prerequisites

需要 Node.js、pnpm、Rust stable、Cargo，以及 Windows 上 Tauri 所需的 WebView2 和 Microsoft C++ build tools。請先確認：

    node --version
    pnpm --version
    rustc --version
    cargo --version

若 Rust/Tauri prerequisite 尚未安裝，TypeScript workspace 仍可先執行；Rust checks 需在工具鏈可用後補跑。

## Basic commands

    pnpm install
    pnpm dev:teacher
    pnpm dev:student
    pnpm tauri:dev
    pnpm typecheck
    pnpm test
    pnpm build
    pnpm lint

Teacher web 使用 1420 port，Student web 使用 1421 port。Tauri 開發命令會先啟動 Teacher Vite frontend。

## Architecture

Phase 0 架構與工程契約仍是所有後續工作的規範：

- [系統架構](docs/architecture.md)
- [資料模型](docs/data-model.md)
- [Session 與題目生命週期](docs/session-lifecycle.md)
- [SessionBackend 契約](docs/backend-contract.md)
- [安全模型](docs/security-model.md)
- [Cloud migration 策略](docs/migration-strategy.md)
- [應用程式錯誤模型](docs/error-model.md)
- [工程規範](docs/engineering-rules.md)
- [Architecture Decision Records](docs/adr/)

Python、Electron、C#、Java、Go、資料庫與雲端 SDK 不屬於此 skeleton 的 dependency boundary。下一階段才會在既有 contract 上加入 persistence 與 runtime implementation。
