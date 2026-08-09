# 系統架構

## 目標與原則

Classroom 的產品架構為 local-first + BYO Supabase。教師的電腦是本機課堂與長期資料的中心；Supabase 是選用的跨網路即時執行層，而不是教師資料的預設主資料庫。教師可在沒有網際網路、Supabase、教師電腦上的 Node.js runtime、額外 server 應用程式或 Python 的情況下使用 LocalBackend。

每個 React UI 都只能呼叫 application service。UI 不得直接讀寫 SQLite、Supabase table 或 Rust repository；領域規則、狀態轉換、權限及評分不得散落在元件事件處理器中。

## 邏輯分層

    React UI
        ↓
    Application service
        ↓
    Domain model / validation / SessionBackend contract
        ↓
    LocalBackend 或 SupabaseBackend
        ↓
    SQLite、Rust LAN server、Supabase/PostgreSQL/Realtime

SessionBackend 是課堂 runtime 的唯一 backend 抽象。Phase 1 至少提供 LocalBackend 與 SupabaseBackend；未來可以新增 CustomBackend，但其行為必須符合相同的 required capabilities 和 protocol semantics。

## 本機模式

教師安裝的 Tauri 應用程式內含 Teacher React UI、Rust/Tauri layer、SQLite、本機 HTTP server、本機 WebSocket server，以及已打包的 Student Web App。

    學生瀏覽器 → LAN / Wi-Fi → 教師電腦上的 Teacher App

教師電腦不需安裝 Node.js、Python 或獨立 server。Phase 1 的 Rust 實作需明確分開 Tauri command、application service、repository/backend、網路與檔案系統。

## 雲端模式

教師自行提供 Supabase Project URL 與 publishable 或 anon-compatible runtime credential。雲端僅用於跨網路課堂 runtime 與 realtime execution：active sessions、participants、已發佈 session questions、submissions、runtime question state、學生提問及投票、群組 runtime、同儕互評指派與繳交。

Supabase 不持有 classes、known students、courses、lessons、question sets、questions、local assets、歷史 sessions、歷史 submissions、grades、group presets 或應用程式設定的權威副本。session 結束後，runtime 資料須依 archive boundary 匯回本機 SQLite。

## Source of Truth 與資料界線

| 類別 | 權威來源 | 用途 |
| --- | --- | --- |
| 教師名冊、課程、題庫、資產、設定、歷史及成績 | SQLite | 長期本機資料 |
| 進行中的 session 與即時互動 | LocalBackend 或 SupabaseBackend | 暫時 runtime state |
| 雲端 runtime archive | SQLite | 結束、匯整與可攜歷史 |

所有儲存與 transport timestamp 使用 UTC；UI 在最後一層依使用者本地時區顯示。所有跨 backend identity 使用 UUIDv7，不使用資料庫 auto-increment 作為全域識別。

## Supabase provisioning 界線

runtime credential 只能用於 runtime；public 或 anon credential 不得被視為可以安全建立 production schema 的權限。Cloud setup 需要獨立的 provisioning credential 或受控 provisioning channel，並在執行前完成 migration、RLS、Realtime 與 validation 的 fail-closed 檢查。其 UX 和可接受 credential 管道是 Phase 1 前必須處理的開放設計問題。

## 非目標

本階段不建立 apps、packages 或 supabase 目錄，也不實作任何桌面程式、Web app、database schema、server 或雲端部署。
