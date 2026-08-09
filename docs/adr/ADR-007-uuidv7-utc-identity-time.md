# ADR-007：UUIDv7 與 UTC 的身分/時間策略

## Context

LocalBackend 與 SupabaseBackend 都需要能離線產生、跨系統合併並可排序的識別；本地時間在 DST、不同時區與傳輸時容易產生歧義。

## Decision

所有跨系統 entity、request 與 event identity 使用 UUIDv7；所有持久化和 transport timestamp 使用 UTC ISO-8601。UI 才轉換為使用者本地時區。資料庫自增欄位若存在，只能作內部索引，不能作全域 identity。

## Consequences

事件排序、離線建立與多 backend 對應更可靠。實作需選擇並測試 UUIDv7 generator，並在 DTO、SQLite/PostgreSQL schema 與 log 中一致序列化時間。
