# ADR-003：Local-first 持久化儲存

## Context

課堂資料包含學生名冊、教材、題庫、成績與歷史紀錄，教師必須能在離線及無雲端設定下持續掌有資料。

## Decision

以教師電腦上的 SQLite 作為 classes、students、courses、lessons、question sets、questions、assets、歷史 sessions/submissions、grades、group presets 與設定的權威來源。雲端僅承擔進行中 session runtime，並在結束後依 archive boundary 匯回 SQLite。

## Consequences

離線教室可運作，資料所有權與匯出更直接。系統必須設計 archive、衝突、備份、刪除與未來的同步策略，且不得把 Supabase 當成教師資料的隱式主資料庫。
