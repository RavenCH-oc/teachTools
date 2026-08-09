# Cloud Migration 策略

## 原則

所有 production schema 變更都以 source-controlled SQL migration 進行；禁止 ORM auto-sync。SQLite 與 PostgreSQL 可以使用各自方言，但必須實作相同 domain semantics、foreign keys、unique/check constraints、indexes 與 transaction boundary。

Cloud schema 具有版本紀錄，至少保存 schema_version、migration_id、checksum、applied_at、status。migration 依固定順序執行、接受版本控制與 checksum 驗證、可行時具 idempotency 和 transaction，並 fail closed。

## 相容性與失敗行為

應用程式啟動或建立 cloud session 前必須讀取 cloud schema 狀態。若 app requires schema 7 而 cloud 是 schema 5，系統顯示 SCHEMA_INCOMPATIBLE 並拒絕啟動 cloud runtime；不得在部分已套用 migration、未知 checksum 或失敗 status 下繼續。

每次 migration 應先檢查前置版本及 checksum，再寫入 in-progress status、執行 SQL、驗證 tables/indexes/functions/RLS/Realtime，成功後才標記 applied。可交易的步驟包在 transaction；不可交易的步驟需有明確補償或人工修復指引。失敗時保留足夠 diagnostics，但不暴露 credential 或 SQL payload 給 UI。

## Provisioning

教師提供 Project URL 與 publishable/anon-compatible runtime credential。這些只建立 runtime client 的連線；它們不是自動佈署 production schema 的授權。Cloud initialization 需要以下受控流程：

    輸入 runtime credential
        → 檢查 Project URL 與連線
        → 選擇 provisioning credential 或受控 provisioning channel
        → 執行版本化 SQL migrations
        → 驗證 tables、indexes、functions、RLS、Realtime
        → 寫入 ready status

Phase 0 不指定 provisioning credential 的儲存、傳輸或 UX；Phase 1 需提出受威脅模型約束的方案，例如使用者在 Supabase SQL Editor 手動貼上受檢查的 migration bundle，或在受保護的本機設定流程中暫時提供具最小必要權限的 credential。無論方案為何，anon key 都不得用來 provision production schema。

## 驗證與回復

Migration runner 必須在執行前後檢查版本、checksum 與 required objects，並以 machine-readable 結果提供 UI。向前 migration 是預設；若需要 rollback，必須以獨立且已測試的 migration 表達，不能以隱式 schema rewrite。migration artifact、SQL source 與其 checksum 全部納入版本控制。
