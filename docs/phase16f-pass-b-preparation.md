# Phase 16F Pass B preparation

初版日期：2026-10-27（Asia/Taipei）；PR #3 review fixes／artifact refresh：2026-10-28。歷史 `taskBase`：`7db449392ed741ab1df1b15e3cb67f02c730392f`；本輪起點：`330b93ee1c7f86b01fddc5d6899bf6eed5d2676a`。
既有 runner 與契約維持不變；本輪僅重建本機 artifacts／manifest 並做最小兩人驗證。Production execution **NOT_EXECUTED**，Phase 16F release **HOLD**，Pass C **NOT_STARTED**。
PR #1 的 A／A2 與 PR #2 的交接已整合；[既有交接](handoff/phase16f-after-pr1.md)與[A2 evidence](review-evidence/phase16f-pass-a-a2/README.md)保持歷史內容。

[PR #3](https://github.com/RavenCH-oc/teachTools/pull/3) 已由使用者人工 merge，main／origin/main 的本輪起點為 `330b93ee1c7f86b01fddc5d6899bf6eed5d2676a`。固定 head `5ffb7d6e4a339b523d135115d764c78eb4a84971` 審查後，`843aeab7d3a56aaaa427fcab7d5c5c64e6703f95` 修正了單次授權 run identity、unknown provisioning 的 cleanup 判定、generation interruption 的原因分類、control completion timestamp 與 run-abort 收尾。[Linux review-fix evidence](review-evidence/phase16f-pass-b-preparation/pr3-fixes.md) 與 [Windows verification](review-evidence/phase16f-pass-b-preparation/windows-review-fixes.md) 保留歷史結果：Windows 138 Node tests PASS、9 native tests PASS／1 ignored、兩人 smoke 22 gates PASS／cleanup confirmed。它們綁定當時 tested HEAD 與 artifacts，不作本輪驗證結果。

## 本輪 artifact refresh

Task branch：`codex/phase16f-pass-b-artifact-refresh`。前次唯讀盤點確認舊 artifacts 仍符合原 manifest，但目前 checkout 有八個 source files 的 CRLF／LF raw bytes 不同，既有 `readBuildManifest()` 因而回報 `SOURCE_IDENTITY_MISMATCH`。本輪從目前 raw bytes 建立新的 build UUID 目錄與 manifest，保留全部舊 artifacts／evidence，不修改 source、換行設定、歷史 hashes 或身分檢查。

本輪 build、完整 source-before／after identity、新 manifest 與三 artifacts 核對、`readBuildManifest()`：**PASS**。247 筆 source 清單與 raw hashes 在建置前後及 manifest 完全一致，source digest 為 `49b1da1ad0cd6f57ecb0908b32f7f61ee49cbf5a8bf639bd01bffa741a0b761e`。新 manifest 位於 `apps/teacher/src-tauri/target/phase16f-pass-b-build/3fa348da-b4af-4631-9b1d-cde837cecf37/build-manifest.json`；`testedHead` 保持實際建置時的 `330b93ee1c7f86b01fddc5d6899bf6eed5d2676a`，歷史 `taskBase` 仍按既有契約保留 `7db44939…`，不回填之後的文件 commit。

2026-10-28 UTC 12:34:14.918–12:34:25.717 執行 build，12:35:38.502–12:35:44.961 執行唯一一次兩人 loopback smoke；兩者各一次、exit 0，沒有失敗或重試。新 run `0b7bd155-a537-4020-99c9-c8b97f7df669` 的 overall 與 **22/22 gates PASS**，elapsed **6372.1358 ms**，實際 readers 為 `1／2`。六類資源均 `CONFIRMED_CLEANED`、unresolved 空、ledger persistence confirmed；native readers／media／credit waiters 均為 0。Raw reserved **13,093,802 bytes**、Teacher UTF-8 reserved **17,574,852 bytes**，沒有 budget stop 或 denied-before-send；預留數不是帳單數。

Generation 舊流記為 `STREAM_INTERRUPTED`，first byte **2245.1714** ≤ trigger **2245.2632** ≤ interruption **2277.7725 ms**（相對 workload 起點），保留 **TEMPORAL_CORRELATION_ONLY**。完整命令、時間、artifact hashes、各 gates／cleanup 與原件位置見 [artifact refresh evidence](review-evidence/phase16f-pass-b-artifact-refresh/README.md)。這次結果只代表本機兩人 synthetic protocol smoke，不是 30 人 production、WAN、手機 render 或 installed QA 驗收。

本輪不重跑歷史 138 Node tests、完整 Rust suite、A2 或其他容量測試。Build entry 內的 `cargo test --lib --no-run` 僅為 native artifact 編譯，不能記成 Rust runtime tests 已執行。Runner 的 `student-http-client.mjs` 是 HTTP library，與 production browser `dist-remote` 是不同產物；本輪不建置或部署 browser `dist-remote`，公開 Student 缺少 bounded 429 retry 的差異仍未解決。

## Pilot 與驗證範圍

使用者目前只確認 **1 Teacher／1 classroom／約 30 位學生**的試用規模。Runner 預設與最大值都是 30，允許明確縮小至 1–30 的 synthetic profile；沒有第二位 Teacher、第二個 classroom 或提高上限的設定。
初版 Windows 本機整合 smoke 使用 2 位學生及約 2 MiB synthetic PNG；30 人的完整階梯由 focused adapter tests 驗證排程，沒有將它寫成 30 人 WAN／手機容量驗收。

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

Activation hash 已知也不能證明 provisioning 已結束。若開始 activation cleanup 時 INSERT 尚未確認完成，先保存 `CREATE_OUTCOME_UNKNOWN`；本次精確 DELETE 即使成功，也只能作 best-effort cleanup，仍保留 `EFFECT_UNKNOWN`／`CLEANUP_INCOMPLETE`。這避免 DELETE 回傳當下 0 rows、原 INSERT 隨後才完成時誤報清理成功；cleanup 開始後才收到 create confirmation 也不消除先後順序的不確定性。既有已確認 INSERT、之後再精確 DELETE 的正常路徑保持可確認完成。停止 child 不等於遠端寫入已取消。

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

每個 media stage 記錄 first byte、control probe 開始時仍在讀取的 bodies、完成時間、每次 HTTP attempts／first-attempt rejection、concurrent ACK／detail／presence、Rust authoritative answered count。`controlCompletedAtMs` 只等待 ACK／detail／presence，media rows 各自保存完成時間。Lock/reveal 另記其開始時 active media 數；沒有 overlap 時不宣稱在 streaming 中完成。

Generation recovery 記錄舊 response 的 `terminationCause`、`reconnectTriggeredAtMs`、重新 AUTH＋sync、後續作答與圖片。Runner 自己的 total-read／body deadline、run abort、主動 cancel 或 size guard 都不能滿足 generation interruption gate；舊流若一直卡到 client timeout 才結束，該 gate 與整體 product gates 不得 PASS。只有 trigger 時仍在讀取、其後觀察到的 stream interruption 才能作為該觀察證據，並標示 `TEMPORAL_CORRELATION_ONLY`，不能從 generic transport failure 推論更強的 server-side 原因。舊 read 正常完成而未觀察到 interruption 時為 `NOT_OBSERVED`；deadline／abort／guard 或其他不符合條件的失敗為 `FAIL`。不重播成功後中斷的 body、不拼接 generations。

執行完成、各 product gate、cleanup、synthetic protocol evidence 分開記錄。真實手機 Blob／decode／render、WAN、installed build、學校 outbound WSS 均未由這些本機 smoke 驗證。

## 後續 production 操作前仍待核對

2026-10-28 19:22–19:38（Asia/Taipei）的 Cloudflare 唯讀盤點曾確認單一 active version `13424a84-25a3-409d-a0b6-1371f6b270d4`、traffic 100%，並核對 live configuration 與 D1 schema。這是特定時間的歷史觀察，本輪沒有呼叫 Cloudflare 管理 API 或 production URL；前後 snapshot 一致也不代表連續監控。歷史 Billing／Builds endpoints 的 HTTP 403 與 provenance 未知狀態仍保留，analytics 不能代替完整帳務與 quota 核對。

對未來的新部署，該次觀察的 active `13424a84-25a3-409d-a0b6-1371f6b270d4` 是優先 rollback 候選；其 source、assets、application／DO persisted state／D1 schema 相容性仍待部署準備審查。`613f3f40-f192-4626-9561-a188dcdc5502` 僅是更早的候選，不取代部署前 active 版本的保存與核對。Code rollback 不會還原 D1／DO state，候選並不表示已可安全執行 rollback。

| 項目 | 本輪狀態 |
| --- | --- |
| 實際 plan／Billing、共用 usage／quota、CPU/duration/storage/logs | 未完成；歷史有限 analytics 不作完整帳務或 remaining quota 證據 |
| Worker version／Builds／部署 source／assets provenance | 上述 active version 為歷史盤點；Builds 與來源映射未完成，本輪未 live 重查 |
| Production Student browser bundle | 歷史公開 JS 缺少 bounded 429 retry，尚未解決；HTTP library hash 不能代替 browser deployment identity |
| Bindings／vars／resources 與 source 的相容性 | 歷史 configuration／D1 schema 已核對；未來部署相容性仍待準備審查 |
| Rollback candidate／code-state 相容 | 優先候選 `13424a84…`；相容性與執行 readiness 未完成 |
| 無真實課堂或核准 maintenance window | 待確認 |
| Shared NAT、局部 admission 重置、global quota availability/cost | 風險接受未決 |
| Roster／bearer identity 強度、revocation exposure | 風險接受未決；試用規模確認不等於接受風險 |
| Fixed-head review／production 授權 | PR #3 已人工 merge；本輪 local evidence commit 後由使用者人工 push／建立 Draft PR 並固定新 head 審查；production 尚未授權 |
| Final RC／installed Human QA／Pass C | NOT_EXECUTED |

仍保留 Local-first／Rust authoritative／DO relay／LAN 獨立邊界。沒有新增 R2、Range、登入／OTP、全域限流服務或 cloud domain DB。歷史五位 Teacher 成本模型不是目前單班實際帳單。

## 未來明確 production entry

只有另行取得使用者對 target、固定 source／native／Worker／Student bundle、時間窗、1 Teacher／1 classroom／最多 30 Students、流量上限與 exact cleanup 的授權，才考慮下列入口。此文件與有效 config 本身均不授權執行。

```powershell
node apps/relay/scripts/pass-b.js execute-production --manifest <reviewed-build-manifest> --authorization <approved-run-authorization>
```

授權 JSON 必須位於 ignored target，且包含 `schemaVersion: 1`、新的 `runId`、整數 `students`、canonical `target`、明確的 `statement: AUTHORIZE_ONE_PASS_B_PRODUCTION_RUN`、未來一小時內的 `expiresAt` Unix milliseconds、exact `sourceDigest`／`nativeSha256`／`clientSha256`／`imageSha256`，以及依序的 `operations: [provision, enroll, create, workload, close, revoke, activation-cleanup]`。

Production authorization 的 `runId` 必須是明確且有效的 UUID 字串；缺少、`null`、非字串或格式錯誤都拒絕，不替授權文件補產生 ID。同一份合法授權每次核對得到同一 run identity，既有執行目錄存在時仍拒絕重用。

`environment` 必須提供 `workerVersion`、`workerSourceDigest`、`studentSourceDigest`、`deployedStudentBundleSha256`、`maintenanceWindow`；`planReviewed`、`usageReviewed`、`bindingsReviewed`、`rollbackReviewed`、`maintenanceWindowConfirmed` 必須經確認為 true。`riskAcceptance` 的 `sharedNat`、`localAdmission`、`globalQuota`、`rosterBearer`、`revocationExposure` 也需各自明確接受。缺值、UNKNOWN、artifact 不符或過期都拒絕。

這些是 operator-supplied assertions，runner 不把它們當獨立 live API proof。授權涵蓋一次 synthetic activation INSERT、enrollment、Session 建立、負載、exact close／revoke／activation cleanup；**不包含 deployment、rollback、migration、方案變更或真實資料操作**。需要部署 A/A2 source 與包含 bounded retry 的 Student bundle 時，必須另有精確部署授權；runner 不會部署。

## 驗證與來源

本次實際命令、結果與停止點見 [status.md](../status.md)及[artifact refresh evidence](review-evidence/phase16f-pass-b-artifact-refresh/README.md)。初版 [smoke summary](review-evidence/phase16f-pass-b-preparation/smoke-summary.json)保存歷史 run ID、tested source／build／bundle／fixture identity、gates 與 cleanup；原始 report、operation ledger、build manifest、binary、fixtures 留在原 Windows ignored target，沒有把 hash 當作 reviewer 已取得原件。

初版 tested source digest 按 build 時實際 working bytes 保存，`testedHead` 是當時的 task base，不能用之後的 commit SHA 倒填。Docs 不參與 source digest；build 前後核對相同，執行前再對目前 source 核對。Git 的既有換行正規化可能改變 checkout bytes，新的環境需重新 build／建立新的 manifest，不沿用不符合 bytes 的 artifact。

PR #3 的 Linux review 當時未取得原完整 Windows manifest，因此保留完整 digest 差異未解的紀錄。歷史 Windows verification 找回原 manifest 後完成機械比對：初版與 `5ffb7d6…` Git blobs 的 27 筆差異均為換行差異；當時 Windows 與 Linux review-fix snapshot 的 35 筆差異也全為 CRLF／LF。完整 raw hashes、逐檔比較與限制見 [Windows source manifest](review-evidence/phase16f-pass-b-preparation/windows-review-fixes-source-manifest.json)。當時 build 使用 raw digest `6a01e4c1…`，不是正規化 digest；這份歷史身分不代表目前 checkout 仍可直接使用舊 manifest。

初版、Linux review fixes、歷史 Windows targeted tests／loopback、A2 previous PASS 與本輪 artifact refresh 分開保存。歷史 Windows 結果綁定 `843aeab7…`；本輪從 `330b93ee…` 的 raw source 重建，文件 commit 不回填建置／測試時 HEAD。完成一個 local evidence commit 後停止，由使用者人工 push、建立新的 Draft PR 與固定 head 審查；production deployment 與 execution 仍各需另外明確授權。本輪不產生可執行 production authorization JSON。Phase 16F release 維持 HOLD，Pass C NOT_STARTED。
