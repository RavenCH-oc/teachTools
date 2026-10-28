# Phase 16F Pass B — Windows review-fix verification

日期：2026-10-28（Asia/Taipei）。本輪為已匯入修正的 Windows 本機驗證；production **NOT_EXECUTED**、release **HOLD**。

## 起點與範圍

- Branch：`codex/phase16f-pass-b-preparation`。
- 實際 tested HEAD／本輪起點：`843aeab7d3a56aaaa427fcab7d5c5c64e6703f95`；開始時 working tree clean。
- 原 task base／main：`7db449392ed741ab1df1b15e3cb67f02c730392f`。修正已存在，沒有再次套用 bundle、退回基線或改寫 source。
- 1 Teacher／1 classroom／最多 30 Students；本輪真實整合 smoke **2 人**、media readers `1／2`。30 人階梯仍只由 mock 排程驗證。
- [PR #3](https://github.com/RavenCH-oc/teachTools/pull/3) 沿用既有 Draft；沒有 push、修改 PR 或 merge。

## 實際驗證

完整命令、exit code、時間、原始 logs／report hashes、artifact 身分、各 gates 與 cleanup 見 [verification JSON](windows-review-fixes-verification.json)。原件保存於 ignored target，公開檔案是可審查的摘要，不宣稱 reviewer 已取得本機原件。

| 檢查 | 本輪結果 |
| --- | --- |
| Windows targeted Node：原八檔、single-process TAP | 138/138 PASS；完整 `1..138` 與 totals；stderr 空 |
| `cargo fmt --check` | PASS |
| `cargo check` | PASS |
| `cargo clippy --all-targets --all-features -- -D warnings` | PASS |
| `cargo test --lib pass_b -- --test-threads=1` | 9 PASS、1 ignored、134 filtered；隔離 Credential Manager regression 通過 |
| `node apps/relay/scripts/pass-b.js` | Plan PASS，無 effects；30 人完整階梯 |
| `node apps/relay/scripts/pass-b-build.js` | PASS；新的 build manifest，build 前後 source 一致 |
| 兩人真實 Rust＋實際 Student bundle loopback | 首次且唯一一次執行 PASS；22 gates PASS；cleanup confirmed |

新 build manifest：`apps/teacher/src-tauri/target/phase16f-pass-b-build/1e45243e-5919-4fe9-a534-d28edee99369/build-manifest.json`。實際 smoke 命令：

```powershell
node apps/relay/scripts/pass-b.js loopback-smoke --manifest apps/teacher/src-tauri/target/phase16f-pass-b-build/1e45243e-5919-4fe9-a534-d28edee99369/build-manifest.json --students 2
```

Run ID：`d54a9e70-cd76-4ff3-9e3a-ee35421f9c15`；elapsed **6463.9508 ms**。Native／Student source 未變的部分可能產生相同 artifact hash；本輪仍實際執行 build command，建立新的 manifest／artifact 目錄與 PNG fixture，沒有用舊 manifest 代替。

## 修正後的實測判讀

以下時序均相對 workload 起點，單位 ms；control timestamp 現在不再等到 media 完成：

| Media readers | Probe 開始 | Control 完成 | Media 完成 |
| --- | ---: | ---: | ---: |
| 1 | 484.9381 | 530.3678 | 734.6976 |
| 2 | 917.9322 | 971.5494 | 1225.3903／1281.3713 |

兩階段 probe 開始時各有 1 個 active body；2 位 participants 已先於 LOBBY 完成 join／AUTH／personalized sync。讀取階梯不是 socket admission 階梯。

Generation：first byte **2214.3708** ≤ reconnect trigger **2214.4551** ≤ interruption **2246.6038**；舊流讀取 262144 bytes 後記為 `INTERRUPTED`／`STREAM_INTERRUPTED`，重新 AUTH＋sync 於 **4315.0093** 完成。`interruptionObservedAfterTrigger: true`，只支持 **TEMPORAL_CORRELATION_ONLY**，不聲稱 server 已證實因果。自身 deadline、run abort、size guard 均未被當作這次 interruption 的原因；沒有 replay／跨 generation 拼接。

正常 reads 為 `COMPLETED`，主動取消為 `CALLER_CANCELLED`。Run-abort negative path 與 unknown provisioning／缺少 production run ID 的拒絕由 focused mocks 驗證，不以成功 smoke 代替這些負面 cases，也沒有執行 production adapter。

六類 ledger resources 均 `CONFIRMED_CLEANED`；unresolved 為空、ledger persistence confirmed、workload cleanup 完成。本次 owned native app data 已不存在；native readers／media／credit waiters 均為 0。Raw reserved **13,093,802 bytes**、Teacher UTF-8 reserved **17,576,201 bytes**，budget 未停止、denied-before-send 為 0；不是平台計費數。

## Source 與歷史 evidence

[完整 Windows source manifest](windows-review-fixes-source-manifest.json)公開 247 筆實際 working-file SHA-256：

```text
6a01e4c12eedb9e91f3e01d20840d4d073bc4d8a5e44a73c4035307b5c03d830
```

它與本次 build／smoke 的 raw digest 完全相同；`testedHead` 保持 `843aeab7…`，不倒填之後的文件 commit。

與 Linux [review-fix source manifest](pr3-fixes-source-manifest.json)比對：檔名同為 247 筆，212 筆 raw bytes 相同，35 筆差異全部精確屬於 CRLF／LF；Linux 247 筆均符合 `843aeab7…` Git blobs。只在記憶體去除差異檔案 CRLF 中的 CR，digest 才等於 Linux 的 `af0d6cf0…`。這是差異說明，不能替代 Windows raw digest，也沒有改寫 working files 或 Git 設定。

本機找回初版 `45feb…` 原完整 build manifest 後，另將其 247 筆與 Git `5ffb7d6…` 比對：220 筆相同，27 筆換行差異，0 筆未解。25 筆從 Git blob 重建 CRLF 後匹配歷史 hash；另 2 筆 mixed EOL 以仍保留且 hash 相符的 bytes 核對。這解釋先前 Linux review 因未取得完整 manifest 而留下的 digest 疑問，不延伸舊 smoke 的驗證範圍。比較方法、每筆 hash 與限制保存在新 source manifest；[舊 smoke](smoke-summary.json)及 [Linux 修正證據](pr3-fixes.md)全部保持原樣。

## 失敗紀錄與停止點

本輪 build／tests／smoke **沒有失敗、沒有重試**，`failureRecords: []`。保留每項完整輸出與 exit code；唯一環境警告為 I: incremental cache 無法 hard-link、改用 copy，相關命令仍 exit 0。先前 sandbox／Linux reporter／run-abort development failure 仍留於原歷史文件，沒有以本次 PASS 覆蓋。

沒有 source／runtime／dependency 變更，沒有重跑完整 A2。Production、部署、production D1、production load、installer、final RC、installed Human QA、WAN／真實手機 render 均未執行；Pass C 未開始。Production plan／usage／版本／維護窗與風險接受仍待確認，release **HOLD**。完成本地 evidence commit 後停止，由使用者人工 push 至同一 Draft PR，依新 head 複審。
