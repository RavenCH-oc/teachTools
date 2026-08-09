# ADR-004：SessionBackend 抽象

## Context

本機 LAN 與 Supabase 雲端 runtime 使用不同 transport 與儲存技術，但教師和學生 UI 需要相同的課堂行為。

## Decision

定義 SessionBackend contract，將 command、query、realtime event、錯誤、capability 與 idempotency 語意統一。Phase 1 實作 LocalBackend 與 SupabaseBackend；未來 CustomBackend 必須符合 required capabilities。

## Consequences

UI 不再耦合 SQLite、Rust 或 Supabase table，後端可替換且可測試。契約成為重要相容性面，任何 backend 需嚴格維持狀態機、權限、評分及 submission retry 的一致結果。
