# Current status — Phase 16F Pass B review fixes

- 日期：2026-10-28（Asia/Taipei）；repository：RavenCH-oc/teachTools。
- 已合併 main／原 task base：`7db449392ed741ab1df1b15e3cb67f02c730392f`。
- 本次增量修正起點／測試時 committed HEAD：`5ffb7d6e4a339b523d135115d764c78eb4a84971`；branch：`codex/phase16f-pass-b-preparation`。
- **REVIEW_FIXES_IMPLEMENTED / NODE_TARGETED_VERIFICATION_PASS / WINDOWS_NATIVE_SMOKE_PENDING**。
- [PR #3](https://github.com/RavenCH-oc/teachTools/pull/3) 已人工 push 並建立 Draft，尚未合併；本次修正只建立 local commit，等待人工 push 與新的固定 head SHA 複審。
- Pilot：**1 Teacher／1 classroom／預設與最大 30 Students**；media-reader 階梯 `1／4／5／10／20／30`。
- Production、final RC、installed Human QA **NOT_EXECUTED**；Phase 16F release **HOLD**，Pass C **NOT_STARTED**。

## 本次修正

| 項目 | 修正後行為 |
| --- | --- |
| Production run identity | Authorization 與 production profile 都要求明確有效 UUID；缺值／null／非字串拒絕。Plan／loopback 可自動產生 ID；合法授權重用仍由既有 run directory 拒絕 |
| Unknown activation provisioning | Cleanup 開始時 creation 未確認就保存 `CREATE_OUTCOME_UNKNOWN`；精確 DELETE 成功或較晚的 create confirmation 不能把該次 cleanup 升為 confirmed；保留 `EFFECT_UNKNOWN`／`CLEANUP_INCOMPLETE` |
| Generation interruption gate | Read 記錄 sanitized `terminationCause`；自身 deadline／abort／size guard 不能 PASS。需 trigger 時仍在讀取並觀察到其後 stream interruption；僅宣稱 `TEMPORAL_CORRELATION_ONLY` |
| Control timing／中止收尾 | `controlCompletedAtMs` 只等待 ACK／detail／presence；run abort 後不再建立 recovery ACK promises |

舊 snapshot 中 unknown activation 搭配已確認 cleanup 的矛盾狀態，recover 時也會降為 unknown。正常已確認 provisioning、之後再 exact cleanup 的成功路徑保留；不重試、不掃描、不猜 ownership，close-before-revoke 順序不變。

本次修改限 Node runner／tests、[runbook](docs/phase16f-pass-b-preparation.md) 與新的 [review-fix evidence](docs/review-evidence/phase16f-pass-b-preparation/pr3-fixes.md)。Rust、Worker、Student runtime、D1 schema、原 A2 harness／evidence、package manifests 與 lockfile 都未修改；沒有新增 dependency 或 runtime。

## 本輪實際驗證

環境：Linux x64、Node v24.22.1；沒有 Rust toolchain／Windows Credential Manager。先以 repository 指定的 pnpm 9.15.0 安裝既有 locked dependencies，停用 lifecycle scripts：

```sh
npm exec --yes --package=pnpm@9.15.0 -- pnpm install --frozen-lockfile --ignore-scripts --filter @classtools/relay
```

最終 targeted Node verification：**138/138 PASS，0 failed、0 cancelled、0 skipped、0 todo**。

```sh
node --test --test-isolation=none --test-concurrency=1 --test-reporter=tap apps/relay/scripts/pass-b-safety.test.js apps/relay/scripts/pass-b-ledger.test.js apps/relay/scripts/pass-b-supervisor.test.js apps/relay/scripts/pass-b-adapters.test.js apps/relay/scripts/pass-b-process.test.js apps/relay/scripts/pass-b-workload.test.js apps/relay/scripts/capacity-local.safety.test.js apps/relay/scripts/capacity-local-server.test.js
node apps/relay/scripts/pass-b.js
```

Plan PASS：1 Teacher／1 classroom／30 Students 與完整 media-reader 階梯，`productionEffects: NONE`、`executionAuthorized: false`、release HOLD。Targeted tests 的 native／D1／HTTP／WebSocket 皆使用 mocks；包含 30 人排程，不是 30 人實際 native／WAN 驗證。

保留驗證限制與初次執行紀錄：

- 初次預設 sandbox 執行 ledger／supervisor／adapter focused tests 時 supervisor file failed；單獨 `sourceIdentity()` 診斷確認 `EPERM / spawnSync git`。同一個本機測試範圍取得 subprocess 存取後通過，沒有執行 production command。
- 最終同一八檔的預設 process-isolation 命令 exit 0，但 TAP destination 只保留 135 個逐項 PASS、缺少結尾 plan／summary；未以該不完整輸出宣稱總數。上面的 single-process command 取得完整 `1..138` 與 138/138 summary。
- 新的 run-abort regression 初次抓到中止後仍建立 ACK promise 的 unhandled `SUBMIT_FAILED`；加入 `ensureRunning()` 後，最終完整測試無 asynchronous activity／unhandled rejection warning。
- 修正後 Rust checks、native／Student artifact build 與兩人真實 Windows loopback smoke **NOT_EXECUTED**；沒有沿用舊 smoke 宣稱新 source 已完成整合驗證。

完整實際結果、命令與 raw TAP hash 見 [verification summary](docs/review-evidence/phase16f-pass-b-preparation/pr3-fixes-verification.json)。

## Source 身分與 previous results

本次使用既有 `sourceIdentity()`，測試前後 **247 個 source files 的完整清單與 digest 相同**：

```text
af0d6cf0a3eadb1e92edeeae9f797f52d8a842e875018944b2135f1f133da7c1
```

[完整 source-only manifest](docs/review-evidence/phase16f-pass-b-preparation/pr3-fixes-source-manifest.json) 公開各相對路徑的 SHA-256，使用目前 checkout 原始 bytes，沒有正規化換行。這是測試時包含尚未 commit 修正的 working bytes；`headAtVerification` 保留實際當時的 `5ffb7d6…`，不回填交付 commit。它不是 native／Student artifact build manifest。

初版 [smoke summary](docs/review-evidence/phase16f-pass-b-preparation/smoke-summary.json) 保持不變。其 124 Node tests、Rust fmt/check/clippy、9 PASS／1 ignored、兩人真實 loopback 22 gates PASS 均為 previous results。當時 tested HEAD 為原 task base，source digest 為 `2af1b310…`；固定 PR head 的 16 個變更 source hashes 相符，但完整 review checkout digest 不同，沒有原完整 Windows manifest，尚不能確認原因。

Phase 16E COMPLETE。PR #1 的 A＋A2 已由 merge commit `d7b97d22e030fd51db55f1f61ad83c0f73987aa7` 整合；PR #2 已由 `7db4493…` 整合。詳細 previous results 見 [A2 evidence](docs/review-evidence/phase16f-pass-a-a2/README.md) 與[歷史交接](docs/handoff/phase16f-after-pr1.md)。本次沒有重跑完整 A2 workloads 或 repo broad suites。

## 剩餘 gates 與停止點

| Gate | 本輪狀態 |
| --- | --- |
| 新 runner source／targeted Node regressions | IMPLEMENTED／138 PASS；獨立 working-diff audit 無剩餘 finding，不等於新 commit 固定 head approval |
| 修正後 Windows artifacts／兩人 native loopback | NOT_EXECUTED；須以新 source 重新 build、保存實際 evidence，不能使用舊 manifest |
| 新 commit 的固定 head review | 待人工 push 至同一 Draft PR 後複審 |
| Production plan／usage／Worker／Student deployment identity | UNKNOWN；未執行 production 管理或負載操作 |
| Bindings／vars／rollback candidate／maintenance window | 待 operator 核對 |
| Shared NAT／local admission／global quota／roster-bearer identity／revocation exposure | 風險接受未決，單班規模不等於已接受 |
| Production deployment／verification | NOT_EXECUTED；另需明確授權 |
| WAN／真實手機 render／final RC／installed Human QA | NOT_EXECUTED |
| Phase 16F release／Pass C | HOLD／NOT_STARTED |

交付前核對 `git status --short`、`git diff --check`、`git diff --stat`、文件相對連結、source manifest 與原歷史 evidence 未修改。Main／origin/main 保持 `7db4493…`；本次不 push、修改 GitHub PR 或 merge，由使用者人工處理後續 **Create a merge commit**。

SSH key／passphrase、remote、deployment、production D1、installer 與方案設定均未變更。完成 local commit 後停止；Windows 待補驗證及新的固定 head review 完成前，不宣稱 preparation 整合驗證已全部通過。
