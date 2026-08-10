# 安全模型

## 信任邊界

教師 application service 與受保護的 backend 是 authoritative boundary。學生瀏覽器是非受信任 client：它只能送出已驗證的 intent 和答案，不能決定 score、correct、session state、question state、role 或資料讀取範圍。本機模式由教師電腦上的 Rust backend 執行權威檢查；雲端模式由雲端 trusted operation 與 PostgreSQL RLS 共同執行。

Supabase publishable 或 anon credential 可以暴露於 client bundle，但不得擁有 schema provisioning、service role 或跨使用者讀寫的能力。service_role credential 永不進入 runtime client、log、repo 或診斷匯出。

## 身分與授權

學生以 QR/join code 取得 session lookup，再以座號及姓名確認建立 Participant。join code 設計為短時效並具防猜測/速率限制；session credential 為高熵、可撤銷、可到期的 token。座號與 participant_id 都不是 authentication。

每個 command 依 token 驗證 participant、session、role、目標 entity 和狀態。reconnect 必須輪替或驗證 credential；重放請求由 request/submission identity、revision 及 expiry 控制。

## 威脅與控制

| 威脅 | 控制 |
| --- | --- |
| join code 猜測 | 高熵或短時效代碼、rate limit、鎖定與監控 |
| token 竊取、participant ID 竄改 | bearer token 驗證、session binding、輪替/撤銷、server-side actor lookup |
| forged/replayed/duplicated submission | backend authorization、submission_id、原子去重與 revision |
| 提前讀取答案或改分 | server-side answer/grading、最小化 DTO、RLS、不可相信 client score |
| 讀取他人 submission、群組或 peer review | entity-level authorization、RLS、assignment checks |
| 自評、重複 peer review | assignment uniqueness、禁止 self target、submission uniqueness |
| 惡意文字與 XSS | Zod boundary validation、長度限制、輸出編碼、不可注入 HTML |
| oversized payload 或惡意檔案 | request/file size、MIME/內容驗證、儲存隔離、掃描策略 |
| RLS 誤設 | migration tests、deny-by-default policy、角色矩陣驗證 |
| credential 或教師設定外洩 | secret storage、redaction、.gitignore、最小權限 |

## 隱私與紀錄

雲端只保留最小 runtime 資料。學生姓名、座號、答案、成績與教師設定都是敏感資料；系統需支援未來的 retention、刪除、匯出與匿名化。log 只能記錄足以診斷的資料，禁止記錄 secret、participant token、完整 request body、完整答案、不必要的學生姓名或敏感 SQL payload。

Production log level 為 ERROR/WARN/INFO/DEBUG/TRACE，但較高診斷層級不可放寬敏感資料規則。診斷匯出必須再次進行 redaction。

## Phase 6 local QuestionAsset boundary

Question media is imported only through the Teacher dialog and a narrow Rust command. Rust accepts PNG, JPEG, WebP, and PDF only after extension and signature validation, rejects SVG and all other media, applies 20 MiB image and 100 MiB PDF limits, and never moves or deletes the selected source file.

The application writes copies only to its managed app-data `assets/` directory. Destination paths are generated from UUIDv7 IDs, persistent metadata stores a relative managed path and SHA-256 checksum, and no source absolute path is persisted. Storage-path traversal, absolute overrides, unsafe display names, and raw I/O errors are rejected or hidden behind controlled application errors. Tauri asset-protocol scope is limited to the managed asset directory; no broad filesystem plugin capability is granted.

Public Question projection includes only safe asset identity, type, display name, MIME type, size, position, and optional PDF page reference. It excludes source paths, managed paths, checksums, correct answers, and grading configuration.

## Phase 7 local transport boundary

The local Axum transport serves only a static root page, health metadata, and a same-origin WebSocket handshake/ping endpoint. It has no wildcard CORS policy, admin HTTP API, raw database access, filesystem API, asset route, directory listing, or public Teacher/Student/Question data. Health and `server_hello` contain only protocol version and a per-start UUIDv7 server instance ID.

WebSocket upgrades require an `http` Origin matching the request Host and port. Text JSON is limited to 64 KiB and validated against a typed versioned protocol. Malformed, binary, unknown-version, and unknown-type messages receive a safe protocol error rather than raw parser or socket details. Phase 7 has no authentication because it exposes no classroom data; Session and Participant credentials remain a future boundary.
