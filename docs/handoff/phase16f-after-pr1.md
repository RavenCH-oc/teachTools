# Classroom / teachTools — PR #1 合併後交接快照

文件日期：2026-10-27（Asia/Taipei）
快照基線：`d7b97d22e030fd51db55f1f61ad83c0f73987aa7`
Repository 路徑：`docs/handoff/phase16f-after-pr1.md`；本輪 docs branch：`codex/phase16f-handoff-status`。

> 這份文件保存交接時的事實、決策、證據入口與停止點，不授權實作或 production 操作。
> 本文件由交接底稿核對現有 source/docs 後納入本機 docs-only 分支；本輪只建立一個 local commit，不 push、不建立 PR。後續本 docs PR 是否已建立／合併，須實際查 GitHub。
> 若文件之後有 docs-only commit／merge，最新 repository baseline 以即時 main ref 為準；
> 上述 SHA 仍是本文件的已驗證起點，不要求它永遠等於最新 HEAD。

## 1. 接手後第一件事

先唯讀核對，不要直接下 Pass B 實作或部署指令：

1. 透過已連接 GitHub 讀取 `RavenCH-oc/teachTools` 的目前 main ref。
2. 核對 PR #1：merged、reviewed head、merge commit。
3. 以固定 SHA 讀 `status.md`、本文件與 evidence index。
4. 檢查是否已有後續 documentation PR 或其他新 commit；不要只相信 branch 名稱。
5. 回報目前 baseline、已完成範圍、未完成 gate，等待／遵守使用者本次明確授權。

2026-10-27 本輪由 GitHub connector 唯讀核對 main ref 與 PR #1 metadata：
main 為上述基線，PR #1 closed／merged，head／merge SHA 如下。
Codex 亦直接讀取本機 Git：起始 branch 為 main，HEAD＝main＝origin/main＝上述基線，
working tree clean，確認同名 task branch 不存在後建立 `codex/phase16f-handoff-status`。
這是起始核對紀錄；後續 docs commit 的 HEAD 不再等於 task base。

若 main 超前本快照，應讀取新增差異並建立新的工作基線；不得 reset 回本文件 SHA。
若 GitHub 無法讀取，明確說明缺少哪一份來源；不要把上傳附件或舊摘要當成 live branch。

## 2. 產品目的與使用者環境

專案：Classroom / teachTools。
Repository：`RavenCH-oc/teachTools`。
本機路徑：`I:\ChatGPT\teachTools`。

使用者需求（交接底稿記錄，非本輪新增驗收）：

- 目標學校不提供學生 Wi-Fi，學生使用自己的 4G／5G。
- 教師不擅長網路操作；Wi-Fi 分享、手動 NAT／VPN 等方案不適合成為必要流程。
- 保留原有 LAN 模式，Remote 問題不得讓 LAN 無法使用。
- 使用者負責實機 Human QA、人工 push（必要時）與最終 merge。
- 不在每輪重跑 broad suites；針對變動與風險做 targeted verification。
- 不把「檔案完整傳完」當成整班即時互動可用。

## 3. Git 狀態與已完成審查

| 身分 | SHA／狀態 |
| --- | --- |
| Phase 16E baseline／PR #1 base | `c5285196a08e412732eb2246efd78e3c9644d15a` |
| Pass A＋A2 code snapshot | `10d67e32f5f5ec355471cf1d285ee6e82d83e51c` |
| PR #1 reviewed head | `3712333e05cdeb8ee6aa03e681881fe14ab85caa` |
| PR #1 merge commit／本快照 main | `d7b97d22e030fd51db55f1f61ad83c0f73987aa7` |
| PR #1 | [GitHub PR #1](https://github.com/RavenCH-oc/teachTools/pull/1)；已合併且關閉（本輪 GitHub 確認） |
| 原 task branch | `codex/phase16f-pass-a-a2`；是否仍存在需即時查詢 |
| 本機同步 | 本輪 Codex 直接核對起始 main＝origin/main＝merge SHA，working tree clean |
| 合併方式 | 使用者選擇 Create a merge commit |

整合內容核對（前輪 GitHub；本輪本機 Git 再核 parents／tree／commit 數與檔案數，PR 數量亦由本輪 metadata 確認）：

- merge 的兩個 parents 為原 main `c528…` 與 reviewed head `3712333…`。
- merge commit 與 reviewed head 的 tree 同為 `bbe245646676e023cd893fd24eab29fa03ab010e`。
- 因此此次 merge 沒有額外檔案變動。
- PR #1 有 2 commits、52 changed files。
- 第二個 commit 是 review status／docs／evidence 整理，不是新的 runtime patch。

前一對話對固定 `3712333…` 完成 PR 範圍、主要 runtime/tests、工具隔離與證據靜態審查，
給出「可整合，未發現新的 merge-blocking finding」。
這是對話中的審查結論，不是 GitHub 正式 APPROVED review 或獨立重跑測試的證明。
底稿記錄前輪 GitHub check runs 為 0（歷史回報，本輪未重查），不能稱 CI 全綠。

## 4. 現在必須分開的狀態

| 範圍 | 目前狀態 |
| --- | --- |
| Phase 16E | 已完成，包含先前 production synthetic verification 與 Human QA |
| Phase 16F Pass A＋A2 | 本機修正與證據已整合至 main |
| PR #1 固定版本靜態審查 | PASS（對話審查） |
| Phase 16F production deployment／capacity verification | 尚未執行 |
| Phase 16F production-safe harness | 尚待獨立任務實作／審查 |
| Phase 16F final Remote build gate／RC／installed QA | 尚未完成 |
| Phase 16F release | **HOLD／NOT COMPLETE** |

「production verification 未執行」是指 Phase 16F，
不是說 Phase 16E 從未部署或從未做 production synthetic smoke。
合併 Git 不等於部署 Cloudflare，也不等於核准試用／發佈。

## 5. 已確定的新開發流程

任務授權 → task branch → targeted tests → 更新 status.md → commit →
push branch → Draft PR → GPT 固定 head SHA 審查 →
使用者 Ready for review → **Create a merge commit** →
GPT 核對 merged PR、merge parents／內容與 main。

規則：

- 不直接 push main，不自動 merge，不啟用 auto-merge。
- Codex 的 commit／push／PR 必須在任務授權內。
- 新 head commit 需重核受影響差異；舊 review 不自動適用新內容。
- branch head 和 merge commit 不必相同，需驗證 ancestry／內容關係。
- 審查結果在對話中不等於 GitHub 已提交正式 approval。
- `status.md` 是入口，不取代實際 diff、相關完整 source、tests 與證據。
- 原有 local-only harness 禁止取消 guard 後用於 production。
- 發佈、正式 D1 writes／cleanup、production 負載、rollback、方案變更是另外的授權。

### SSH 與 Cloudflare 經驗

使用者人工 push 會輸入既有 SSH key 的 passphrase，且已成功。
Codex 曾回 `Permission denied (publickey)`；精確根因未獨立查明。
保留既有 key／passphrase／SSH alias，不要求移除加密，不索取私鑰或密碼。

人工 push 是已驗證可行的正常途徑，不必先讓 Codex 自動 SSH 才能續接。
既有 origin 使用 `github-work` alias，本輪 `git remote -v` 亦確認；沒有變更 origin 或認證。

使用者已在 Cloudflare Dashboard 確認未連接 GitHub repo。
這是 USER_CONFIRMED，不是 GPT／Codex 成功讀取 Cloudflare Builds API。
早先 Codex API 唯讀查詢回 403／9109 的歷史紀錄仍保留；
不代表現有 production 管理／Analytics 認證已自動恢復。

## 6. status.md 維護政策

本次以 `codex/phase16f-handoff-status` 更新 [status.md](../../status.md) 與本文件。
Task base d7b97d2 下舊 status 的「尚未 push／等待完整審查」是歷史快照，
已由後續人工 push、PR #1 review 與 merge 補述；原 evidence 不重寫。

更新後分兩層：

1. Last integrated implementation：PR #1、reviewed head、merge SHA、LOCAL_REMEDIATION_COMPLETE。
2. Remaining release gates：Phase 16F production／RC／installed QA 未完成，release HOLD。

不要把「本輪 docs-only task 的 review」和「A2 已完成的 review」混成同一個欄位。

以後更新時機：

- 任務開始：在 task branch 記錄 base、範圍、禁止事項。
- 每次對外提交／push 可審查版本前：更新實作、實際測試、未解項目與來源身分。
- review 後有修正：同 branch 新 commit，更新受影響範圍與增量測試。
- merge 後：以 GitHub merged metadata 作即時事實；通常於下一任務或交接一併記錄。
- 不必每次 merge 後再開一個只更新「這份 status 自己已 merged」的 PR，避免無限循環。

不要求 status 寫入「包含它自己的最終 commit SHA」。
可記錄 task base、tested code snapshot、last integrated runtime merge；
最終 review head／最新 main 從 GitHub 讀取。

## 7. 架構與不可破壞的契約

Teacher：React／TypeScript／Vite + Tauri 2／Rust／SQLite。
Student：相同來源程式，LAN 與 Remote 只在 bootstrap／transport／HTTP seam 分流。
Cloudflare：Worker + SQLite-backed Session Durable Object + Static Assets；
D1 僅 activation／installation 控制平面，不存課堂答案、題目、評分或媒體。
維持 Local-first + BYO Supabase 架構；React 經 typed service／IPC／application service 存取 repository，不直接讀寫 SQLite 或 Supabase tables；本輪不實作 future cloud backend。
以 repository 的 AGENTS.md 與當前 source 為工程規範；不要依舊 README 的歷史 Phase 9 範圍重做功能。

Rust authoritative：

- roster／Session lifecycle／join admission／participant identity
- Quiz、評分、Grouping、Peer Review
- HTTP read 權限、assignment／cursor／revision／media integrity
- local SQLite 與歷史狀態

Remote：

- Teacher 使用 outbound WSS。
- Student AUTH 必須由 Rust 驗證；DO 不能自行認定學生身分。
- Teacher generation 切換使 Student auth 失效；重新 AUTH＋personalized sync 才恢復。
- HTTP 每次獨立驗證，不以已認證 socket 取代。
- remoteSessionId 是 public locator，不是 credential。
- 原始 participant credential 不進 URL／query／log／Cloudflare persistence；既有 Student origin browser storage 與記憶體內 AUTH／HTTP transport 依現有契約。
- 只允許 typed operations，不做 localhost／URL／filesystem generic proxy。
- 保留 Phase 15 的 Session／participant write guards、揭曉前 correctness／score 隱私。
- LAN 不需 Remote service；Remote join 不需 LAN listener，需保持 LOBBY。
- 無 offline mutation／HTTP queue，無 active Remote↔LAN 自動切換。
- 無 R2、Range、新 cloud domain DB；不得在交接中自動加入。

## 8. Remote transport 關鍵界線

| 項目 | 目前設計 |
| --- | --- |
| Remote Protocol | exact v1 |
| 完整 UTF-8 envelope | 64 KiB |
| raw HTTP chunk | 32 KiB |
| credit window | 4 chunks／128 KiB |
| Session HTTP pending | 64 |
| 同一 presented identity pending | 4；Rust 仍每次授權 |
| Session media | 4 streams |
| 每 participant media | 1 stream（quota provisional key 納入 credential） |
| Native preparing reads | 8 |
| detail total timeout | 15 s |
| media total／idle timeout | 600 s／20 s |
| 支援 image／PDF import 上限 | 20 MiB／100 MiB |
| Student AUTH timeout | 約 5 s |
| Teacher heartbeat／liveness | 約 20 s／60 s |
| join recovery | Teacher transient，120 s／128 attempts |

Teacher 仍取得完整、驗證過的 Vec<u8>；只逐 chunk base64，不做整檔 base64 copy。
Student 目前 fetch 完整 authenticated Blob，再顯示 image／PDF object URL。
四個大型檔案完整傳完不等於 ACK／re-auth／presence 正常。

八個 GET allowlist：

- PEER_REVIEW_ACTIVITIES_LIST
- PEER_REVIEW_ACTIVITY_GET
- PEER_REVIEW_CANDIDATES_LIST
- PEER_REVIEW_ESSAYS_LIST
- PEER_REVIEW_FEEDBACK_LIST
- PEER_REVIEW_FEEDBACK_GET
- PEER_REVIEW_OWN_REVIEW_GET
- SESSION_ASSET_GET

精確 arguments／path／scope 以 [Remote HTTP contract](../remote-http-relay.md) 與現有 source 為準。

## 9. Pass A＋A2 修正與結論

Pass A 已處理：

- enrollment install／consume atomicity
- 非 owner close 的副作用
- async error boundary
- await body 後重新檢查 lifecycle／generation／quota
- 僅對 Remote media 指定 429 的 bounded GET retry
- 本機有界 capacity／safety tools

A2 已處理：

- CREDIT replenishment 分批讓出 task，不增大四-credit window。
- DO reconstruction／re-auth 期間，舊 valid REALTIME 不再關掉已待重驗 socket。
  不轉送、不 fake ACK、不重播；matching Rust AUTH 仍必要。
- 暫存 hash `[sessionId, participantId, presentedCredential]` 隔離 quota claim。
  Hash 不是授權；全域四流仍可能被惡意競爭。
- failed-join cache 只淘汰最舊失敗，保留成功 recovery；全成功滿額仍 fail closed。
- Worker isolate／IP／DO 的局部 admission 與 5 s control body deadline。
- global rejection 先於新 IP map allocation；terminal reject send/close 容錯。

既有測試回報：90 Node、18 Rust、20 Student PASS，以及相關 Rust checks。
這些是 prior Codex-run results，不是 GPT 靜態審查或本次交接重新跑出來的結果。

本機 after evidence：

- 四條 100 MiB PDF active 時，40/40 ACK；Wrangler p95 465.483 ms。
- detail 約 166.011 ms；非預期 re-auth／offline／WS error 0。
- 四 PDF 最大約 56.102 s，aggregate raw 約 7.13 MiB/s。
- 40 個約 2 MiB 圖片讀取全部成功，最慢 12.739 s。
- generation interruption 後 40 clients 約 2.774 s 恢復。
- native working set 抽樣峰值約 423.219 MiB，並非 DO／手機 RAM。

全部是同 Windows PC loopback＋native test/debug＋protocol synthetic clients。
不是 40 支手機、WAN、安裝版或產品容量承諾。
修正是控制 latency 與 bulk throughput 的取捨，不是已證實遠端圖片加速。

## 10. 歷史 production 與效能限制

最後文件記錄的 Worker version：
`13424a84-25a3-409d-a0b6-1371f6b270d4`

來源：2026-10-25 cost/release 稽核引用的 deployment listing；
不是本次交接重新查詢 Cloudflare 的結果。

Worker origin（歷史操作目標，本輪未連線）：
[Classroom relay](https://classroom-relay.ryanaddy1102.workers.dev/)

Phase 16E 歷史 production synthetic：

- 約 20 MiB PNG：25.647 s，integrity／MIME PASS。
- 100 MiB PDF：125.041 s，integrity／MIME PASS。
- 使用者手機 4G 約 2 MiB 圖片：主觀載入約 10 s。
- Human QA A–H PASS；使用者暫接受現有 100 MiB PDF 速度。

Phase 16F A／A2 的 runtime 尚未部署；不能把目前 GitHub main 當成雲端已運行版本。
Actual account plan／CPU／duration／storage／logs／共用 usage 仍 UNKNOWN。
成本文件的 US$5.30／5.45／5.75 是指定五位 Teacher 模型中的部分小計，
不是實際完整月費、費用上限或方案已驗證；未來決策需重新核對當時官方價目與實際用量。

## 11. 證據來源與歷史身分

必讀（相對於本文件）：

- [目前 status](../../status.md)
- [工程規範](../../AGENTS.md)
- [Evidence index](../review-evidence/phase16f-pass-a-a2/README.md)
- [A2 report](../phase16f-pass-a2.md)
- [Pass A 歷史報告](../remote-release-verification.md)
- [Relay audit](../phase16f-relay-audit.md)
- [Auth audit](../phase16f-auth-audit.md)
- [A2 security evidence](../phase16f-a2-security-evidence.md)
- [Cost／release audit](../phase16f-cost-and-release.md)
- [Remote HTTP contract／Phase 16E closeout](../remote-http-relay.md)
- [Relay README](../../apps/relay/README.md)
- [Final working-file manifest](../review-evidence/phase16f-pass-a-a2/source-harness-manifest.json)
- [Workload manifest](../review-evidence/phase16f-pass-a-a2/workload-source-manifest.json)
- [Working bytes／committed blobs](../review-evidence/phase16f-pass-a-a2/source-byte-preservation.json)
- [Original／export artifact manifest](../review-evidence/phase16f-pass-a-a2/artifact-manifest.json)
- [2026-10-26 歷史部署副作用查核](../review-evidence/phase16f-pass-a-a2/deployment-side-effects.json)

Source identity 不要互換：

- Final working-file digest：
  `374d69fdb0ebabca7be318d401a371ddb8c5c3091675360a48e24bf195b7e4e3`
- Workload source digest：
  `c5f49db836098af7c9620df80e830b4d811bc3c1e3d60c86cf35b9ebfa245907`
- Committed source blob digest：
  `c822369d327be20603971e7256b01c763530a0abe71265384e669d8bd8157185`

只有一個測試檔受到既有 CRLF→LF 正規化；見 source-byte-preservation.json。
terminal-reject／legacy native cleanup guard 在完整 workload 之後加入，
僅補 focused verification；direct-after Worker 另早於後續 admission ordering 修正。
不得用 final digest 改寫歷史 workload source。

公開 `.selected.json` 為去除指定 trace 欄位的 derivative，不等於完整原始 JSON。
原件／export hash 分開保存。
六檔 security-scheduling.patch 是 Pass A→A2 增量；完整 code 由 PR #1 base→head 表示。

未公開的 raw logs／traces、native binary、Student bundle、PNG／PDF fixture 在本機 ignored target；
只有 hash 並不等於 reviewer 已取得檔案或獨立驗證內容。
A2 完整 literal invocation logs 未完整公開，重現 targets 不冒稱原命令逐字記錄。
歷史報告中的「未提交／未 push／待審查」屬當時快照；目前進度以 GitHub 和更新後 status 補述，
不抹除早期 FAIL 或重寫原量測資料。

## 12. 後續工作順序（計畫，不是執行授權）

### 目前：交接 docs-only

更新 status、加入此交接文件、固定來源與停止點；本輪僅做文件檢查與一個 local commit。
使用者人工 push 分支並建立 Draft PR，建議 base `main`、head `codex/phase16f-handoff-status`、
title `docs: record PR1 merge and prepare Phase 16F handoff`。
本輪 Codex 不 push、不建立 PR、不 merge；不改 runtime，不重跑 tests／workload，不部署，不建立 installer。

### 後續候選：Pass B preparation

需由使用者另行授權任務，至少包含：

- pilot 接受範圍：shared NAT、分散 admission、global quota、身分強度與撤銷 exposure。
- 唯讀確認帳號方案、usage、production version、可用 rollback 與現場網路條件。
- 建立並審查獨立 production-safe runner，不去掉 local-only guards。
- 強制 canonical origin、run identity、精確 synthetic installation／Session 清理。
- 核對 production 會部署哪個 source／Student bundle；不能漏掉 Pass A Student HTTP retry。

### 授權後才可執行：Pass B production verification

歷史計畫上限，仍須在執行任務重新明確授權：

- 最多 1 synthetic Teacher／1 classroom／40 Student sockets。
- 逐級 1／4／5／10／20／40，普通圖片優先；失敗即停止升級。
- raw HTTP chunk 累計 ≤1 GiB，Teacher UTF-8 frames ≤2 GiB，含重試與取消。
- 單輪 wall-clock ≤30 min；不是 Cloudflare 帳單 hard cap。
- 僅 synthetic 資料，不動真實 DB／憑證／課堂。
- provision／enroll／精確 IDs cleanup 皆有 production effects，必須明確授權。
- 初始範圍不包含四條 100 MiB PDF；該負載需額外授權。
- no blind retry-to-green；無其他真實課堂或使用核准維護窗。
- rollback 需核對 code／state 相容；code rollback 不回復 D1／DO state。

不要自行執行舊 16E production runner，或把 local-only script 改 origin 就用於 production。

### Pass C

- Remote release URL fail-closed wrapper／驗證。
- 工具鏈政策：declared Rust 1.88 與報告實測版本不同，尚無最低版本保證。
- Windows x64 NSIS current-user、unsigned、WebView2 bootstrapper、既有 app-data identifier。
- source／Worker／Student bundle／installer SHA-256 RC manifest。
- 安裝後不需老師自己設定 env、啟動 LAN listener 或登入 Cloudflare。
- 真正 installed Human QA 與學校出站 WSS 行為尚待驗證。

R2 仍 deferred。release HOLD 不得用延長 timeout、停用 re-auth、
降低門檻、放大並行或未審查 cache／proxy 來「消除」。

## 13. 常用操作背景（不是本輪執行指令）

Teacher development 目前需要在同一 PowerShell 設定 build-time relay URL 後啟動：

```powershell
cd I:\ChatGPT\teachTools\apps\teacher
$env:CLASSROOM_REMOTE_BASE_URL = "https://classroom-relay.ryanaddy1102.workers.dev/"
pnpm.cmd exec tauri dev
```
僅為操作背景。交接任務不需啟動 Teacher、連接 production 或重新 enrollment。

Activation tool：

```powershell
cd I:\ChatGPT\teachTools
pnpm --filter @classtools/relay run activation:create:prod
```
這會真的向 production D1 寫入短效 hash，不是 dry run；
只給有權限 operator、在必要且授權的情況下使用。
32-byte random／43-char base64url、SHA-256、10 分鐘單次碼；
D1 確認插入成功才輸出，勿貼 code／credential 到對話或 repo。

成功啟用的同一 Teacher installation 應重用 Windows Credential Manager。
「未設定 Remote relay URL」和「未 enrollment」是不同問題；啟動 LAN server 不會補入 relay URL。
正式 build 設定缺口留給 Pass C，不在交接文件任務中修復。

若將來批准部署，專案 script 的形式是 `pnpm --filter @classtools/relay run deploy`；
不要漏掉 run 而撞到 pnpm 同名 built-in。本文件不授權執行此命令。
不要重做已存在的 production migration。

## 14. 新對話開場範本

請接手 Classroom / teachTools。
先讀取附件交接快照，再透過 GitHub 核對目前 main、PR #1、
最新 status.md 與後續 docs-only PR；不要只依歷史 branch 名稱判斷狀態。

PR #1 已用 Create a merge commit 整合至
d7b97d22e030fd51db55f1f61ad83c0f73987aa7。
Pass A＋A2 本機修正已整合，但 Phase 16F release 仍 HOLD。
下一步只先確認交接、目前來源與 Pass B 尚缺前提，不自動實作或部署。

請使用 branch → status.md → Draft PR → 固定 head 審查 →
由我手動 merge 的流程；人工 push 可接受。
不要因先前 Codex 非互動 SSH／Cloudflare API 失敗，而要求移除 passphrase 或重做 A2。
任何新的實作、production 操作與 final RC 需另取得對應授權。

## 15. 本快照依據與適用範圍

| 來源類別 | 本文件使用的事實與限制 |
| --- | --- |
| GITHUB_CONFIRMED（2026-10-27 本輪唯讀） | main ref；PR #1 closed／merged、base／head／merge SHA、2 commits／52 changed files；PR body 的待審查措辭是歷史交付說明 |
| LOCAL_GIT_CONFIRMED（本輪） | 起始 main／HEAD／origin/main／clean；核對 merge parents，merge tree 與 reviewed-head tree 相同；本機 task branch 建立與兩檔 docs scope |
| DOCUMENT_REPORTED | 現有 source／docs／evidence／manifests 支持的契約、歷史量測與 prior tests；Phase 16E closeout 與 Worker version 來源，非本輪重跑或 Cloudflare live proof |
| USER_CONFIRMED（交接底稿／任務附件記錄） | 人工 SSH push 成功、Cloudflare Dashboard 未接 GitHub；合併方式由使用者選 Create a merge commit |
| PRIOR_CHAT_REVIEW（交接底稿／任務附件記錄） | 固定 `3712333…` 的靜態審查與可整合結論；非本輪重新完整 source review，非 GitHub formal approval |
| 本輪 docs-only | 直接核對附件與現有 repo，建立交接分支並整理兩份文件；不宣稱本 docs PR 已建立／merged，不記錄自身 commit SHA |

本輪實際文件檢查：相對連結／路徑／anchor、SHA 與 manifest 身分、claims 與 previous-test labels、
兩檔全文與 staged diff、credentials／真實學生資料／generated artifacts 檢視、兩檔 allowlist、`git diff --check`。
本輪沒有 live Cloudflare／billing 查核、測試或 workload 重跑、runtime／manifest／evidence data 修改或 release acceptance。

未被來源支持的驗收、精確環境、帳務數據一律保持 UNKNOWN／NOT_EXECUTED，
不得以一般知識補成「已確認」。
