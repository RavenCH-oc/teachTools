# Current status — Phase 16F Pass B Windows verification

- 日期：2026-10-28（Asia/Taipei）；repository：RavenCH-oc/teachTools。
- Branch：`codex/phase16f-pass-b-preparation`。
- 本輪起點／實際 tested HEAD：`843aeab7d3a56aaaa427fcab7d5c5c64e6703f95`；開始時 working tree clean，review-fix commit 已匯入，沒有再次套用 bundle 或退回基線。
- 原 task base／main／origin/main：`7db449392ed741ab1df1b15e3cb67f02c730392f`。
- **WINDOWS_TARGETED_VERIFICATION_PASS / WINDOWS_NATIVE_LOOPBACK_PASS**；等待人工 push 至同一 [Draft PR #3](https://github.com/RavenCH-oc/teachTools/pull/3) 與新的固定 head SHA 複審。
- Pilot：**1 Teacher／1 classroom／最多 30 Students**；完整 media-reader 階梯 `1／4／5／10／20／30`。本輪真實 smoke 為 **2 人、1／2 readers**，30 人流程僅由 mocks 驗證。
- Production、final RC、installed Human QA **NOT_EXECUTED**；Phase 16F release **HOLD**，Pass C **NOT_STARTED**。

## 本輪範圍與結果

保留已匯入的三項 review findings、control timing 與 run-abort 修正；本輪只補 Windows 本機驗證、更新本檔／[runbook](docs/phase16f-pass-b-preparation.md)，並新增 [Windows evidence](docs/review-evidence/phase16f-pass-b-preparation/windows-review-fixes.md)。沒有修改 source、runtime、dependencies、schema 或既有 evidence。

沿用 Node supervisor、真實 Rust application services、實際 Student HTTP bundle、隔離 per-run Credential Manager target、native pre-send budgets 與 exact-ID ledger cleanup。1 GiB raw／2 GiB Teacher UTF-8、含 setup 的 30 分鐘上限與 2 分鐘 cleanup reserve 不變；不代表帳單 hard cap。

Windows x64、Node v24.19.0；完整命令、時間、exit code、raw logs hashes、gates／cleanup 見 [verification JSON](docs/review-evidence/phase16f-pass-b-preparation/windows-review-fixes-verification.json)。

```powershell
node --test --test-isolation=none --test-concurrency=1 --test-reporter=tap apps/relay/scripts/pass-b-safety.test.js apps/relay/scripts/pass-b-ledger.test.js apps/relay/scripts/pass-b-supervisor.test.js apps/relay/scripts/pass-b-adapters.test.js apps/relay/scripts/pass-b-process.test.js apps/relay/scripts/pass-b-workload.test.js apps/relay/scripts/capacity-local.safety.test.js apps/relay/scripts/capacity-local-server.test.js
```

**138/138 PASS**，0 failed／cancelled／skipped／todo，完整 TAP summary，stderr 空。Production authorization、unknown provisioning ordering、client timeout／run abort 等負面情境使用 mocks；不是 production execution。

在 `apps/teacher/src-tauri` 實際執行以下命令，全部 exit 0：

```powershell
cargo fmt --check
cargo check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --lib pass_b -- --test-threads=1
```

Focused tests **9 PASS、1 ignored、134 filtered**；隔離 Windows Credential Manager regression 通過。Ignored 項為 opt-in native runner，之後由新 smoke supervisor 明確啟動。Rust source 相對 `5ffb7d6…` 未變，但本輪仍實際執行以上 checks；不是搬用舊結果。

在 repository root 實際執行：

```powershell
node apps/relay/scripts/pass-b.js
node apps/relay/scripts/pass-b-build.js
node apps/relay/scripts/pass-b.js loopback-smoke --manifest apps/teacher/src-tauri/target/phase16f-pass-b-build/1e45243e-5919-4fe9-a534-d28edee99369/build-manifest.json --students 2
```

- Default plan PASS：30 人完整階梯、`productionEffects: NONE`、未授權 production。
- 新 native／Student artifacts 與 2,094,909-byte PNG fixture build PASS，使用新 manifest，build 前後 source 相同。
- 新 run：`d54a9e70-cd76-4ff3-9e3a-ee35421f9c15`；**22 gates PASS**，耗時 **6463.9508 ms**，runner／workload 完成。
- Media stage 1：control 完成 530.3678 ms，media 完成 734.6976 ms；stage 2：control 完成 971.5494 ms，media 完成 1225.3903／1281.3713 ms。兩次 probe 均確有 active media；control timestamp 不再等待 media。
- Generation 舊流為 `STREAM_INTERRUPTED`：first byte 2214.3708 ≤ trigger 2214.4551 ≤ interruption 2246.6038 ms；重新 AUTH／sync 完成。只宣稱 **TEMPORAL_CORRELATION_ONLY**，不將 client deadline／abort 或 generic failure 當作 server-attested cause。
- 六類 resources cleanup 均 `CONFIRMED_CLEANED`；unresolved 空，ledger persistence confirmed，Student cleanup 完成，owned native app data 已不存在，active readers／media／credit waiters 全為 0。
- Raw reserved **13,093,802 bytes**、Teacher UTF-8 reserved **17,576,201 bytes**；沒有 budget stop 或 denied-before-send。這些不是平台計費數。

本輪每個 build／test／smoke command 均首次通過，**失敗紀錄為空、重試 0 次**；完整輸出仍保留。僅有 I: incremental cache 無法 hard-link 而改為 copy 的環境警告。先前 Linux／sandbox／development failures 保留於原紀錄，沒有用本次 PASS 覆蓋。

## Source 與歷史身分

新的 [完整 Windows manifest](docs/review-evidence/phase16f-pass-b-preparation/windows-review-fixes-source-manifest.json)包含 247 筆 raw SHA-256，與實際 build／smoke source 相同：

```text
6a01e4c12eedb9e91f3e01d20840d4d073bc4d8a5e44a73c4035307b5c03d830
```

Windows 與 [Linux review-fix snapshot](docs/review-evidence/phase16f-pass-b-preparation/pr3-fixes-source-manifest.json)有 35 筆 raw hash 差異，已逐位元組確認全部是 CRLF／LF，內容與 `843aeab7…` Git blobs 一致；沒有改寫換行，沒有將正規化 digest 當 artifact identity。

本輪也找回初版原完整 Windows build manifest，確認它與 Git `5ffb7d6…` 的 27 筆差異均可由換行解釋，沒有未解差異。新 evidence 記錄核對方法與限制；[舊 smoke summary](docs/review-evidence/phase16f-pass-b-preparation/smoke-summary.json)、[Linux review fixes](docs/review-evidence/phase16f-pass-b-preparation/pr3-fixes.md)及其 verification／source manifests 均保持原樣。舊 `testedHead`／run ID 不回寫；新 evidence 綁定本輪測試時的 `843aeab7…`，不回填之後的文件 commit。

Previous results 分開保留：初版 Windows 124 Node PASS／9 native PASS／22 smoke gates PASS；Linux 修正後 138 Node PASS；本輪 Windows 138 Node PASS／9 native PASS／22 新 smoke gates PASS。Phase 16E COMPLETE，PR #1／#2 已整合；[A2 evidence](docs/review-evidence/phase16f-pass-a-a2/README.md)與完整歷史 workloads 未重跑或改寫。

## 剩餘 gates 與停止點

| Gate | 狀態 |
| --- | --- |
| 修正後 Windows artifacts／兩人 native integration | PASS；新的 source／build／run evidence |
| 新 commit 的固定 head review | 待人工 push 至既有 Draft PR #3 後複審 |
| Production plan／usage／Worker／Student deployment identity | UNKNOWN；未執行 production 管理或負載操作 |
| Bindings／vars／rollback candidate／maintenance window | 待 operator 核對 |
| Shared NAT／local admission／global quota／roster-bearer identity／revocation exposure | 風險接受未決，單班規模不等於已接受 |
| Production deployment／verification | NOT_EXECUTED；仍需另行明確授權 |
| WAN／真實手機 render／installer／final RC／installed Human QA | NOT_EXECUTED |
| Phase 16F release／Pass C | HOLD／NOT_STARTED |

交付前檢查相對連結、claims／SHA、完整 source／artifact hashes、各 gates／cleanup、public evidence、allowlist、歷史 evidence 未修改，以及 `git status --short`／`git diff --check`／`git diff --stat`／staged diff。大型 artifacts、原始 report／ledger／logs 留在 ignored target；公開摘要不包含 credentials 或 exact operational IDs，也不宣稱 reviewer 已取得本機原件。

沒有新增 dependency；未 push／修改 PR／merge、production D1／負載／部署或 installer，SSH key／passphrase／remote 均未變更。完成一個 local evidence commit 後停止，由使用者人工 push 至同一 Draft PR，依新固定 head 複審。
