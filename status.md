# Current status — Phase 16F Pass B preparation

- 日期：2026-10-27（Asia/Taipei）；repository：RavenCH-oc/teachTools。
- Task base／測試時 HEAD：`7db449392ed741ab1df1b15e3cb67f02c730392f`；branch：`codex/phase16f-pass-b-preparation`。
- **PREPARATION_IMPLEMENTED / LOCAL_TARGETED_VERIFICATION_PASS**；等待人工 push、Draft PR 與固定 head SHA 審查。
- Pilot／runner：**1 Teacher／1 classroom／預設與最大 30 Students**；media readers 階梯 `1／4／5／10／20／30`。產品既有上限不變。
- Production execution **NOT_EXECUTED**；final RC／installed Human QA **NOT_EXECUTED**；Phase 16F release **HOLD**。

## 實作與安全邊界

獨立 Node supervisor／safety／ledger／adapters／process／Student workload 與 preparation build helper，接到新的 Windows ignored native test entry。Teacher 使用真實 Rust domain/application services；Student 使用實際 `studentHttpApi.ts` Vite bundle，保留既有 bounded retry。詳見 [Pass B runbook](docs/phase16f-pass-b-preparation.md)。

預設入口只輸出 plan。未來 production entry 要求另外明確授權，綁定 canonical target、source／native／Worker／Student bundle／fixture 身分及風險接受；本輪僅以 mocks 驗證 production adapter。Loopback 是固定獨立 adapter，沒有任意 URL override。

`remote_control.rs` 只抽出共用 URL／連線步驟，並增加 `cfg(test, windows)` 的 per-run credential／trusted-effect seam；budget hooks 與新 native entry 只在測試使用。新增 bounded stdin reader thread 與測試用同步狀態，用於 pipe/deadline 與 transport teardown；沒有新增 production runtime、dependency、migration 或 protocol。既有 local-only harness／guards、A2 evidence／manifests、Worker／Student runtime 均未修改。

每輪使用隔離 credential target 與 synthetic app data。Native send 前 enforce raw ≤1 GiB、Teacher UTF-8 frames ≤2 GiB；整輪含 setup ≤30 分鐘、保留 2 分鐘 cleanup，reconnect 不重設預算。這些不是帳單 hard cap。

Ledger 在 effects 前持久保存 intent，只接受可信 exact IDs；close 精確 Session 後才 revoke 精確 installation，revoke 保留 registry row。Enroll／create response 遺失記 `EFFECT_UNKNOWN`，不重試、不猜 ID、不掃描 ACTIVE rows；無法定位仍報 `CLEANUP_INCOMPLETE`。Ledger 寫入失敗後禁止後續 remote effects，但獨立 finally 仍處理 owned 本機資源；child 必須 `close` 才確認退出。Workload PASS 不足以讓 cleanup 未完成的 run 成為 PASS。

## 本輪實際驗證

以下 Node command 在 repository root 執行，**124/124 PASS**，含新 runner focused regressions 與既有 local-only guards；不是完整 A2 workload 或 repo broad suite：

```powershell
node --test apps/relay/scripts/pass-b-safety.test.js apps/relay/scripts/pass-b-ledger.test.js apps/relay/scripts/pass-b-supervisor.test.js apps/relay/scripts/pass-b-adapters.test.js apps/relay/scripts/pass-b-process.test.js apps/relay/scripts/pass-b-workload.test.js apps/relay/scripts/capacity-local.safety.test.js apps/relay/scripts/capacity-local-server.test.js
```

涵蓋 default/import 無 effects、target／effective URL／redirect、31 人／多 Teacher／class 拒絕、30 人階梯、artifact mismatch／path escape／junction、deadline、child／pending controls、response loss／exact ownership、close-before-revoke、cleanup error 與 ledger persistence failure。30 人完整排程在 mock workload 驗證；實際 native smoke 只用 2 人。

在 `apps/teacher/src-tauri` 實際執行：

```powershell
cargo fmt --check
cargo check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --lib pass_b -- --test-threads=1
```

前三項 PASS；focused tests **9 PASS、1 ignored、134 filtered**。Ignored 項是明確 opt-in runner，後續由 supervisor 啟動執行。初次 sandbox credential lookup 曾失敗，使用本機 Windows OS 權限執行隔離 target regression 後通過；junction regression 初次 sandbox EPERM 後也以本機權限通過。未把這些初次失敗抹為從未發生。Cargo 的 I: incremental hard-link 不支援而改用 copy warning 不影響結果。

實際 artifact build、預設 plan 與最終整合 smoke：

```powershell
node apps/relay/scripts/pass-b-build.js
node apps/relay/scripts/pass-b.js
node apps/relay/scripts/pass-b.js loopback-smoke --manifest apps/teacher/src-tauri/target/phase16f-pass-b-build/45feb21a-36e1-48e9-aec3-1a4533a653fc/build-manifest.json --students 2
```

- Build PASS：實際 Student HTTP bundle、native test executable、2,094,909-byte synthetic PNG；build 前後 source 一致。Plan 顯示 30 人與完整階梯，無 production effects。
- 最終 run：`dd3af874-c2cb-4354-94cb-6ac6af956a58`；約 6.001 秒；**22 gates PASS**、runner/workload 完成、ledger persistence confirmed、六類 resources cleanup 全部 `CONFIRMED_CLEANED`、unresolved 為空。
- 2 人先在 LOBBY join／AUTH／sync，media readers 為 `1／2`；確有 first-byte 後 active-body overlap、authoritative answer count、detail／presence、lock/reveal、cancel release、generation interruption 與重新 AUTH／sync。
- 最終 native active readers／media／credit waiters 都為 0；raw reserved **13,093,802 bytes**、Teacher UTF-8 reserved **17,576,201 bytes**，無 budget stop／denied-before-send。預留數不是平台計費數。
- Source digest：`2af1b310275f49d6fb609056c90e679684104fe7d0d7b2fbe30bd4fc40c00b7f`。新的 [smoke summary](docs/review-evidence/phase16f-pass-b-preparation/smoke-summary.json)保存 16 個變動 source hashes、native／bundle／fixture、toolchain、gates／cleanup 及原件 hash／本機位置。原件仍在 ignored target，未宣稱 reviewer 已取得原件。
- 較早開發 smoke `abcaa763-56f6-421f-9638-b9837e5b900f` 亦 PASS，但後來加入清理邊界修正；它保持原樣，不作最終 source 證據。最終 run 未用之後的 commit SHA 回填 testedHead。

## 已整合基線與 previous results

[PR #1](https://github.com/RavenCH-oc/teachTools/pull/1) 的 Pass A＋A2 已以 merge commit `d7b97d22e030fd51db55f1f61ad83c0f73987aa7` 整合，reviewed head 為 `3712333e05cdeb8ee6aa03e681881fe14ab85caa`。[PR #2](https://github.com/RavenCH-oc/teachTools/pull/2) 的 docs-only 交接已以 merge commit `7db449392ed741ab1df1b15e3cb67f02c730392f` 整合。Phase 16E COMPLETE；歷史 production／Human QA PASS 不等於 Phase 16F production 已驗證。

Previous A2 focused tests、40-image／四 PDF workloads 與 prior-chat static review 保持原紀錄，本輪未重跑完整歷史實驗。詳細來源、before FAIL／after PASS、source/workload 身分差異與限制見 [A2 evidence index](docs/review-evidence/phase16f-pass-a-a2/README.md)、[A2 report](docs/phase16f-pass-a2.md)、[歷史交接](docs/handoff/phase16f-after-pr1.md)。舊文件的 uncommitted／local-only／未 push 敘述按當時快照閱讀。

## 剩餘 gates 與停止點

| Gate | 本輪狀態 |
| --- | --- |
| Runner 固定 head review | 待人工 push／Draft PR；本機檢查不等於獨立 review approval |
| Production plan／usage／Worker version／Student deployment identity | UNKNOWN；未讀 production D1／帳務，未執行 Wrangler --remote |
| Bindings／vars／rollback candidate／maintenance window | 待 operator 核對 |
| Shared NAT／local admission／global quota／roster-bearer identity／revocation exposure | 風險接受未決；試用規模不代表已接受 |
| Phase 16F production deployment／verification | NOT_EXECUTED；需另行明確授權 |
| 真實手機 render／WAN／final RC／installed Human QA | NOT_EXECUTED |
| Phase 16F release／Pass C | HOLD／NOT_STARTED |

本輪文件檢查包含相對路徑／anchors、claims／SHA／test labels、summary 對照原件與 source/artifact hashes、public evidence 無 credential／exact operational ID、變更 allowlist、generated artifacts 排除及 staged diff／`git diff --check`。Git preflight 確認 main／origin/main／HEAD 均為 task base、working tree clean，並唯讀核對 GitHub main 與 PR #2 metadata；交付只建立一個 local commit，main／origin/main 保持基線。

沒有新增 dependency。未 push／建立 PR／merge／production／deploy／installer／Pass C。SSH key／passphrase／github-work alias／origin 未變更；先前人工 SSH push 成功仍屬 USER_CONFIRMED，不代表已診斷 Codex 非互動 SSH 問題。Cloudflare Dashboard 未連 GitHub 為使用者先前回報，本輪未 live 重查。歷史五位 Teacher 成本模型不是單班實際帳單。

完成 local commit 後停止；人工 push／Draft PR 與固定 head 審查後，仍須另外授權 production 操作。
