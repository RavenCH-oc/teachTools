# Phase 16F Pass A + A2 review evidence

此索引提供完整 branch review 的文件與量測入口。CODE_SNAPSHOT_COMMIT：10d67e32f5f5ec355471cf1d285ee6e82d83e51c；base：c5285196a08e412732eb2246efd78e3c9644d15a。[目前狀態](../../../status.md)。所有量測都是既有本機 synthetic 結果；本次沒有重跑測試、production verification 或 installed QA。Phase 16F release 仍 HOLD。

## Reports and audits

- [Pass A 歷史報告與失敗結論](../../remote-release-verification.md)：保留 early full-run gate 誤判與後續四 PDF FAIL_BLOCKER，不只呈現 PASS。
- [Pass A2 四項修正與 before/after](../../phase16f-pass-a2.md)
- [Relay/security audit](../../phase16f-relay-audit.md)
- [Rust/auth audit](../../phase16f-auth-audit.md)
- [A2 admission、安全與工具邊界](../../phase16f-a2-security-evidence.md)
- [成本模型／release 缺口](../../phase16f-cost-and-release.md)：模型不是帳單，本輪未重新查核 Worker version。

## Source identity

- [Final source/harness manifest](source-harness-manifest.json)：374d69fdb0ebabca7be318d401a371ddb8c5c3091675360a48e24bf195b7e4e3。
- [Workload source manifest](workload-source-manifest.json)：c5f49db836098af7c9620df80e830b4d811bc3c1e3d60c86cf35b9ebfa245907。
- [Working bytes → committed blobs](source-byte-preservation.json)：27 apps 檔案仍符合 final working-file manifest。Git 只對 capacity-local.safety.test.js 做既有 CRLF→LF 正規化；core.autocrlf 未修改。Committed source blob digest 為 c822369d327be20603971e7256b01c763530a0abe71265384e669d8bd8157185，不取代歷史 working-file digest。
- [Artifact inventory / original 與 export hashes](artifact-manifest.json)：原件保留在 ignored target；每份公開 derivative 的 hash 與原件分開記錄。

Final terminal-reject／native test cleanup guard 在容量 workload 後才加入，只有後續 focused verification，沒有重跑完整容量測試。Direct-after Worker 也早於後續 admission ordering/terminal fix。各 run 使用的 frozen relay identity 見 final manifest；不可用目前 Git HEAD 假造每次歷史測試時點的 commit。

原 manifest 內的 reports hashes 指原始完整 JSON；下列 .selected.json 是欄位選取匯出，不能直接用原 hash 驗證匯出檔。Final manifest 原件與 workload manifest 原件在這裡是 exact-byte copies。Manifest 中 native binary、HTTP bundle、PNG/PDF 的 hash 僅為本機歷史身分：未把那些檔案公開，reviewer 不能僅靠 hash 宣稱已遠端核對其內容。

## Measurement exports

| 證據 | 保留的必要結果 |
| --- | --- |
| [Wrangler before](before-four.selected.json) / [重複失敗](before-four-2.selected.json) | 四條 PDF；40 個 ACK 10 s timeout；兩次 eventual answers 不同，不能解讀為 committed answers 遺失 |
| [Rejected diagnostic candidate](no-pipe-wait.selected.json) | 僅移除 pipe waitUntil 仍失敗，沒有合併此候選 |
| [Direct workerd before](direct-before.selected.json) / [after](direct-after.selected.json) | bypass Wrangler proxy 仍重現；ACK p95 改為 375.768 ms |
| [Wrangler after](wrangler-after-four.selected.json) | 40/40 ACK，p95 465.483 ms；四 PDF integrity/MIME PASS；0 非預期 re-auth/offline；presence 40/40；lock/reveal 在四流 active 時完成 |
| [Images 1/4/5/10/20/40](a2-images.selected.json) | 全部 18 gates；保留每次讀取 attempts、status、timing、hash/MIME、raw ACK、最終 counters；40 clients 最慢 12.739 s |
| [Generation interruption / cancel](a2-recovery.selected.json) | 舊 HTTP INTERRUPTED；40 clients 約 2.774 s 恢復；後續 ACK/cancel/replacement 與資源歸零 |
| [Native memory samples](after-native-memory.json) | 約 2 s sampling；peak working set 423.219 MiB，不是 DO／browser RAM |

.selected.json 保留所有 observations 與其數值，只省略 native/nativeBefore/nativeAfter 的 requests/timeline，以及 transportEvents。每份檔案列出 omittedPaths；原始 request UUID/event traces 留本機。Native memory export 另將 152 個 CRLF 正規化成 LF，JSON values 不變；其 original/export hashes 分開記錄。沒有重算數值、刪除失敗、改門檻或把 timeout 寫成實際 latency。Derived exports 與本機原件逐欄核對；original/export SHA-256 分開保存。

四 PDF（各 100 MiB）after 最大 56.102 s，aggregate raw throughput 約 7.13 MiB/s，低於 before 約 8.06 MiB/s；這是控制延遲與 bulk throughput 的取捨，不是 WAN 速度提升。所有數據來自同一 Windows PC 的 loopback、native debug/test binary 與 protocol clients，不是 mobile render、installed build 或 classroom-scale acceptance。

## Incremental security/scheduling patch

[security-scheduling.patch](security-scheduling.patch) 是「**Pass A → A2 的歷史增量；完整 review scope 以 PR diff 為準。**」不得用六檔 patch 重建或取代本次完整 33 檔 code snapshot。

本機原件 hash：1d6997ab52fdd4d4d7170ac3aba053793d261b7a088943eb66b00ac50488927b。公開檔是 review-only derivative：換行統一 LF，去掉 9 個空白 context 行的單一 space，避免 patch 文件本身產生 whitespace check 警告。沒有改動非空內容或 hunk；git apply --numstat 對原件／匯出給出相同六檔統計（沒有實際 apply）。匯出 hash 見 artifact-manifest，不宣稱 bytes 與原件相同。

## Verification provenance

Previous PASS 與本輪 packaging checks 分開記錄。歷史報告保留 Pass A 實際命令，例如從 apps/relay 執行：

~~~text
node --test src/phase16f-security.test.js src/http_relay.test.js src/lifecycle.test.js scripts/activation-create-prod.test.js
~~~

當時 49 PASS；root 的 node --test apps/relay/scripts/capacity-local.safety.test.js 為 14 PASS。Student 歷史命令：

~~~text
pnpm --filter @classtools/student exec vitest run src/services/studentHttpApi.test.ts src/services/remoteStudentApi.test.ts src/RemoteApp.test.tsx
~~~

當時 47 PASS。Pass A native filters/results 見歷史報告，不能把 A2 新增測試數倒填到較早來源。

A2 報告保存 90 Node / 18 Rust / 20 Student PASS 與 fmt/check/clippy PASS，但完整 literal shell invocation logs 未公開保存。以下僅列對應的重現 targets，**不是本輪執行紀錄，也不冒稱逐字核實原命令**：

~~~text
# cwd: apps/relay
node --test src/admission.test.js src/phase16f-security.test.js src/http_relay.test.js src/lifecycle.test.js src/a2-http-quota.test.js src/a2-reauth.test.js src/a2-scheduling.test.js scripts/capacity-local.safety.test.js scripts/capacity-local-server.test.js
# Rust targets: application::remote_participant::tests (9), application::remote_http::tests (6)
# Control targets: remote_create_opens_roster_lobby_without_starting_lan_listener,
# validates_teacher_attach, local_relay_and_windows_credential_lifecycle (3)
# Student targets: src/RemoteApp.test.tsx + src/services/remoteStudentApi.test.ts (20)
~~~

本輪只做 source preservation/hash、JSON parse/欄位對照、相對連結、secret/artifact、staged/committed scope、git diff --check。沒有 broad suite、workload、build 或 GUI QA。

## Availability and stop point

本目錄包含可隨 branch push 後在 GitHub 閱讀的小型 evidence；截至本次保存任務，push／Draft PR 仍被部署副作用確認與 SSH 存取阻擋。未把本機檔案已準備好寫成已遠端公開。

未公開：完整 native/request/event traces、console logs、原始大型量測 JSON、原生 test binary、Student bundle、PNG/PDF fixture、完整本機安全快照。它們保留原位且未覆寫／刪除；repo 不包含任何 DB、Wrangler state、Credential Manager export、.dev.vars、真實 code/token 或 production domain payload。沒有用 hash 取代缺少的遠端證據驗證。

Cloudflare Workers Builds／Pages Git settings 仍 UNKNOWN；詳見 root status。沒有 production 動作。停在完整 branch review 準備，不啟動 Pass B/C 或交接文件。

[本輪唯讀部署副作用查核](deployment-side-effects.json)：UNKNOWN，未 push／建立 PR。
