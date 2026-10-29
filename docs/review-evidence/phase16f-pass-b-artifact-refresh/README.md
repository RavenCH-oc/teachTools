# Phase 16F Pass B — Artifact refresh and Windows loopback

日期：2026-10-28（Asia/Taipei）。本輪 **ARTIFACT_REFRESH_PASS / TWO_STUDENT_LOOPBACK_PASS**；production **NOT_EXECUTED**、release **HOLD**、Pass C **NOT_STARTED**。

## 基線與範圍

- 使用者已人工合併 PR #3。本輪 branch：`codex/phase16f-pass-b-artifact-refresh`。
- Base／實際建置與 smoke 的 `testedHead`：`330b93ee1c7f86b01fddc5d6899bf6eed5d2676a`；起始 main／origin/main 相同，working tree clean。
- 既有 `taskBase` 契約保持 `7db449392ed741ab1df1b15e3cb67f02c730392f`。之後的文件 commit SHA 不倒填 `testedHead`。
- Pilot 維持 1 Teacher／1 classroom／最多 30 Students；本輪唯一一次 smoke 僅 **2 Students、1／2 media readers**。
- 僅更新指定文件與新 evidence，未修改 source、tests、dependencies、lockfiles、Wrangler config、migrations、Git 換行設定或 runner 契約。

舊 artifacts 的 hashes 符合原 manifest，但先前盤點發現目前 checkout 八檔 CRLF／LF raw bytes 不同，因而得到 `SOURCE_IDENTITY_MISMATCH`。本輪直接依目前 bytes 建立新 UUID artifacts／manifest，沒有修改換行配合舊 manifest，也未覆寫舊 evidence。

## 本輪實際驗證

完整命令、UTC 起迄、exit codes、工具版本、所有 gates 與原件 hashes 見 [verification.json](verification.json)；247 筆完整 raw source hashes 見 [source-manifest.json](source-manifest.json)。

| 項目 | 實際結果 |
| --- | --- |
| Node／pnpm／Wrangler | v24.19.0／9.15.0／4.141.0；本輪實際查版本，未呼叫 Cloudflare API |
| cargo／rustc | cargo 1.97.1 (c980f4866 2026-06-30)／rustc 1.97.1 (8bab26f4f 2026-07-14) |
| Build | 20:34:14–20:34:25（Asia/Taipei），exit 0，唯一一次 |
| Source identity | before／manifest／after-build／after-smoke 的 digest 與完整 247 筆清單一致 |
| Manifest reader／三 artifacts | 既有 `readBuildManifest()` PASS；實際 hashes、fixture bytes 與新 manifest 相符 |
| 兩人 loopback smoke | 20:35:38–20:35:44，exit 0，唯一一次；22/22 gates PASS |
| Cleanup | 六類 resources `CONFIRMED_CLEANED`；unresolved 空，ledger persistence confirmed |

實際 entry：

```powershell
node apps/relay/scripts/pass-b-build.js
node apps/relay/scripts/pass-b.js loopback-smoke --manifest apps/teacher/src-tauri/target/phase16f-pass-b-build/3fa348da-b4af-4631-9b1d-cde837cecf37/build-manifest.json --students 2
```

Build entry 內的 `cargo test --lib --no-run --message-format=json` 是 native artifact **編譯步驟**，不是 Rust runtime tests。Vite 只建 `student-http-client.mjs` library；沒有建置 browser `dist-remote`。

本輪 raw source digest：

```text
49b1da1ad0cd6f57ecb0908b32f7f61ee49cbf5a8bf639bd01bffa741a0b761e
```

新 manifest：`apps/teacher/src-tauri/target/phase16f-pass-b-build/3fa348da-b4af-4631-9b1d-cde837cecf37/build-manifest.json`；SHA-256：`3fa9e7e7e67c8cac6ae3cde4165db35d1567d431c33d333b313ca6b2de959ea5`。

| Artifact | Bytes | 實際 SHA-256 |
| --- | ---: | --- |
| `teacher-pass-b-test.exe` | 29,455,360 | `d38847ca8e54fc5d1ce394496e41b5ed815d0aaca4addb6821d140888bd82d53` |
| `student-http-client.mjs` | 140,303 | `3d182db18ce6ee238761e0e8bac4b094e73bad9f28a3506f8181b719fd0a487d` |
| `image.png` | 2,094,909 | `54133374f4fd61dbb47f9fe61cfe479d172159188c6b10d9c4a79265e2aebbaa` |

Library hash 與歷史相同不代表搬用舊 manifest：本輪實際執行建置並產生新的 build UUID、manifest 與 fixture。原 binary、fixture、build manifest、entry logs、report 與 ledger 都留在 ignored target；公開摘要不宣稱 reviewer 已取得本機原件。Build entry 不對外保存其內部 cargo JSON／stderr；native 非協定 stdout／stderr 也依既有契約不保留，不能聲稱有完整 child logs。

## 唯一一次 smoke 的結果

Run ID：`0b7bd155-a537-4020-99c9-c8b97f7df669`；runner elapsed **6372.1358 ms**。固定 target `http://127.0.0.1:8794/`，ephemeral relay、synthetic data、每輪隔離 credential；沒有 production adapter 或正式 installation credential 操作。

兩位 participants 在 LOBBY 完成 join／AUTH／personalized sync 後才開始 media-reader 階梯。Text ACK p95 **29.1601 ms**；media ACK p95 分別 **27.1082／21.9860 ms**。每個 gate 的原始名稱與 PASS 保存在 verification JSON，不以此宣稱 30 人、WAN、手機 render 或 installed QA 通過。

| Readers | Probe 開始 ms | Control 完成 ms | Media 完成 ms |
| --- | ---: | ---: | ---: |
| 1 | 463.0222 | 510.9842 | 701.4999 |
| 2 | 904.3054 | 942.4176 | 1278.7718／1325.5240 |

兩個 probe 開始時各有 1 個 active media body。Generation 舊流 first byte **2245.1714** ≤ reconnect trigger **2245.2632** ≤ interruption **2277.7725 ms**；舊流讀取 262144 bytes 後為 `INTERRUPTED`／`STREAM_INTERRUPTED`，AUTH＋sync 於 **4340.3008 ms** 完成。`interruptionObservedAfterTrigger=true`，歸因僅為 **TEMPORAL_CORRELATION_ONLY**，沒有將 client timeout、主動 abort 或 `NOT_OBSERVED` 改寫成成功。

Raw reserved **13,093,802 bytes**、Teacher UTF-8 reserved **17,574,852 bytes**；`budgetStopped=false`、`deniedBeforeSend=0`。1 GiB raw／2 GiB UTF-8、含 setup 的 30 分鐘 deadline／2 分鐘 cleanup reserve 未變；這些不是平台帳單數字。

Activation、installation、session、credential、child、temporaryData 六類 cleanup 均 confirmed；workload cleanup 完成，unresolved 為空，ledger persistence confirmed，owned `native-app-data` 不存在，active readers／media／credit waiters 均為 0。原 report／ledger 路徑與 SHA 留於 verification JSON，公開 resource projection 不包含 exact operational IDs。

本輪 build／smoke 首次通過，`failureRecords: []`、重試 0 次；兩個 entry stderr 均空。沒有第二輪 smoke、沒有放寬 gates 或修改 source。

## 歷史結果與 production 前置事項

[歷史 Windows verification](../phase16f-pass-b-preparation/windows-review-fixes.md) 的 138 Node tests、9 native tests、22 smoke gates 綁定 `843aeab7…`，本輪未重跑；舊 hashes、run ID、manifest、Linux evidence 與 A2 均保留。本輪 22 gates 是上述新 run 的實測結果。

兩份 ignored readiness reports 是 **2026-10-28 特定時間的歷史觀察**，本輪沒有呼叫 Cloudflare 管理 API、production URL 或 D1。19:22–19:38 的成功 snapshots 當時顯示 active `13424a84-25a3-409d-a0b6-1371f6b270d4`、100% traffic，正常 OAuth、bindings 與 D1 schema 已確認；這不冒充本輪重新確認。

依本輪任務，該 active version 是**未來部署的優先 rollback 候選**；source／DO state／D1／assets 相容性仍須部署準備審查。歷史報告的 `613f3f40…` 是當時更早的候選，不混同。Code rollback 不會還原 D1／DO state。

Billing／Builds／來源映射、rollback readiness、五項 riskAcceptance（shared NAT、local admission、global quota、roster/bearer、revocation exposure）與 maintenance window 仍未完成。17:49 公開 Student JS 的歷史 SHA `b4a136c42628ff193bd2d1ec01ba2de1d74983ac8971667825fa4c0fe287e789` 缺少 bounded 429 retry；本輪 library refresh 未解決 production browser 差異，沒有重建或部署 `dist-remote`。

完成 [status](../../../status.md)、[runbook](../../phase16f-pass-b-preparation.md) 與本目錄三份 evidence 的一個 local commit 後停止。由使用者人工 push、建立 Draft PR，再以固定 head SHA 審查。Production、deployment、installer、final RC、installed QA 均未執行，release **HOLD**、Pass C **NOT_STARTED**。
