# ADR-008：以 migration 管理 schema

## Context

SQLite 與雲端 PostgreSQL 的 schema 需要可追溯、可驗證且可安全升級；隱式 auto-sync 無法可靠處理 RLS、functions、Realtime 和 production failure。

## Decision

所有 production schema 變更使用 source-controlled SQL migrations。雲端追蹤 schema_version、migration_id、checksum、applied_at、status；migration 依序執行、驗證 checksum、可行時 transactional，失敗即 fail closed。

## Consequences

版本不相容可被明確偵測並阻擋 cloud runtime，而不是損壞資料。團隊需維護 migration runner、驗證、rollback/forward 修復策略，以及受控 provisioning channel。
