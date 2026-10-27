# Current Task

Phase 16F Pass A + A2 review snapshot。此檔是目前審查入口，不取代完整 source/test review。

# Source Identity

- Repository: RavenCH-oc/teachTools
- Branch: codex/phase16f-pass-a-a2
- Canonical base: c5285196a08e412732eb2246efd78e3c9644d15a
- CODE_SNAPSHOT_COMMIT: 10d67e32f5f5ec355471cf1d285ee6e82d83e51c
- Final working-file source digest: 374d69fdb0ebabca7be318d401a371ddb8c5c3091675360a48e24bf195b7e4e3
- Workload source digest: c5f49db836098af7c9620df80e830b4d811bc3c1e3d60c86cf35b9ebfa245907
- [Evidence index](docs/review-evidence/phase16f-pass-a-a2/README.md)
- PR head SHA 由 GitHub 與任務最終回報提供，不在此記錄包含本檔自身的 commit SHA。

# Status

- Implementation: LOCAL_REMEDIATION_COMPLETE
- Review: PENDING_FULL_BRANCH_REVIEW
- Production verification: NOT_EXECUTED
- Installed Human QA: NOT_EXECUTED
- Phase 16F release: HOLD
- Review branch delivery: PARTIAL — local commits 保存完成後停於 push 前；Cloudflare 部署副作用尚未確認，SSH 認證另有缺口。Draft PR 尚未建立。

# Scope

已保存完整 baseline → Pass A + A2 成果：non-owner close 副作用修正、enrollment transactional rollback、async sanitized error boundary、await-body 後 lifecycle/generation/quota 重查、Student 有界 HTTP GET retry、共用 HTTP reader/原生診斷、local-only capacity/safety harness、四 PDF CREDIT 排程與 re-auth race 修正、provisional quota 隔離、failed-join cache 淘汰、公眾入口有界 admission，以及 regression tests、稽核與量測文件。

本次只保存現有實作並新增審查入口／精簡證據／workflow 說明。沒有新增 runtime bug fix，沒有重跑 workload，沒有 Pass B/C、production deployment/load/D1 writes、方案／雲端資源變更、installer、dependency、migration、R2、Range 或 CI/deploy 設定變更。40 synthetic clients 是規劃測試目標，不是 40 位真實學生的產品容量驗收。

# Findings

以下 severity 為本次審查用分類，不表示風險已經 production 驗收；詳細證據見索引與歷史報告。

| ID / severity | Root cause | Remediation / previous verification | Residual limitation |
| --- | --- | --- | --- |
| A-OWNER-CLOSE / P1 | 非 owner close 得到 403 仍清除他人的 Session/socket/pending | transaction 非成功即 return；同 fixture owner 可用且自身 close 正常，local regression previous PASS | 尚未部署；不代表所有 lifecycle production 行為已驗收 |
| A-ENROLLMENT / P2 | installation INSERT 失敗仍消耗 one-time activation | D1 transactional batch conditional INSERT + consume；fault injection rollback 後可重試，previous PASS | 僅 ephemeral local D1；未讀寫 production D1 |
| A-ERROR-BOUNDARY / P2 | async route rejected promise 逃出 sanitized try/catch | return await 納入邊界，固定 503、不洩露 raw storage error；injected failure previous PASS | Production logs/bindings 未查核 |
| A-AWAIT-BODY / P1 | await body 期間 lifecycle/generation/quota 已變，仍用舊 admission state | body 完成後重取當前 meta/teacher/quota；四個交錯 regressions FAIL→PASS | deterministic local race 測試不等於所有 production 排程情境 |
| A-HTTP-RETRY / High | 四條媒體上限下，一般圖片暫時拒絕缺少足夠有界恢復 | Student GET 有限 retry 與取消；A2 40 clients 全部圖片在 12.739 s 內完成 | 不增加 stream 上限；WAN/mobile rendering 未驗收 |
| A2-SCHEDULING / High | 連續 pull→CREDIT→CHUNK 鏈延遲其他事件；reconstruction 時舊 realtime 與 re-auth 競態 | replenishment CREDIT 批次讓出事件；既有 auth deadline 內丟棄舊 valid REALTIME，仍需 Rust AUTH。四 PDF ACK 從 40 個 10 s timeout 變為 p95 465.483 ms、無非預期 re-auth | 峰值 bulk throughput 下降；沒有延長既有 timeout 或停用 re-auth |
| A2-QUOTA / High | 未驗證 participantId 可先占用被冒名者的 quota | session/participant/credential 暫存 hash 隔離 provisional owner；Rust 每次讀取授權。偽造 401、合法者可獨立進入；全域四條仍有效 | hash 不是授權；分散假請求仍可競爭全域 quota |
| A2-JOIN-CACHE / High | 128 個失敗結果可占滿 120 s recovery cache | 僅淘汰最舊失敗；合法加入與成功 credential recovery 保留；9 focused tests previous PASS | 全部成功結果占滿時仍 fail closed |
| A2-ADMISSION / High | 公開 dispatch 與 slow body 可耗盡資源 | isolate/IP/DO buckets、有限 pending/records、5 s body deadline。20 invalid enroll 從 20 D1 batches 降為 8，其餘 12×429；denied-IP map poisoning 修正 | 非全球持久 DoS/cost cap；PoP/restart、共享 NAT、分散流量仍有風險 |
| RELEASE-GATE / Release blocker | 最終 Remote URL fail-closed build gate、toolchain/RC/installed verification 尚未完成 | 本輪不修復，保留 HOLD | 後續獨立授權與驗證；不得由 local PASS 推論 release READY |

# Verification

**Previous PASS，這次沒有重跑：**

| 範圍 | 既有結果 | Evidence source |
| --- | --- | --- |
| A2 Relay/harness | 90 tests：18 admission + 13 security + 15 HTTP + 6 lifecycle + 4 quota + 12 re-auth + 2 scheduling + 14 workload safety + 6 server safety | [A2 report](docs/phase16f-pass-a2.md)；[對應 targets／命令紀錄界限](docs/review-evidence/phase16f-pass-a-a2/README.md#verification-provenance) |
| A2 native | 18 tests：9 participant/cache + 6 HTTP/quota + 3 control | A2 report；最初 control fixture 缺 URL 的失敗也保留，修正 fixture 後 3 PASS |
| A2 Student | 20 tests：Remote transport/App recovery | A2 report；未在 A2 改 Student runtime |
| Rust tooling | fmt/check/clippy PASS | A2 report |
| Local workload | four PDF、1/4/5/10/20/40 images、generation/cancel recovery PASS；before failures 保留 | [Selected measurements](docs/review-evidence/phase16f-pass-a-a2/README.md#measurement-exports) |
| Pass A historical commands/results | Relay 49、harness 14、Student 47、native 19 + HTTP 4 PASS；後續仍定位出四 PDF blocker | [歷史報告](docs/remote-release-verification.md)，不能只摘 PASS 宣稱 Pass A capacity acceptance |

**本輪實際執行：** branch/base 與 GitHub refs 唯讀查核；原始 33 檔／47 個指定 snapshot 檔案保存；27 apps source manifest exact-byte 核對；staging allowlist；secret/artifact scan；JSON parse、original/export hash、selected-field equality；Git 換行正規化差異；相對連結、staged/committed scope、git diff --check。沒有 broad tests、capacity workload、build 或 GUI QA。

A2 的完整 literal shell invocation logs 未隨報告保存；索引列的是報告可確認的 targets／等價重現命令，不冒稱已逐字核對或本輪執行。此前測試輸出不是由本次文件整理產生。

# Source Differences

- 完整容量 workload 之後加入：Worker terminal reject 對已關閉 peer 的 send/close 容錯，以及 legacy native integration test 的 test-target credential backup/restore guard；對應 focused regressions PASS，未為這兩項重跑完整容量 workload。
- Final 與 workload source identity 不同，不能把 final source retroactively 當成 workload source。Direct-after Worker 另早於後續 admission ordering 修正；各變體 digest 見原始 manifest。
- 既有 core.autocrlf=true 未更動。只有 apps/relay/scripts/capacity-local.safety.test.js 的 Git blob 與原 working bytes 不同，確認僅 CRLF→LF。Final digest 仍指原 working bytes；[逐檔比較](docs/review-evidence/phase16f-pass-a-a2/source-byte-preservation.json) 記錄 committed blob hashes，沒有為湊 hash 改 source。

# Cloud / Release

最後文件記錄的 Worker version：13424a84-25a3-409d-a0b6-1371f6b270d4；來源為 [2026-10-25 成本／release 稽核](docs/phase16f-cost-and-release.md) 的 deployment listing。**不是本輪 live version 查核**，本輪未重新部署。

實際 account plan／production costs 仍 UNKNOWN。Final Remote build gate、RC、installed Human QA 尚未完成。

本輪 2026-10-26 唯讀副作用檢查：本機無 active Git hooks；GitHub workflows=0、runs=0、repository webhooks=[]。Cloudflare GET /accounts 回 403 / 9109 Invalid access token，未取得 Workers Builds triggers/branch filters/deploy command 或 Pages source/production/preview 設定。GitHub 沒有 workflow/webhook 並不能排除 Cloudflare GitHub App integration。依任務第 10 節停止於 push 前，沒有改認證／設定或觸發 build。

SSH 非互動 git ls-remote 回 Permission denied (publickey)；保留 origin SSH alias，未改 identity／認證。以已連線 GitHub GET refs 核實 remote main=canonical base，matching target refs=[]。需有權限的 Operator 恢復既有 SSH 存取及提供／開放 Cloudflare 唯讀設定查核，不能將缺口當成部署授權。

# Remaining Work / Stop Point

- 先解決 task branch push 的部署副作用確認及 SSH 存取，再依授權建立 Draft PR。
- GPT 對固定 PR head SHA 完整 branch review；六檔 incremental patch 不代表完整 review scope。
- 使用者手動 Create a merge commit；新 commit 須重核受影響差異，merge 不授權 production deploy。
- Production-safe bounded harness 尚待後續任務；pilot residual-risk decisions 與精確 production 授權未完成。
- Release URL、toolchain、RC、installed QA 待後續獨立驗證。

停止在 review 準備，不自動開始上述工作。Phase 16F release: HOLD。

[本輪唯讀部署副作用查核](docs/review-evidence/phase16f-pass-a-a2/deployment-side-effects.json)。
