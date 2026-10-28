# Current status — Phase 16F Pass B artifact refresh

- 日期：2026-10-28（Asia/Taipei）；branch：`codex/phase16f-pass-b-artifact-refresh`。
- 使用者已人工合併 PR #3；本輪 base／實際 build 與 smoke 的 testedHead：`330b93ee1c7f86b01fddc5d6899bf6eed5d2676a`。起始 main／origin/main 相同，working tree clean；歷史 taskBase 保持 `7db449392ed741ab1df1b15e3cb67f02c730392f`。
- **ARTIFACT_REFRESH_PASS / TWO_STUDENT_LOOPBACK_PASS**；完成本輪文件後建立一個 local commit，交由使用者人工 push／建立 Draft PR，再依固定 head SHA 審查。
- Pilot：1 Teacher／1 classroom／最多 30 Students；本輪唯一 smoke 僅 **2 Students、1／2 media readers**。
- Production／deployment／installer／final RC／installed QA **NOT_EXECUTED**；release **HOLD**、Pass C **NOT_STARTED**。

## 本輪結果

因 checkout 八檔 CRLF／LF raw bytes 與舊 manifest 不同而 refresh；未修改 source、tests、dependencies、lockfiles、Wrangler config、migrations、換行設定或 runner 契約。舊 artifacts／manifest／evidence 全部保留。詳見 [本輪 evidence](docs/review-evidence/phase16f-pass-b-artifact-refresh/README.md)、[verification](docs/review-evidence/phase16f-pass-b-artifact-refresh/verification.json) 與 [完整 source manifest](docs/review-evidence/phase16f-pass-b-artifact-refresh/source-manifest.json)。

- 實際 build：20:34:14–20:34:25（Asia/Taipei），一次、exit 0。新 build UUID：`3fa348da-b4af-4631-9b1d-cde837cecf37`。
- 247 筆完整 source records／raw digest 在 before、manifest、after-build、after-smoke 一致：`49b1da1ad0cd6f57ecb0908b32f7f61ee49cbf5a8bf639bd01bffa741a0b761e`。三 artifacts hashes 與既有 readBuildManifest() 核對 PASS。
- 唯一兩人 loopback smoke：20:35:38–20:35:44，exit 0；run `0b7bd155-a537-4020-99c9-c8b97f7df669`；**22/22 gates PASS**、runner elapsed **6372.1358 ms**。
- 六類 owned resources cleanup 均 CONFIRMED_CLEANED，unresolved 空、ledger persistence confirmed；owned native app data 不存在，active readers／media／credit waiters 全為 0。
- Raw reserved **13,093,802 bytes**、Teacher UTF-8 reserved **17,574,852 bytes**；沒有 budget stop 或 denied-before-send，非平台計費數。
- Generation：STREAM_INTERRUPTED；first byte 2245.1714 ≤ trigger 2245.2632 ≤ interruption 2277.7725 ms，歸因僅 TEMPORAL_CORRELATION_ONLY。
- Build／smoke 無失敗、無重試。Build 內 cargo test --lib --no-run 僅編譯，不是 Rust runtime tests；Vite 僅建 Student HTTP library，沒有建 browser dist-remote。

原 binary、fixture、logs、report、ledger 與 build manifest 留在 ignored target。公開 evidence 保存必要摘要、247 source hashes 與原件 hashes；文件 commit 不倒填 testedHead。架構與 dependencies 無變更。

## 歷史與待完成事項

[歷史 Windows verification](docs/review-evidence/phase16f-pass-b-preparation/windows-review-fixes.md) 的 138 Node／9 native tests／22 smoke gates 屬於 `843aeab7…`；本輪沒有重跑這些 tests、A2、broad suite、30 人容量或 WAN／手機驗證。舊 evidence 未改寫。

2026-10-28 19:22–19:38 的歷史 live 盤點曾確認正常 OAuth、active `13424a84-25a3-409d-a0b6-1371f6b270d4` 100%、bindings 與 D1 schema；本輪沒有重新查詢 Cloudflare 或 production。該 active 是未來部署的優先 rollback 候選，相容性仍待部署準備審查；更早 `613f3f40…` 不代替此候選。

Billing／Builds／來源映射、rollback readiness、五項 riskAcceptance 與 maintenance window 仍未完成。歷史公開 Student browser bundle 缺少 main 的 bounded 429 retry，差異尚未解決；runner library 與 browser dist-remote 是不同產物。後續 deployment 與單次 production verification 均需另行授權，見 [runbook](docs/phase16f-pass-b-preparation.md)。

只提交本輪五檔 allowlist；不 push、不建立或修改 PR、不 merge。完成 local commit 後停止。
