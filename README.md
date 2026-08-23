# Classroom

Classroom 是教師主控、學生以瀏覽器加入的課堂互動教學軟體。本倉庫目前處於 Phase 1：Monorepo / Application Skeleton。

## Current implementation phase: Phase 9

Phase 9 adds the local live-quiz vertical slice. A Teacher starts the session, snapshots a Question Bank question and managed media into session-owned storage, opens/locks/reopens/reveals it, and sees basic answered progress. Authenticated Students receive only public question data, submit typed answers with idempotent UUID submission IDs, recover the current question after reconnect, and see only their own result after reveal. Rust grades automatic question types from the immutable session snapshot; essays remain pending.

Advanced statistics, grouping, peer review, manual essay grading, Supabase/cloud sessions, OCR, and AI remain out of scope.

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

Phase 9 已在既有 contract 上加入 SQLite migrations/repositories、local HTTP/WebSocket transport、QR join、authenticated Student lobby、live question snapshots、authoritative Rust grading、submission idempotency，以及 question/session media flows。Supabase/cloud runtime、進階統計、分組、同儕互評、OCR 與 AI 仍不在本階段範圍。

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

Python、Electron、C#、Java、Go、Supabase client 與大型 UI/state framework 不屬於目前 application dependency boundary；本地 SQLite 與 Rust local server 是 Phase 2–9 已核准的 runtime。後續階段仍須在既有 contract 上逐步加入明確授權的 cloud 與分析能力。
