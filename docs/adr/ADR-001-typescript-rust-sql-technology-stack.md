# ADR-001：TypeScript + Rust + SQL 技術組合

## Context

Classroom 需要跨平台教師桌面端、瀏覽器學生端、可測試的領域規則、本機持久化與選用雲端 runtime。團隊需要避免多種 server/runtime 語言造成部署與維護負擔。

## Decision

前端與共用契約使用 strict TypeScript；教師桌面殼、本機 HTTP/WebSocket 與 SQLite adapter 使用 stable Rust 與 Tauri 2；SQLite/PostgreSQL schema 和 migration 使用 SQL。Supabase Edge Functions 如有需要亦使用 TypeScript，所有 runtime validation 使用 Zod。

## Consequences

領域型別可在前端與 edge 層共用，Rust 可提供單一可打包的本機執行檔，SQL 保留資料完整性。此選擇要求維護清楚的 TypeScript/Rust DTO 邊界、雙方測試與 migration 對等語意。
