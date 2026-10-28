# Phase 16F Pass B — PR #3 review fixes

日期：2026-10-28（Asia/Taipei）。

## 來源與範圍

- Repository：`RavenCH-oc/teachTools`。
- 已合併 main／原 task base：`7db449392ed741ab1df1b15e3cb67f02c730392f`。
- 本次增量修正起點／測試時 committed HEAD：`5ffb7d6e4a339b523d135115d764c78eb4a84971`。
- Task branch：`codex/phase16f-pass-b-preparation`；[PR #3](https://github.com/RavenCH-oc/teachTools/pull/3) 已為 Draft，未合併。
- Scope：1 Teacher、1 classroom、最多 30 synthetic Students；production **NOT_EXECUTED**，release **HOLD**。

這份證據記錄 PR #3 固定 head 審查之後的 Node runner 增量修正。測試執行時 changes 尚未 commit；完整 working bytes 由 [source snapshot](pr3-fixes-source-manifest.json) 綁定，不能用之後的交付 commit SHA 回填 `headAtVerification`。

## 修正與必要 regressions

| Finding | 修正行為 | 必須觀察的 regression |
| --- | --- | --- |
| Production authorization 缺少／null runId 仍接受 | 明確 UUID 字串必填；授權核對不補產生 ID | 無效身分在 effects 前拒絕；合法授權身分固定，既有 run directory 仍拒絕重用 |
| Unknown INSERT 後 DELETE 0 rows 誤報清理成功 | Cleanup 開始時保存 creation ordering uncertainty；best-effort exact DELETE 不消除未知狀態 | DELETE 已完成後才到達的 INSERT／confirmation 不能造成 `CONFIRMED_CLEANED`；已確認 creation 的正常 cleanup 保持可確認 |
| Client timeout 誤算 generation interruption | Read 保留 sanitized 結束原因；自己的 deadline／abort／guard 不滿足該 gate | Re-auth 成功、舊 HTTP 只在 client timeout 結束時，product gates 不得 PASS；真正的觀察路徑與 fast-complete `NOT_OBSERVED` 仍有覆蓋 |
| Control completion timestamp 等了 media | Control probes 與 media 分別記錄完成時間 | Media 較慢時不延後 `controlCompletedAtMs` |

修改範圍限 Node runner／tests、runbook、status 與新的 source／verification evidence。沒有修改 Rust、Worker、Student runtime、D1 schema、既有 A2 harness 或 dependencies。

## 本次驗證

最終 targeted Node 結果為 **138/138 PASS，0 failed／cancelled／skipped／todo**。實際命令、執行環境、結果與未執行項目見 [verification summary](pr3-fixes-verification.json) 及根目錄 [status.md](../../../status.md)。依 repository 原本的 `pnpm@9.15.0` 與 lockfile 安裝既有 dependencies，使用 `--frozen-lockfile --ignore-scripts --filter @classtools/relay`；package manifests／lockfile 保持不變。

Targeted Node command：

```sh
node --test --test-isolation=none --test-concurrency=1 --test-reporter=tap apps/relay/scripts/pass-b-safety.test.js apps/relay/scripts/pass-b-ledger.test.js apps/relay/scripts/pass-b-supervisor.test.js apps/relay/scripts/pass-b-adapters.test.js apps/relay/scripts/pass-b-process.test.js apps/relay/scripts/pass-b-workload.test.js apps/relay/scripts/capacity-local.safety.test.js apps/relay/scripts/capacity-local-server.test.js
```

這組測試使用 controlled temporary files 與 native／HTTP／WebSocket／D1 mocks。它涵蓋 30 人排程及錯誤分支，不是 30 人 native integration、WAN 或 production capacity 驗收。既有 local-only guards 與完整 A2 workload 分開；本次不重跑 A2 broad workload。

## Source identity 與舊 smoke 的界線

[pr3-fixes-source-manifest.json](pr3-fixes-source-manifest.json) 使用現有 `pass-b-build.js` 的 `sourceIdentity()`，只讀取 source，沒有呼叫 `buildArtifacts()`。公開每個相對路徑的 SHA-256 與整體 digest，使用目前 checkout 原始 bytes；沒有 credentials、operational IDs 或本機絕對路徑。Docs 不在 source snapshot 的範圍內，因此不會自我引用。

初版 [smoke-summary.json](smoke-summary.json) 保持原樣：它是兩人 Windows native／Student bundle loopback 的歷史證據，當時 tested HEAD 為 task base，包含尚未 commit 的初版 source。固定 `5ffb7d6…` 的 16 個變更 source hashes 與該 summary 一致，但完整 review checkout digest 與歷史 Windows working bytes digest 不同。原完整 Windows manifest 未公開，尚不能確定差異原因；沒有把差異直接認定為 CRLF，也沒有補造歷史 manifest。

本次 source-only snapshot 不能替代 native binary／Student bundle build manifest。初版的 124 Node tests、Rust checks、9 PASS／1 ignored 及 22 smoke gates 都是 previous results，不能套用為修正後版本已通過相同整合驗證。

## Windows 待補驗證與交付停止點

目前執行環境為 Linux，沒有 Rust toolchain 或 Windows Credential Manager，修正後的 native artifact build 與真實兩人 loopback smoke **NOT_EXECUTED**。請在本機 Windows 工作區套用本次修正後，以目前 source 重新產生 artifacts；不要使用不符合新 source digest 的舊 manifest。

```powershell
node apps/relay/scripts/pass-b-build.js
node apps/relay/scripts/pass-b.js
node apps/relay/scripts/pass-b.js loopback-smoke --manifest <new-build-manifest-path> --students 2
```

新增 smoke evidence 時保留完整 source-file hashes、native／Student bundle／fixture identity、actual tested HEAD 與 working bytes 說明，以及實際 gates／cleanup 結果。若新增 evidence commit，固定 head review 必須以新的 SHA 為準。

本次只建立 local commit，不 push、不改 PR、不 merge。由使用者人工 push 到同一 Draft PR，再做固定 head 複審並人工 **Create a merge commit**。新的 production 操作仍需另外授權；final RC、installed Human QA 與 Pass C 不在本次範圍。
