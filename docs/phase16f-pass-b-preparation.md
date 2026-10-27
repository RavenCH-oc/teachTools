# Phase 16F Pass B preparation

日期：2026-10-27（Asia/Taipei）。Task base：`7db449392ed741ab1df1b15e3cb67f02c730392f`。
本任務實作獨立 runner、focused tests 與本機整合驗證；production execution **NOT_EXECUTED**，Phase 16F release **HOLD**。
PR #1 的 A／A2 與 PR #2 的交接已整合；[既有交接](handoff/phase16f-after-pr1.md)與[A2 evidence](review-evidence/phase16f-pass-a-a2/README.md)保持歷史內容。

## Pilot 與驗證範圍

使用者目前只確認 **1 Teacher／1 classroom／約 30 位學生**的試用規模。Runner 預設與最大值都是 30，允許明確縮小至 1–30 的 synthetic profile；沒有第二位 Teacher、第二個 classroom 或提高上限的設定。
本機整合 smoke 使用 2 位學生及約 2 MiB synthetic PNG；30 人的完整階梯由 focused adapter tests 驗證排程，沒有將它寫成 30 人 WAN／手機容量驗收。

所有 participants 先在 LOBBY 完成一次 join、AUTH、personalized sync，才啟動課堂。其後增加的是 **concurrent media readers**，完整階梯為 `1／4／5／10／20／30`；較小 profile 保留不超過人數的階梯並加入其終點，例如 2 人為 `1／2`。這不是逐級增加 sockets，也沒有放寬 ACTIVE 課堂的加入契約。

候選 gates 保留：text ACK p95 ≤2 s、media ACK p95 ≤3 s、普通圖片至少 95% 在 30 s 內且全部在 60 s 內完成。它們仍待 production 驗證，非已確認 WAN SLA。此 profile 只讀普通圖片，沒有 PDF preset，也不含四條 100 MiB PDF。

## 組件與邊界

| 組件 | 責任 |
| --- | --- |
| [pass-b.js](../apps/relay/scripts/pass-b.js) | 預設 plan、獨立 execution entry、artifact／授權核對、全輪 deadline、cleanup 與 report |
| [pass-b-safety.js](../apps/relay/scripts/pass-b-safety.js) | 固定 target／scope／caps、路徑與 junction 檢查、hash、monotonic deadline |
| [pass-b-ledger.js](../apps/relay/scripts/pass-b-ledger.js) | effect 前同步保存 intent、可信 exact IDs、未知結果、cleanup／總體判定 |
| [pass-b-adapters.js](../apps/relay/scripts/pass-b-adapters.js) | ephemeral loopback Miniflare；另有僅接受 exact ID/hash 的 production D1 adapter |
| [pass-b-process.js](../apps/relay/scripts/pass-b-process.js) | owned child、匿名 stdin/stdout 管線、有限 waits、sanitized errors、終止與 stdout drain |
| [pass-b-workload.js](../apps/relay/scripts/pass-b-workload.js) | 真實 Student HTTP bundle、synthetic sockets、ACK／detail／presence／cancel／generation 量測 |
| [remote_pass_b.rs](../apps/teacher/src-tauri/src/application/remote_pass_b.rs) | 獨立 Windows ignored test entry、真實 Rust services、synthetic app data／DB／roster／questions／assets、隔離 credential target |
| [pass-b-build.js](../apps/relay/scripts/pass-b-build.js) | 建置 test binary／實際 Student HTTP bundle、fixture 與 source/build manifest，不啟動 workload |

原本 `capacity-local.js` 與其 local-only guards 未修改、未被新 runner import。Teacher 的 join、AUTH、Quiz 與 grading 均由現有 Rust domain/application services 處理；Node 不扮演 Teacher、不產生 domain ACK、不直接修改作答 DB。Student 使用目前 `studentHttpApi.ts` 的 Vite library bundle，包含 Pass A 的 bounded GET retry。

`remote_control.rs` 的正常產品行為保持原契約；共用 URL 選擇與連線函式抽出以供核對，per-run credential／effect hooks 只在 `cfg(test, windows)` 啟用。測試入口新增一個 bounded stdin reader thread，避免同步 pipe 阻塞 Tokio deadline；per-run effect mutex／atomic transport guard 也只在測試入口使用。沒有新 production runtime、dependency、migration 或 protocol。

## 預設 plan 與本機重現

從 repository root 執行預設入口只產生 plan JSON，不啟動 child、credential、D1、HTTP 或 WebSocket：

```powershell
node apps/relay/scripts/pass-b.js
```

明確的 preparation build 命令：

```powershell
node apps/relay/scripts/pass-b-build.js
```

此命令用現有 Vite 建置 `studentHttpApi.ts`，再執行 `cargo test --lib --no-run --message-format=json`，複製固定 native test binary，建立 synthetic PNG 與 `build-manifest.json`。Build 前後 source snapshot 必須完全一致，否則不產生可執行 manifest。產物位於 ignored `apps/teacher/src-tauri/target/phase16f-pass-b-build/<build UUID>/`。

依 build 命令回傳的 manifest 路徑，明確執行最小 loopback smoke：

```powershell
node apps/relay/scripts/pass-b.js loopback-smoke --manifest <build-manifest-path> --students 2
```

Loopback 固定 `http://127.0.0.1:8794/`，使用新 ephemeral D1／DO 與目前 relay source，禁止 outbound service；不讀取 `.dev.vars` 或任何 production management credential。沒有任意 origin／port override。Windows Credential Manager 的專屬 run target 需要本機 OS 存取權限。

執行時計時從讀 manifest／複製 fixtures／啟動 relay/native **之前**開始，包含 native DB／roster setup、provision、workload 與 cleanup。前述獨立 artifact build 是 preparation，不是 production run；執行不會重新建置或把 setup 後的 timer 當作全輪上限。

## Fail-closed 與憑證隔離

Production 唯一 target 為 `https://classroom-relay.ryanaddy1102.workers.dev/`。設定必須逐字匹配 HTTPS origin/root，拒絕 userinfo、query、fragment、其他 port/path；實際 HTTP／WS 目的地也需同源，HTTP redirect 設為 error，WebSocket 不跟隨 redirect。

Node 驗證全部 source／native／Student bundle／fixture 身分及 controlled target 路徑後，native 再獨立核對自己的 executable、bundle、fixture hashes 與 **實際 RemoteControlService effective URL**，才能讀取隔離 Credential Manager target。這涵蓋 debug runtime URL 與其他 build 的 compile-time URL 選擇；單改環境變數無法代替 effective URL 核對。

每次 run 使用有效 UUID，keyring service 為 `Classroom.RemoteInstallation.Phase16FPassB.<runId>`、user 為 `teacher`；依現有 Windows store 的格式，實際 generic target 為 `teacher.Classroom.RemoteInstallation.Phase16FPassB.<runId>`。Configure 先確認該 target 不存在；enroll 前也拒絕既有值，不備份／覆蓋別人的測試 credential。Enroll、create、reconnect、close、cleanup 都用同一 context。正式 target 與舊固定測試 target 不被讀取、覆寫或刪除。Native setup 的 deadline／budget 初始化失敗也先釋放 services／DB，再刪除本次建立的 app data；既有目錄碰撞保留原資料，清理失敗明確回報。

原始 activation code 由 supervisor 產生，只經記憶體與匿名 stdin pipe 交給 native；installation credential 只留 native 記憶體／隔離 Credential Manager；participant bearer 只留 workload 記憶體／傳輸。Child argv 只有非秘密 native entry／target 或 exact hash/ID；raw child stdout/stderr 不寫 logs/report。只接受 `PASS_B` sanitized protocol，且等 stdout drain 才完成退出處理，保留可能較晚到達的可信 exact-ID confirmation。

所有輸出／bundle／fixture／native artifact 必須在受控 ignored target，包含 realpath、祖先 junction、symlink、traversal 與檔案 hash 檢查。這是可信 operator workspace guard，不宣稱防禦同時惡意更換 filesystem 的 OS sandbox。

## Ledger、未知副作用與 cleanup

本機 `operation-ledger.json` 保存非秘密 run／activation hash／installation／Session exact ID；每次 effect 前以同步寫入、fsync、rename 保存 intent，失敗就不送出 effect。公開 `report.json` 的 resource projection 不包含這些 exact operational IDs。

狀態包含 `NOT_EXECUTED`、`INTENT_RECORDED`、`CONFIRMED_CREATED`、`FAILED`、`EFFECT_UNKNOWN`；cleanup 另有 `CONFIRMED_CLEANED` 與失敗／未知狀態，總體保留 `CLEANUP_INCOMPLETE`。

Enroll 與 Session create **各最多一次**。Worker 在 server 端產生 ID；既有 activation table 沒有 installation 對照，也沒有 run-ID Session lookup。送出後 timeout、child crash、response 遺失或無法驗證都保守記為 `EFFECT_UNKNOWN`，停止新工作，不盲目重試、不建立第二個 installation／classroom、不掃描 ACTIVE rows、不按時間猜 ownership。

Native 在可信 server ID 通過驗證後、credential 保存／本機 setup 等後續失敗點之前送出 confirmation。若較晚收到可信 ID，ledger 可補回 cleanup identity，但原 failure 仍保留，不能恢復工作或把該 run 改成 PASS。Crash recovery helper 只把 pending intents 轉為 unknown，不自動 resume／重新 provision。

正常順序：

1. 停止新 workload、取消 owned HTTP／Student sockets／pending controls。
2. installation 仍 ACTIVE 時，關閉精確 owned Session；只有 HTTP 204 才確認成功。
3. 記錄 close 成功、失敗或未知，再撤銷精確 owned installation，清理精確 activation hash。
4. 停止 native transport，刪除本次 credential target 與 synthetic app data。
5. 結束 owned child／ephemeral relay，保存每項 cleanup 結果。

Installation cleanup 採 **revoke，保留 REVOKED row**；不是刪除 registry 歷史。Session close 也不宣稱清空 DO persisted metadata。未知 Session 即使已 revoke、停止 Teacher 或 code rollback，仍是 unresolved。沒有 exact ID 的資源交由後續 operator 調查，禁止把無法定位寫成清理成功。

全輪 deadline 耗盡時不再發出新的 remote cleanup；仍立即要求終止 owned native／dispose local relay，但沒有確認完成就報 incomplete。Ledger intent／confirmation 寫入失敗會鎖定 `LEDGER_UPDATE_FAILED`，停止後續 remote effects；最外層 finally 不依賴 ledger 寫入仍處理 owned 本機資源，報 `ledgerPersistence: FAILED` 與 `CLEANUP_INCOMPLETE`，不以記憶體狀態冒充持久確認。Child `error` 不代表退出，必須收到 `close` 才能確認。只操作本次追蹤的 handle，不按 process name 批次終止。晚完成的 loopback setup 已提前提供 owned dispose handle，能在尚未 ready 時停止。

`overall: PASS` 必須同時符合 runner 完成、全部 product gates 通過、Student cleanup 完成、每個已建立資源的 cleanup 確認且沒有未解 failure/effect。Workload PASS 本身不足以 exit 0。管線或存檔失敗也不轉為成功；保留本機 ledger 供後續核對。

## 流量與 workload 證據

Native 在 socket send **之前**保守預留 cumulative raw `HTTP_RESPONSE_CHUNK` ≤1 GiB、Teacher UTF-8 frames ≤2 GiB；包含重試、取消、partial transfer 與 reconnect，重新連線不重設。拒絕的 frame 不算已預留／已送出，另記 `deniedBeforeSend`。整輪 ≤30 min，預留 2 min cleanup；這些都不是 Cloudflare 帳單 hard cap。

既有 64 KiB envelope、32 KiB chunks、four-credit window、Session 四條 media、participant 一條、AUTH／media timeout 保持不變。Reached limit 即停止後續工作，沒有放大 credits、停用 re-auth、延長產品 timeout 或 retry-to-green。

每個 media stage 記錄 first byte、control probe 開始時仍在讀取的 bodies、完成時間、每次 HTTP attempts／first-attempt rejection、concurrent ACK／detail／presence、Rust authoritative answered count。Lock/reveal 另記其開始時 active media 數；沒有 overlap 時不宣稱在 streaming 中完成。Generation recovery 記錄舊 response interruption、重新 AUTH＋sync、後續作答與圖片；未觀察到 interruption 為 `NOT_OBSERVED`，不重播成功後中斷的 body、不拼接 generations。

執行完成、各 product gate、cleanup、synthetic protocol evidence 分開記錄。真實手機 Blob／decode／render、WAN、installed build、學校 outbound WSS 均未由本輪 smoke 驗證。

## 後續 production 操作前仍待核對

| 項目 | 本輪狀態 |
| --- | --- |
| 實際 plan、共用 usage、quota、CPU/duration/storage/logs | UNKNOWN；未讀取 production D1／帳務 |
| 當前 Worker version、部署 source、Static Student bundle hash | UNKNOWN；最後歷史文件 version 不作本輪 live proof |
| Bindings／vars／resources 與 source 的相容性 | 待 operator 核對 |
| 可用 rollback candidate／code-state 相容 | 待核對；code rollback 不回復 D1／DO state |
| 無真實課堂或核准 maintenance window | 待確認 |
| Shared NAT、局部 admission 重置、global quota availability/cost | 風險接受未決 |
| Roster／bearer identity 強度、revocation exposure | 風險接受未決；試用規模確認不等於接受風險 |
| Fixed-head runner review／production 授權 | 待人工 push、Draft PR 與固定 head 審查 |
| Final RC／installed Human QA／Pass C | NOT_EXECUTED |

仍保留 Local-first／Rust authoritative／DO relay／LAN 獨立邊界。沒有新增 R2、Range、登入／OTP、全域限流服務或 cloud domain DB。歷史五位 Teacher 成本模型不是目前單班實際帳單。

## 未來明確 production entry

只有另行取得使用者對 target、固定 source／native／Worker／Student bundle、時間窗、1 Teacher／1 classroom／最多 30 Students、流量上限與 exact cleanup 的授權，才考慮下列入口。此文件與有效 config 本身均不授權執行。

```powershell
node apps/relay/scripts/pass-b.js execute-production --manifest <reviewed-build-manifest> --authorization <approved-run-authorization>
```

授權 JSON 必須位於 ignored target，且包含 `schemaVersion: 1`、新的 `runId`、整數 `students`、canonical `target`、明確的 `statement: AUTHORIZE_ONE_PASS_B_PRODUCTION_RUN`、未來一小時內的 `expiresAt` Unix milliseconds、exact `sourceDigest`／`nativeSha256`／`clientSha256`／`imageSha256`，以及依序的 `operations: [provision, enroll, create, workload, close, revoke, activation-cleanup]`。

`environment` 必須提供 `workerVersion`、`workerSourceDigest`、`studentSourceDigest`、`deployedStudentBundleSha256`、`maintenanceWindow`；`planReviewed`、`usageReviewed`、`bindingsReviewed`、`rollbackReviewed`、`maintenanceWindowConfirmed` 必須經確認為 true。`riskAcceptance` 的 `sharedNat`、`localAdmission`、`globalQuota`、`rosterBearer`、`revocationExposure` 也需各自明確接受。缺值、UNKNOWN、artifact 不符或過期都拒絕。

這些是 operator-supplied assertions，runner 不把它們當獨立 live API proof。授權涵蓋一次 synthetic activation INSERT、enrollment、Session 建立、負載、exact close／revoke／activation cleanup；**不包含 deployment、rollback、migration、方案變更或真實資料操作**。需要部署 A/A2 source 與包含 bounded retry 的 Student bundle 時，必須另有精確部署授權；runner 不會部署。

## 本輪驗證與來源

實際命令、結果與停止點見 [status.md](../status.md)。新的小型 [smoke summary](review-evidence/phase16f-pass-b-preparation/smoke-summary.json)保存 run ID、tested source／build／bundle／fixture identity、gates 與 cleanup；原始 report、operation ledger、build manifest、binary、fixtures 留在 ignored target，沒有把 hash 當作 reviewer 已取得原件。

Tested source digest 按 build 時實際 working bytes 保存，`testedHead` 是當時的 task base，不能用之後的 commit SHA 倒填。Docs 不參與 source digest；build 前後核對相同，執行前再對目前 source 核對。Git 的既有換行正規化可能改變 checkout bytes，新的環境需重新 build／建立新的 manifest，不沿用不符合 bytes 的 artifact。

本輪 targeted tests／loopback 結果與 A2 previous PASS 分開，未重跑 A2 完整 workload 或 repo broad suites。停止在 local commit；人工 push／Draft PR／固定 head review 後，仍需新的 production execution 授權。Phase 16F release 維持 HOLD。
