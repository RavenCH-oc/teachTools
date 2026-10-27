# Phase 16F Pass A — Relay / Operator security audit

**2026-10-26 update:** See [Pass A2 evidence](phase16f-pass-a2.md) and [bounded admission details](phase16f-a2-security-evidence.md) for locally verified remediation. Earlier findings below are preserved as historical audit evidence, not the final A2 disposition.

日期：2026-10-25。Canonical baseline：`c5285196a08e412732eb2246efd78e3c9644d15a`。

此報告限定 Relay / Operator 的 source audit、隔離本機 fault injection 與必要局部修正。整體 release 建議仍為 **HOLD**：公開 admission / sustained resource protection 有未解缺口。本輪未部署、未執行 production load、未寫 production D1、未變更方案，也未執行 final RC / installed Human QA。40 Students 是待驗證目標。

## Isolation and reproduction

新增 `apps/relay/src/phase16f-security.test.js` 使用現有 Wrangler 隨附 Miniflare/workerd，不新增 dependency。每個 fixture 使用隨機名稱、非持久化的本機 D1/DO、loopback ephemeral port，以及固定標記的 synthetic operator token；不讀 `.dev.vars`、不使用 production URL/credentials。D1 僅載入已提交的 schema 至 ephemeral fixture。故障 trigger 僅存在該 fixture，沒有修改 migration。`finally` 關閉 sockets 並 dispose Miniflare。

確定性 await-body 測試只替換 `cloudflare:workers` 的 host base class / import location，執行實際 Worker source；用 deferred `request.json()` 控制交錯順序，不將 Node shim 當完整 Cloudflare runtime。Enrollment / owner-close / ticket concurrency / revocation 則使用真實本機 workerd + D1 + DO。

從 `apps/relay` 執行，未連接主容量測試的 8792 port：

```powershell
node --test src/phase16f-security.test.js src/http_relay.test.js src/lifecycle.test.js scripts/activation-create-prod.test.js
```

結果：**49 / 49 tests PASS**，包含 security 13、HTTP 13、lifecycle 6、Operator 17。security 最後一項是未解漏洞的 reproduction assertion；其 PASS 表示成功重現，不代表對應 security gate 通過。

相同 13 個 security fixtures 的 before/after：

```powershell
$env:PHASE16F_AUDIT_BASELINE = '1'
try {
  node --test src/phase16f-security.test.js
  $taskBaselineExit = $LASTEXITCODE
} finally {
  Remove-Item Env:PHASE16F_AUDIT_BASELINE -ErrorAction SilentlyContinue
}
exit $taskBaselineExit
```

此開關以 `git show <canonical-baseline>:apps/relay/src/worker.js` 載入 baseline source 至 fixture，不改工作樹。Before：**6 PASS / 7 FAIL，exit 1**；after：**13 PASS / 0 FAIL，exit 0**。沒有 retry-to-green、production mutation 或時間門檻放寬。這些是 correctness/race 結果，不是吞吐改善證據。

## Findings and local fixes

| Finding | Baseline evidence | Local correction / after | Gate |
| --- | --- | --- | --- |
| P1: non-owner close has side effects despite 403 | Installation B 對 A Session 執行 DELETE 得到 403，但 A bootstrap 轉為 unavailable、socket/pending 被清除 | `/close` transaction result 非成功時立即 return；同 fixture owner 仍 available，owner 自己 close 仍正常 | PASS（local regression；未部署） |
| P2: failed enrollment burns the one-time activation | 注入 installation INSERT failure，activation `consumed_at` 已非 null，無 installation | `enroll` 以 D1 transactional batch 執行 conditional INSERT + consume；failure rollback 後仍可成功重試 | PASS（local workerd/D1） |
| P2: async route rejection bypasses sanitized error boundary | D1 rejected promise 逃出 Worker `fetch` try/catch | async route 呼叫 `return await`；回傳固定 503 `REMOTE_SERVICE_UNAVAILABLE`，不回 raw storage error | PASS（injected failure） |
| P1: await-body admission uses stale lifecycle/generation/quota | JOIN body read 期間 close 或 pending quota 填滿，仍配置 pending；HTTP body read 期間 close 或 generation replacement，仍送至舊 Teacher | `/join`、`/http-read` 先完成 body read，再取當下 meta/teacher/quota，立即保留 admission；四個確定性交錯測試 baseline FAIL → after PASS | PASS（local deterministic race） |

修正只在 `apps/relay/src/worker.js`。沒有修改 protocol、operation set、64 KiB ceiling、media limits、schema、dependency 或 Rust domain authority。`http_relay.js` 本輪保持原樣。

## Remaining blockers and exposure

**FAIL_BLOCKER — public sustained admission / resource protection.** 目前 body/frames/pending/socket 數量及 timeout 有界，但沒有 source-level sustained rate / cost limit。已知有效 remote locator 的未授權 client 可反覆占用 Student sockets / JOIN admission；格式有效但不存在的 ID 仍會取得對應 DO stub。隨機猜 ID 不會通過 authenticated `/create` 產生可用 Session / relay metadata，但不能據此宣稱 DO invocation 成本或總資源有界。Invalid activation 也會進入 D1 查詢/transaction。雲端目前 WAF/rate controls 未在此本機 audit 核實，不能假設存在。

沒有現成 per-IP limiter，因此本機共用 NAT 不因應用層 IP 計數被拒；這不等於已證明公開 abuse 防護。需要決定平台層 admission、識別/配額策略及成本上限，並證明不誤封合法同 NAT 整班。若需要新 binding、付費功能或 auth contract，先做 `ARCHITECTURE_DECISION_REQUIRED`，本輪未加入。

**FAIL_BLOCKER — forged HTTP owner consumes victim quota before Rust auth.** `HttpRelay.open` 用 request header 的 `sessionId:participantId` 作 owner，Rust 還沒驗證 bearer 就配置 slot。新 evidence test 以任意格式正確的 A credential 配合 victim identity 開始 media，再用相同 identity / 不同 B credential 請求，即得到 429。第二個 credential 尚未獲驗證機會；此拒絕不取決於它是否有效。Rust 可阻止資料洩漏，但不能讓這個先行 quota 決策成為可信。單次占用會因 Rust 回覆或 media idle timeout（20s）回收，但可重複發起；隨機 forged identities 也可競爭 Session-wide 4 media / 64 requests。沒有在此默默新增 credential cache 或 participant admission protocol。

**FAIL_BLOCKER — public failed JOIN can poison recovery capacity.** Native audit 發現 `RemoteParticipants` 的 120s recovery cache 包含失敗結果，128 個不同 wrong-roster attempts 可令後續合法 JOIN 得到 `REMOTE_SERVICE_UNAVAILABLE`。既有 `recovery_is_bounded...` Rust test 已刻意覆蓋此行為；本報告不重跑或計入上面的 49 tests。Relay pending 128 / 8s 不會消除此 native 120s availability 問題。詳見主報告的 Rust gate。

**Bounded revocation behavior, not immediate revocation.** 本機 fixture 實測 revoke 後新的 create/ticket/close control request 全拒絕；revoke 前取得的單次 ticket 仍可接入，既有 socket/Session 不會主動被踢除。Repository `wrangler.jsonc` 設定 ticket 60s、relay lifetime 43200s（12h）；因此未兌換 ticket 最多剩餘 60s，已連線 Session 最多剩餘 12h（持續 heartbeat 時）。這是 repository configured exposure，不代表已核對雲端現行 vars。Code 容許設定範圍分別 15–300s、3600–86400s，操作上不能把目前 60s/12h 說成所有設定的硬上限。

安全關閉途徑：credential 尚為 ACTIVE 時，先透過既有 Teacher control 關閉精確 owned Session，再 revoke installation。若已 revoke，該 credential 的 close 亦被拒；停止受控 Teacher process/socket 可使 relay immediate observed-offline 或 silent loss 約 60s 後 offline，但 relay metadata 至 expiry 才終止，已外洩 ticket 的剩餘 lifetime 仍需考慮。本輪未新增遠端管理平台 / kill switch，也未把上述行為新標成使用者已接受的限制。

## Gate → source → tests → missing evidence

所有 source path 均相對 repository root。`existing` 表示已存在的測試；只有明列本輪 command 的 49 tests 被重新執行。

| Gate | Source symbols | Test evidence | Missing evidence / status |
| --- | --- | --- | --- |
| Operator authentication / CLI only after confirmed insert | `worker.js:operatorActivation/operatorRevoke`；`scripts/activation-create-prod.js:runActivationCreate` | 新 no-secret endpoint test；existing CLI 17 mocked-executor tests | Local PASS；production operator secret/bindings NOT_VERIFIED；未呼叫 CLI production command |
| Activation single use / short expiry / hash only | `worker.js:enroll`；`0001_installations.sql`；CLI 10min lifetime | 新 8-way redemption → 1x201 + 7x403、one installation；insert-failure rollback | Atomicity PASS；activation expiry predicate source review，本輪未等待 activation expiry 或讀 production D1 |
| Ticket Session / installation / one-use / lifetime | `issueTicket`、DO `/ticket`、`/teacher` `transactionSync` | 新 6-way redemption → 1x101 + 5x403；existing `worker.test.js` expired/replayed tickets | Concurrency PASS；既有 expiry test 未重跑；revoke exposure 如上 |
| Owner close / lifecycle / generation | DO `/close`、`/join`、`/http-read`、`lifecycle.js` | 新 owner-close + 4 body races；existing lifecycle 6 | Local PASS；process crash/production hibernation duration 不由 unit tests 推定 |
| Public bootstrap privacy / no usable guessed Session | `bootstrap`、DO `/bootstrap`、authenticated `/create` | Source只投影 version/reachable/status；新 owner-close觀察bootstrap；unknown API test | 不保存猜測 ID 的可用 meta；無 sustained public invocation limit，FAIL_BLOCKER |
| HTTP allowlist / no generic proxy / independent authorization | `publicHttpRequest`、`validHttpOperation`、`HttpRelay.open`；Rust HTTP services 由另一 audit 覆蓋 | existing HTTP H1/H2/H3，reject unknown URL/path/query/Range | Relay parser PASS；forged quota FAIL_BLOCKER；不可把格式校驗當 Rust auth |
| Bounded envelopes / payloads | `bodyJson` 4096B；`contract.js:readEnvelope/encodeEnvelope` 64KiB；HTTP chunk 32KiB/window4 | existing HTTP S1–S5 及先前 `contract.test.js`（本輪未重跑） | Limits 保留；slow request count / rate gate 未建立 |
| Socket / JOIN / liveness bounds | 512 Student sockets、5s AUTH、128 pending JOIN / 8s、60s Teacher liveness | 新 quota race；existing lifecycle silent-loss / stale-close / idle broadcast | 純 state tests PASS；sustained unauthenticated request abuse FAIL_BLOCKER；容量測試見主報告 |
| Cancel / timeout / generation / backpressure cleanup | `HttpRelay.fail/remove/expire/handle`、`HTTP_LIMITS` | existing HTTP S5–S10；caps/quota tests；new body-generation race | Local PASS；完整 Rust Vec/permit/OS RAM 由主容量測試記錄 |
| Credentials / domain data not durable in relay | hash only D1；DO meta and `serializeAttachment`；`HttpRelay.pending` | existing H7 + lifecycle attachment invalidation；source review | No auth token/domain payload in persisted pending metadata；live WS payload經memory是必要傳輸，不可說從未接觸；production logs NOT_VERIFIED |
| CSP / Origin / cache / API vs SPA | `staticHeaders`、`studentSocket`、`json/httpError`；`wrangler.jsonc` | 新 unknown API JSON404 / HTML CSP / no-store；existing HTTP metadata allowlist | Source無 wildcard CORS；WS origin有提供時須相同且不接受query；non-browser可省略 Origin，Rust auth仍必須保留；installed Blob/PDF renderer本輪NOT_VERIFIED |
| Shared public cache avoidance | protected responses `cache-control:no-store` / nosniff / no-referrer | HTTP header/source review；new static/no-store test | 無新 CDN/cache；現行平台 configuration NOT_VERIFIED |
| Static Assets / Worker costs | `assets.run_worker_first:["/*"]`；observability invocation_logs false/query redaction | Source review | 不能把全部 static requests 當免費免Worker；價格/plan/usage由主成本報告核對 |

本機 fixtures 的 identities/credentials 為隨機或明確 synthetic 值，未寫入本報告。沒有輸出測試內容、原始 activation code、bearer 或管理秘密。CLI tests 全部使用注入 executor；test name 中的 production D1 是 CLI contract 描述，不是本輪 production 寫入。

Pass B 不應只因 49 tests 通過就啟動；需先審閱上述 FAIL_BLOCKER、主容量結果、限定 pilot 的採納條件與新的明確 production 授權。Phase 16F 整體尚未 COMPLETE。

## Capacity harness robustness follow-up

只讀審查 `apps/relay/scripts/capacity-local.js`、`build-capacity-client.js`、`generate-capacity-media.js`、native `remote_capacity_metrics.rs` / `remote_capacity_smoke.rs`，未重啟 8792 或由本 audit 執行容量負載。

新增獨立 `apps/relay/scripts/capacity-local.safety.test.js`，執行實際 harness 的 preflight/fetch-guard prefix，在 Student module import 前停止。process/stdin/fetch/timers 全部注入 fake；無 HTTP、WebSocket、D1、子程序或真實 timer。測試指令：

```powershell
node --test apps/relay/scripts/capacity-local.safety.test.js
```

**14 / 14 PASS**：拒絕 production/non-loopback origins、拒絕不在 1–40 的 client count、output 不可跳出 ignored target 或使用相似 sibling prefix、cross-origin fetch 在 transport 前拒絕、強制 `redirect:error`、29 分鐘 nonzero hard stop、45 秒 native control deadline。這 14 tests 與上述 49 個 relay tests 不重複。

Source review 確認並已由主工作修正的隔離問題：native fixture 原本只驗證 runtime environment URL，release-mode service 可能採 compile-time URL；現在於 credential/network 操作前比對 service 實際 base URL 與已驗證的 loopback URL。Node fetch 現在拒絕 redirect。此處對 native effective-URL guard 是 source review，不冒稱已用 production/release binary 執行攻擊測試。

Byte budgets：native test-only pre-send accounting 在累計 raw media 超過 1 GiB 或 Teacher WS UTF-8 超過 2 GiB 時拒絕送出下一 frame，並使主迴圈停止；計數名稱是 reserved，可能包含那一個未送出的超限 frame。不能把 reserved values 當 byte-perfect cloud egress。Client count 上限 40；Student complete frame 上限 64 KiB；Node workload timer 29 分鐘，native workload loop 30 分鐘。這些 timer 在 fixture/setup 後啟動，並非整個建置／setup 命令的 wall-clock 上限。Test-only instrumentation 不進 production binary。

正常退出明確 close synthetic Remote Session；child RAII guard 在 unwind 時 kill/wait，credential guard 僅恢復隔離的 `Classroom.RemoteInstallation.Phase16CTest` entry，不碰正式 entry。Panic 途中不保證執行 async remote close，credential restore 的 I/O error 也被忽略；目前只准本機隔離資料與程序 teardown，不能把此 harness 直接改 URL 後當成 production cleanup-ready 工具。Pass B 需要另外驗證所有 failure paths 的 exact-ID cleanup。

結果解讀限制：HTTP 讀取使用真正的 bundled `studentHttpRead`；WSS clients 是手寫 protocol synthetic clients，不包含真實 Student UI 的 reconnect/backoff/schema parser/mutation replay。主工作最新版本已加入 ACK accepted/p95、authoritative answered count、media completion/integrity/MIME、soak read results、liveness、resource release 與 byte-budget gates，FAIL gate 設 nonzero exit；仍須分開「harness 執行完成」與「各產品 gate 通過」。本 audit 的 14 tests 不測這些容量結果。

以下仍 **NOT_VERIFIED**，不可從 soak 完成推定：lock/reveal 在 media 負載中的實際 client delivery；generation interruption 當下 in-flight HTTP 的錯誤／清理；ACK 遺失後真實 Student replay；手機 decode/首次可見；完整 native panic cleanup。既有 Phase 16E regression 可另列既有證據，不可冒稱本輪 soak 有注入這些故障。Native request timing 以 request UUID 記錄，HTTP row 主要以 client index 記錄；concurrent per-client breakdown 缺直接 requestId bridge，應呈現 native aggregate 或 before/after request-set 差集，不能把跨 process timestamps 直接相減。

## Media-time realtime finding — final Pass A status: PARTIAL / HOLD

主容量工作補做了明確等待 response first body bytes 的有界診斷。此段只讀分析既有結果，未由此 audit 啟動新負載或修改 runtime。所有負載已停止。

原 `full.json` 的四條 100 MiB PDF 傳輸雖完整，但 final ping RTT p95 = **14.691s**、max = **48.197s**，與四 PDF 約 48.4s 的傳輸窗相近。原 C4 在 request 後 400ms 發 ACK；單 PDF 首 byte 約 1.466s，因此該 ACK 主要在 streaming 前，不能證明 under-stream realtime。原 full 的 27 個 guard 即使通過，也不足以代表 Phase 16F capacity PASS。

| After-first-byte diagnostic | Single 100 MiB PDF | Four concurrent 100 MiB PDFs |
| --- | --- | --- |
| Trigger | 等到首 body byte 再送 40 Quiz submissions / detail | 等到四條 stream 全部首 body byte 再送 40 Quiz submissions / detail |
| Quiz ACK | p95 398ms；max 416ms | **40 / 40 在 10s timeout**；authoritative progress = **0** |
| Detail | 153ms | **39.482s** |
| PDF | 14.326s，integrity / MIME PASS | 48.119–48.243s，四檔 integrity / MIME PASS |
| Node event-loop delay | 未收此項 | p95 8.60ms；max 10.88ms |
| Result | 本機單 stream 診斷 PASS | **FAIL_BLOCKER** |

四 stream 結果檔：ignored `apps/teacher/src-tauri/target/phase16f-results/stream-probe-four.json`；不把它當成正式環境結果。沒有任何已 accepted 的 submission 被證明遺失；此輪是 ACK timeout 且 authoritative progress 未接受，不能將其誤稱為 accepted-data loss。

最強、仍有邊界的診斷：

- Node event-loop 長時間停頓不符合所收 10.88ms max；native file read max 約 1.556s，也不能解釋單次 40–48s 延遲。
- native `sendWaitMaxMs` 約 23.78ms，但累計約 33.254s。它排除單次 `socket.send` 停 48s，沒有排除共享 Teacher WSS 的大量短次等待、CPU/base64/JSON 成本或 fairness 問題；其 timer 也不涵蓋所有序列化/metrics 開銷。
- Worker/HttpRelay 沒有 per-chunk console logging；native main harness log 是階段輸出，原 full log 約 390KB。Root metrics/control 不會持有 Teacher socket；Teacher connection loop 是另一 async task，metrics Mutex 只包同步計數/快照。因此沒有 source 證據支持「root await PDF 完成才處理 Teacher WS」。
- HTTP START 建立 `FixedLengthStream`，`pipeTo` 以 `ctx.waitUntil` 保持存活，message handler 沒有 await 整個檔案。不能因此直接斷言 FixedLengthStream 會等待 EOF 才處理所有 realtime；workerd / DO 排程與 input/output gate 仍需分段 trace 才能定位。
- 四 stream 的 Student counters 是 `reauth=40`、`auth=40`、received pongs 僅 54，而 native 已送 `AUTH:participant_authenticated=80`。主工作另在 local Wrangler log 觀察到 `rejectSocket → webSocketMessage` 的 PENDING_AUTH rejection，以及 closed socket 再次 `send()` 的 TypeError；未見 reload/rebuild 訊息。
- 上述證據支持 **REAUTH_REQUIRED / PENDING_AUTH 與 media 期間 realtime 排程競爭**，但沒有 time/generation 對齊 trace，尚不能確定最初觸發位置。Source 的 re-auth 來源包括 constructor reconstruction 與 Teacher generation replacement；此刻不能擇一當成已證實根因。已收到的少數 pong latency 不代表大量 outstanding pings 正常，避免 survivorship bias。

Presence 邊界：`local_server.rs` 的 `PRESENCE_TIMEOUT` 是 **7s**。`PresenceRegistry::is_online` 會 prune 超時 connection，而 `heartbeat` 只更新仍存在的 entry。若長延遲位在 Teacher 收到 ping 之前，實際 Teacher presence polling 可能 prune；若只發生於 pong 回程，native presence 可能仍正常。此 harness 未連續量測真實 Teacher presence，所以 `unexpectedOffline=0` 不足以宣稱 presence PASS。不可把這個 conditional risk 寫成已實證發生的 UI 故障。

手寫 protocol Student 沒有真實 UI 的 socket-close reconnect policy，因此本診斷也不能判定 UI 的最終恢復時間。新的 harness 已改為 single/all-four first bytes 後發測試負載，ACK 必須 `accepted === true`，並記錄 ERROR envelope；沒有重跑 full soak 以製造通過數字。

決策：**四 stream mixed realtime gate = FAIL_BLOCKER；Pass A = PARTIAL；release recommendation = HOLD**。此 evidence 不足以自動選 R2，也不能以提高 window/stream limits 處理。未修改 `rejectSocket` 來壓制錯誤，因為只加 closed-socket 容錯不會修復 auth/realtime 功能。保留原 source、before/after 與失敗證據，後續需先決定 trace / fairness / re-auth recovery 的針對性 scope，再安排必要驗證。Production verification、真正 Student UI / installed Human QA 仍未執行。
