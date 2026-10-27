# Phase 16F Pass A — Cloudflare 成本與 Windows release 稽核

**2026-10-26 update:** [Pass A2](phase16f-pass-a2.md) fixed the observed local scheduling failure without changing transport caps. Peak bulk throughput decreased while control latency improved. The cost figures below remain assumptions/models; A2 supplies no production CPU/duration/account usage or classroom-scale acceptance. In-memory admission is not a global spending cap.

查核日期：2026-10-25。這是模型估算與 source audit，不是 Cloudflare 帳單驗證、40 人產品容量承諾，或 Phase 16F closeout。

Canonical repository：I:\ChatGPT\teachTools。Baseline：c5285196a08e412732eb2246efd78e3c9644d15a（main，origin/main 相同）。本文件不變更 runtime、dependency、migration、plan 或 cloud resource。

## 證據與未知項

| 項目 | 本輪證據／狀態 |
| --- | --- |
| Worker target | https://classroom-relay.ryanaddy1102.workers.dev |
| 唯讀核對命令 | pnpm --filter @classtools/relay exec wrangler deployments list --json |
| 最新 deployment | 04dcd005-a19a-4136-a390-ecd38897f706；created_on 2026-10-02T13:26:23.587034Z |
| 已核實 Worker version | 13424a84-25a3-409d-a0b6-1371f6b270d4，100% |
| Account plan／付費附加功能 | UNKNOWN；deployment listing 不包含 billing plan |
| Account 其他 Worker／DO／D1 共用 usage | UNKNOWN |
| Production CPU、DO billable duration、rows、storage、logs usage | UNKNOWN；本輪未擷取帳務／Analytics 時序 |
| Production verification／正式 D1 寫入 | NOT EXECUTED |
| Final RC／installed Human QA | NOT EXECUTED |

不以已部署成功反推 Paid，不以本機執行時間代替 Cloudflare billable duration。正式使用前仍需有權限的 Operator 唯讀確認方案、帳單週期、當月剩餘含量、當日 quota、錯誤率與 storage growth。

## Evidence map

| Gate | Source／symbol | 現有 evidence | 缺口 |
| --- | --- | --- | --- |
| Worker／static invocation | apps/relay/wrangler.jsonc，run_worker_first=["/*"] | source audit | Production requests／CPU |
| DO request/storage/lifecycle | apps/relay/src/worker.js：webSocketMessage、meta、put、scheduleAlarm、alarm | HTTP/realtime/lifecycle focused tests；本輪容量證據另見主報告 | 帳務 raw messages 與 alarm/storage counters |
| Streaming active duration | apps/relay/src/http_relay.js；Worker constructor 的 waitUntil callback | FixedLengthStream／cancel tests；本機 harness | 真正可 hibernate 時間與 production duration |
| Student presence | apps/student/src/services/studentApi.ts：3,000 ms；participant_realtime.rs：Ping → Pong | source 計數 | 長課堂實際 reconnect／background throttling |
| Teacher heartbeat | remote_control.rs：production 20 秒；本輪 capacity test 也為 20 秒，其他 test 2 秒 | source 計數 | 本輪按實際 20 秒校準；不能拿歷史 test 2 秒直接外推 |
| Teacher 個別化 events | remote_participant.rs：sync_all、wrap_messages；participant_realtime.rs：quiz_messages | 每 participant 各自發 frame | Grouping／Peer Review／re-auth 額外 fan-out |
| D1 registry | worker.js：installation、createSession、issueTicket、closeSession | credential_hash indexed lookup；沒有 Student domain data | rows_read／rows_written 真實 meta |
| Release URL | remote_control.rs：option_env!；src-tauri/build.rs | source audit | FAIL_BLOCKER：Remote build 缺少 fail-closed 設定檢查 |
| Toolchain | src-tauri/Cargo.toml rust-version；本機 rustc/cargo | 宣告 1.88；本機 stable 1.97.1 | 1.88 實測與 pinned toolchain 未驗證 |
| NSIS／installed runtime | tauri.conf.json、docs/windows-release.md | current-user／既有 identifier 與路徑 | 最終 Remote RC 與 installed QA 尚未執行 |

## 當日官方計費輸入

以下 USD 價格與含量只用於估算；含量按帳號共用，不是每位 Teacher 一份。

| 維度 | Free | Paid |
| --- | --- | --- |
| Worker requests | 100,000/day | 10M/month included；$0.30/M |
| Worker CPU | 10 ms/invocation ceiling | 30M ms/month included；$0.02/M ms |
| Workers account base | $0 | 至少 $5/month |
| DO requests | 100,000/day | 1M/month included；$0.15/M |
| DO duration | 13,000 GB-s/day | 400,000 GB-s/month included；$12.50/M GB-s |
| DO SQLite rows read | 5M/day | 25B/month included；$0.001/M |
| DO SQLite rows written | 100,000/day | 50M/month included；$1/M |
| DO SQLite storage | 5 GB/account | 5 GB included；$0.20/GB-month |
| D1 rows read／written | 5M／100,000 per day | 25B／50M per month included；$0.001／$1 per M |
| D1 storage | 5 GB/account | 5 GB included；$0.75/GB-month |
| Workers Logs | 200,000 events/day；3 days retention | 20M/month included；$0.60/M；7 days retention |

來源：[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)、[DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)。2026-12-01 起 Logs 計價將轉至 Cloudflare Observability；若 pilot 跨該日，須重新核對，不能沿用本表。

### 分項與取整

Worker 的 WS upgrade 是一次 HTTP request；後續 WS messages 不是再次 Worker requests。DO 的 HTTP、RPC、alarm invocations 與 incoming application WS 分開統計；incoming WS 以 20:1 換算，outgoing WS 不計 request。Analytics 的 raw messages 不會自動變成 20:1 數字。JSON ping 是應用訊息，不是免費 protocol ping。[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)、[DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

DO 使用 SQLite-backed class；其 kv API 背後仍是 SQLite rows，不能套 legacy KV 的另一套費率。[SQLite-backed storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)meta() 的 get、put、setAlarm（每次一 row write）即使資料被 cache 也有 storage usage。DO 超出月含量後依官方規則向上取整至下一個 billable unit。[DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

定義 excess(x,a)=max(0,x-a)，ceilM(x)=ceil(x/1,000,000)。本文件 DO request 與 duration 費用使用 0.15×ceilM(excess(R,1M))、12.50×ceilM(excess(G,400k))；不逐堂／逐訊息向上收一整百萬單位。Worker／D1 的使用量以價目表每百萬單位計算；本模型未超額，其帳單最終取整需以實際 invoice 確認。

D1 計費是掃描／寫入 rows，不能將 query 次數等同實測 rows；index 維護亦可能增加寫入。以 query meta 或 Analytics 的 rows_read、rows_written 校準。[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

### Duration 與 Static Assets

DO duration 是每個 object 的 active／不符合 hibernation 條件的時間聯集；同時四個 read 不把同一段時間乘四，更不能乘 40 位 Student。配置的 128 MB 用於計費，與 Teacher process RAM 無關。已 idle 且符合 hibernation 條件的時間，即使 runtime 尚未真正 hibernate，也不收 duration。[DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[DO duration FAQ](https://developers.cloudflare.com/durable-objects/reference/faq/)

本專案使用 accepted socket hibernation API，但 pending HTTP、FixedLengthStream pipeTo 與 waitUntil 期間不能當零 duration。Student 3 秒 ping 不足以證明整堂課都在計費：每次事件之間是否符合 eligibility 仍要量測。每堂 50 分鐘完整 active 的保守上界為 0.128×3,000=384 GB-s；不包含開課前、未關課後與故障拖延。[DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)

run_worker_first=["/*"] 表示目前 SPA、JS/CSS 與 API 都先經 Worker，因此下列模型包含 static fetch。直接 asset serving 的免費規則不能直接套到本路徑；Free quota 超過時這些路徑可能回 429，而非自動 bypass Worker。保留 security headers，不為省費移除 routing/CSP。[Static Assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)

## 本機實測校準（與帳單／一般課堂分開）

資料為 ignored target 的 before.json 與 full.json，來自同一台 Windows PC、真實 Rust services、local Wrangler 與 protocol synthetic clients；不是 production Analytics。原 full run 曾回報 27 個明列 guards PASS，但追查確認 C4 ACK 在 first body byte 之前發起，不能用來證明傳輸中的 realtime 容量通過。下表保留該次原始 counters，**不代表 capacity PASS**。Pass A 的最終判定為 **PARTIAL／HOLD**；另見主報告後續診斷與安全 blockers。

| Observed counter | before probe | full run | C5 soak 差分 |
| --- | ---: | ---: | ---: |
| 觀察範圍 | 最多 5 人，遇既有 image blocker 停止 | 40 人與分階段負載，699.867 秒 | 40 人，600.3179267 秒，39 rounds |
| Teacher pre-send frames | 898 | 33,154 | 9,240 |
| Student send frames | 19 | 9,720 | 8,032 |
| 合計 attempted incoming DO WS | 917 | 42,874 | 17,272 |
| 上列／20（僅 WS equivalent） | 45.85 | 2,143.70 | 863.60 |
| JS fetch attempts | 21 | 420 | 58 |
| Teacher pre-send UTF-8 bytes | 33,694,213 | 971,755,770 | 33,573,044 |
| HTTP raw chunk bytes reserved | 25,139,952 | 723,847,590 | 23,321,958 |

Teacher counters 是呼叫 socket send 之前的保守預留；Student counters 也是 send 呼叫時累加。它們是本機 attempted frames，不是 DO 收到／Cloudflare 已計費證明。DO→Student receivedFrames、DO→Teacher CREDIT/credit_grants 都不能再加進 incoming 計費。raw chunk counter 包含 JSON 與媒體，所以比純 media 預算保守；取消與部分傳輸也累加。Full budgetStopped=false。

JS fetch attempts 包含 join、read 及有限 retry，但不含 WS upgrade、native create/ticket/close/enrollment、static。Student 使用 synthetic socket，沒有瀏覽器 static fetch；因此 420 不能直接填成完整 Worker W 或 DO H。CPU、實際 DO duration、kv/alarm、D1 rows、storage、logs usage 仍 UNKNOWN。

### 成功 read 的 frame 係數

- Full C2 N=1 差分為 64 CHUNK、1 START、1 END，raw 2,094,909 bytes；這校準模型中的約 2 MiB image=66 incoming frames。C1 的三個 image 加三個 348-byte detail，合計 195 CHUNK、6 START、6 END，與 3×64+3×1 完全一致。
- C4 single PDF 區段相較前一個 N=40 media snapshot，新增 3,203 CHUNK、4 START、4 END；扣除該區段三個 348-byte detail，PDF 本身為 3,200 CHUNK+START+END=3,202 frames，raw 104,857,600 bytes。
- C4 four PDFs 相較 single PDF snapshot，新增 12,803 CHUNK、7 START、7 END，raw 419,431,444 bytes；扣除三個 detail 後為四次 100 MiB PDF。這一個極端區段不能重複套入每堂一般課堂。
- 取消可能只有 START 與部分 CHUNK，沒有正常 END；用實際 frames 計，不把一次取消當完整 66 或 3,202 frames。

Full 的五次成功 100 MiB PDF 占 524,288,000 raw bytes，約為全輪 raw counter 的 72.4%；其餘還有一般圖、JSON、取消與 soak。不能把 full 的 699.867 秒總量直接乘至 50 分鐘／整個月。

### 容量結論更正與後續有界診斷

原 full 的 ping p95 約 14.691 秒、max 約 48.197 秒，觸發對 C4 measurement ordering 的追查。後續將作答移到實際 first byte 之後：單條 PDF 的這一項檢查 PASS；四條 PDF 則在所有 streams 都出現 first byte 後觸發，結果為 **FAIL_BLOCKER**：

- 40 個 ACK 全部達 10 秒 timeout；authoritative answered=0。
- detail 約 39.482 秒；四個檔案仍完整，完成時間約 48.1–48.24 秒。
- Node event-loop max delay 約 10.876 ms，不能直接把約 48 秒延遲歸因為該 Node client 的 event-loop block。
- 此診斷沒有 planned reconnect，卻出現 re-auth 40；Teacher AUTH count=80、Student accepted=40，並有 Worker PENDING_AUTH rejectSocket 的 send-after-close errors。

Root cause 仍待針對 liveness／auth／stream interaction 追蹤；這不是 Cloudflare 平台容量不足的已證實結論，也不是 R2 的實作理由或授權。完整檔案不能抵銷 ACK、detail 或 auth/liveness failure；不能由原 full guards PASS 宣稱四條大檔 streaming 可用。

後續單 PDF 與四 PDF 是各自受 per-run caps 約束的額外本機診斷，沒有 production 流量。它們不併入前表 full run counters，也不加入一般 40 人／50 分鐘課堂成本模型。主報告保留確切診斷 evidence；此文件只修正容量解讀，不重跑測試或雲端操作。

### Presence、re-auth 與 retry 校準

C5 的 Teacher CONTROL ping 差分 30，符合本輪已明確使用 production 20 秒 interval。Student 約 3 秒 ping 的配對 Pong 差分為 7,952；Student send 差分 8,032 中其餘 80 是一次 Teacher reconnect 引起的 AUTH attempts。Teacher accepted AUTH 增加 40；session_sync 總差分 120 中，40 為重驗後同步，另外 80 來自兩次 Quiz 狀態事件。因此本次 generation recovery 是 160 incoming frames（4×N），不能只用三個 frames/人。不同故障／重建仍可能不同。

只把觀察到的穩態 presence 正規化至 50 分鐘：2×7,952×3,000/600.3179267≈79,477.9 incoming frames；Teacher ping 約 149.92。模型保留完整持續上線的 nominal 80,000／150，避免把本機邊界與 reconnect 暫停造成的少量差額誤當節費保證。歷史其他 Rust tests 的 2 秒 interval 不用來估算本輪。

| 同時 image requests | 1 | 4 | 5 | 10 | 20 | 40 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 本輪 full HTTP attempts | 1 | 4 | 6 | 18 | 74 | 200 |
| 成功 reads | 1 | 4 | 5 | 10 | 20 | 40 |
| attempts／完成 read | 1 | 1 | 1.2 | 1.8 | 3.7 | 5 |

低／中／高模型以下採 k=1／1.8／5，分別代表這次本機順序／10 人 burst／40 人 burst 的 read-attempt 係數；**是實測校準的假設，不是 production retry 分布預測**。Rejected admission 增加 Worker／DO HTTP，但沒有成功 read 的完整 CHUNK 序列；不把 200 attempts 算成 200 份完整圖片。正式 Student policy 最多 initial+16 retries 且受 30 秒 admission budget 約束，WAN 可能比本次更差。

C5 unexpectedOffline=0、wsErrors=0 只描述 harness socket/liveness counters。停止 local Wrangler 時，在刻意 CANCEL 附近觀察到平台「Network connection lost」訊息；不能因此聲稱所有 relay logs 零錯誤，也不能從這些 counters 推算 logs 成本為零。

## 可重算的課堂模型

N=40、T=3,000 秒。這是規劃模型，不是已驗收容量。低／中／高是不同使用量假設，不是已量得的統計分位數。

| 輸入／每堂 | 低 | 中 | 高 |
| --- | ---: | ---: | ---: |
| 每人 2 MiB image 數 I | 2 | 6 | 12 |
| 每完成 image 的 HTTP attempts k（本機校準假設） | 1 | 1.8 | 5 |
| Quiz 題數 Q（每人每題一次 submit） | 10 | 20 | 40 |
| 每人 JSON detail 數 D（各 ≤32 KiB） | 2 | 6 | 12 |
| 每人 transport reconnect 次 r | 0 | 1 | 3 |
| Teacher generation reconnect 次 g | 0 | 1 | 3 |
| 初次 static requests A／人 | 3 | 3 | 3 |
| alarm invocations a（假設，非 setAlarm 次數） | 1 | 10 | 60 |
| DO billable active fraction h（敏感度假設） | 0.1 | 0.5 | 1 |
| Worker 平均 CPU ms c（假設，非實測） | 1 | 5 | 10 |
| logs events／堂（敏感度假設） | 0 | 100 | 1,000 |

初次 activation 不逐堂重做；每位 Teacher 使用既有 installation。每題為 OPEN、LOCKED、REVEALED，各有個別化 sync；一般 image admission retry 已按 k 納入；不另外假設 Grouping／Peer Review mutation、mutation 重送、其他錯誤、重新載頁或不正常 client。這些都須追加實測量，而非聲稱免費。2 MiB 圖片仍逐 participant 授權／傳輸，不假設 public cache 或共用 payload。

### Source 訊息計數

- Presence：Student→DO ping，加上 Rust→DO Pong，約 2×N×T/3=80,000 incoming WS。
- Teacher CONTROL ping：約 T/20=150；本輪 capacity test 明確使用 20 秒；歷史其他 test 的 2 秒不納入。邊界第一個 tick 造成的 ±1 另外記錄。
- 一次 join result，加上 Student AUTH、Teacher AUTH response、personalized session_sync：4×N。
- 每題一次 submit/ACK：2×N；OPEN/LOCKED 各最多 2×N，REVEALED 最多 4×N，合計 10×N×Q。Rust 根據每人狀態投影；不是 DO 自行產生 ACK。
- 完成 B bytes 的 HTTP read：START + ceil(B/32,768) CHUNK + END。2 MiB=66 個 incoming Teacher frames；≤32 KiB JSON=3。
- CREDIT 是 DO→Teacher outgoing，不再列為 incoming DO request。CANCEL、ERROR、重試、未完成 stream 需按真實 frames 追加。
- reconnect：Student transport re-auth 以 3×N；Teacher generation recovery 按本輪一次 reconnect 校準為 4×N incoming frames；Teacher reconnect 另有 ticket/WS HTTP。若重建多次，不限於此假設。
- 兩次 Session state event 約 2×N。

對上述完整成功假設：

~~~text
S = 2*N*T/3 + T/20 + 4*N + 10*N*Q
    + N*(66*I + 3*D) + 3*N*r + 4*N*g + 2*N
H = 4 + N*(3+D+k*I) + N*r + 2*g
W = H + N*A
R = H + S/20 + a
G = 0.128*T*h
Worker_CPU_ms = W*c
media_raw_bytes = N*I*2*1,048,576
D1_control_queries = 3+g
~~~

H 是 DO HTTP（建立、ticket、Teacher WS、close；Student bootstrap/join/WS/detail/media），W 是 Worker HTTP。D1 create/ticket/close 查 installation；Teacher WS 使用 ticket，沒有第四次 D1 lookup。D1_control_queries 不是已驗證 rows。presence 對齊、close/constructor 等小額控制 frame 差異，以及不規則 domain activity，須由 counters 校準。

### 模型結果

| 每堂 40 人／50 分鐘 | 低 | 中 | 高 |
| --- | ---: | ---: | ---: |
| Worker requests W | 404 | 958 | 3,250 |
| DO HTTP H | 284 | 838 | 3,130 |
| raw incoming DO WS S | 89,910 | 105,230 | 130,350 |
| DO equivalent requests R（20:1 後） | 4,780.5 | 6,109.5 | 9,707.5 |
| DO duration GB-s G | 38.4 | 192 | 384 |
| Worker CPU ms（假設） | 404 | 4,790 | 32,500 |
| 合成 image 原始傳輸 MiB | 160 | 480 | 960 |
| D1 control queries | 3 | 4 | 6 |

R 可為分數，月度聚合後才套計費單位，不在每堂過度取整。媒體 bytes 不含 base64／JSON overhead、WS headers／TLS、失敗／取消與其他 payload。

對 100 MiB PDF，單次完整 read 是 3,202 incoming Teacher frames，加一 Worker／DO GET，約增加 161.1 個 DO equivalent requests；約 133.34 MiB base64 字元另加 envelope bytes。這個數字不表示 100 MiB 載入時間或 mobile rendering 可接受。

### 月度與 Free 日上限

一位 Teacher：6 堂/day×20 days=120 堂/month。五位 Teacher：600 堂/month；同時與錯開時總 requests／bytes 相同，但同時需要五個 active DO 與五組 uplink，尖峰風險不同。不要把同時五堂合併為一個 DO，也不要把錯開誤算成較少月堂數。

| 模型量 | 低 | 中 | 高 |
| --- | ---: | ---: | ---: |
| 一 Teacher DO requests/day | 28,683 | 36,657 | 58,245 |
| 五 Teachers DO requests/day | 143,415 | 183,285 | 291,225 |
| 一 Teacher DO requests/month | 573,660 | 733,140 | 1,164,900 |
| 五 Teachers DO requests/month | 2,868,300 | 3,665,700 | 5,824,500 |
| 一 Teacher duration GB-s/month | 4,608 | 23,040 | 46,080 |
| 五 Teachers duration GB-s/month | 23,040 | 115,200 | 230,400 |
| 五 Teachers Worker requests/month | 242,400 | 574,800 | 1,950,000 |
| 五 Teachers Worker CPU ms/month | 242,400 | 2,874,000 | 19,500,000 |
| 五 Teachers logs/month（假設） | 0 | 60,000 | 600,000 |
| Paid account base + DO request 超額，一 Teacher | $5.00 | $5.00 | $5.15 |
| 同上，五 Teachers | $5.30 | $5.45 | $5.75 |

最後兩列只計本情境、含量尚未被其他使用吃掉的 base/request 模型；duration／Worker CPU／requests／logs 在所選假設下未超含量。不是報價或 VERIFIED_COST。Storage、未知 fan-out、錯誤與其他 account usage 仍要加入；實際 plan UNKNOWN。

即使低情境，五位 Teacher 每日六堂的 DO request 模型已超 Free 的 100,000/day，不能宣稱 Free 可支撐。Quota 超過會拒絕操作，UTC 零時才重置；錯開同一 UTC 日無法解除日限額。單 Teacher 模型未超此項不等於 Free 可用，還有 CPU、rows、storage、account 共用與尖峰風險。五 Teachers 高情境 Worker requests 約 97,500/day，也已接近 Free 100,000/day；沒有為未知流量預留足夠空間。[DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

### Storage 與 observability 尚待校準

~~~text
DO_rows_read = sum(kv.get/list/sql rows actually read)
DO_rows_written = kv.put/delete rows + setAlarm calls + other SQL writes
DO_storage_cost = max(0, retained_GB - 5) * 0.20 per month
D1_read_cost = max(0, actual_rows_read - 25B) / 1M * 0.001
D1_write_cost = max(0, actual_rows_written - 50M) / 1M * 1
D1_storage_cost = max(0, retained_GB - 5) * 0.75 per month
Logs_cost_before_2026_12_01 = max(0, events - 20M) / 1M * 0.60
~~~

webSocketMessage 每次 checkedMeta 至少一次 kv.get，因此正常已認證 WS 的 source 下界約 S rows；HTTP、constructor、scheduleAlarm 等另加。穩態 Teacher heartbeat 每次 meta put + setAlarm：約 300 writes/堂；每個 HTTP open/remove 及 join/auth/deadline 操作還有 alarm 更新。不能將 setAlarm 呼叫誤當同量 alarm invocations。

Exact DO kv/alarm counters、retained metadata bytes 與長期 CLOSED/EXPIRED retention：UNKNOWN。不能只因單堂資料小就把累積 storage 寫成零；內部 metadata 也占用空間。[DO storage FAQ](https://developers.cloudflare.com/durable-objects/reference/faq/)D1 正常已 enrollment 的課堂預期沒有 registry write；新增 activation/enrollment、revoke/cleanup 與索引寫入另計。Source 查詢次數不可取代 D1 rows meta。

目前 observability.enabled=true、redact_query_string=true、logs.enabled=true、invocation_logs=false。正常 source 未規劃記錄 payload/credential，但不能推論平台產生的 error logs 與帳號其他 logs 為零。以只含 count/status/timing 的遙測校準，不能為 cost measurement 打開 Authorization、ticket、原始 activation code 或 domain payload 日誌。

本機 frame／retry 差分已於前節校準；尚未取得的平台 counters 不填假數字。低中高的題數、圖片數、duration、CPU 等仍是可重算假設，不因原 full guards 的結果轉為帳單實測；後續容量 FAIL_BLOCKER 亦不改寫已觀察到的 frame counters。

## 平台 limits 與操作風險

Workers 每 isolate 128 MB；Free 的 CPU 上限為 10 ms/invocation；response body 無平台固定大小上限不代表本產品可安全承受任意檔案。DO 單執行緒的 soft throughput、SQLite storage 與 request CPU limits 是平台邊界，不是 40 位真實手機驗收結果。[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)、[DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)

應用仍維持 64 KiB envelope、32 KiB raw chunks、four-credit window、四條 media/Session、一條/participant、100 MiB PDF 上限。Paid 只改配額／計費，不會解決四條 streams 的整班 admission 或 mobile perceived latency。不得為 cost 改 auth、CSP、domain semantics、R2 或 Range。

## Pass B 的版本、授權與回復邊界

本輪僅核對雲端 deployment metadata，沒有 production smoke/load。完整逐級命令、patch digest、hard caps 與 synthetic identity manifest 必須採主 Pass A 報告中的最終版本；有 runtime patch 才考慮 deploy，不為只增加本機測量工具重 deploy。

若最終 source patch 確需部署，待明確核准後的正確命令為：

~~~powershell
pnpm --filter @classtools/relay run deploy
~~~

批准必須明確涵蓋：此 target、確切 patch、維護時窗、至多一個 synthetic classroom／40 Student sockets／一 Teacher、raw media 累計 ≤1 GiB（取消／重試也計）、另外 enforced Teacher→relay UTF-8 byte cap、wall-clock ≤30 分鐘、逐級 1/4/5/10/20/40、有限重試。不能將這些上限當 Cloudflare 帳單 hard cap。

專用 synthetic installation 的 provision/enrollment、精確 activation hash/installation ID/Session cleanup 是另有正式 D1 寫入效果的操作，必須列出 exact scope 並獲核准。不得對既有所有 ACTIVE installations 或真實課堂做批次操作。Production 操作前須確認無真實課堂或核准維護窗；出現非測試流量錯誤、quota alarm、auth/data leak、失控 reconnect/pending 立即停止。

預定 code rollback candidate 是本次已核實版本：

~~~powershell
pnpm --filter @classtools/relay exec wrangler rollback 13424a84-25a3-409d-a0b6-1371f6b270d4
~~~

初始 production scope 不包含四條並行 100 MiB PDF；只有 local 結果與其他 gates 收斂，並另獲額外明確授權才考慮。正式執行 harness／cleanup 命令仍須先完成與審閱，不能把 local-only harness 的 guard 拿掉就上 production。

這是後續可能執行的 consequential action，不是本輪授權，也未執行。先核對版本仍在可 rollback 的最近 100 個版本內、bindings/resources 未變、DO class lifecycle 可相容。Rollback 是 code deployment，不回復 D1/DO persisted state；本 Phase 不做 storage migration。[Workers rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)

## Pass C release audit 與最小修正計畫

### 已確認 source 缺口

現有 root tauri:build 轉到 Teacher 的 tauri build；src-tauri/build.rs 只有 tauri_build::build()。Release remote_control.rs 使用 compile-time option_env!("CLASSROOM_REMOTE_BASE_URL")；缺值或 invalid URL 會讓 RemoteUnavailable，卻不阻止 installer 產出。它也接受一般 HTTPS origin，沒有 Remote release 的 canonical-origin build gate。

因此現有 command 不能證明最終 installer 已帶正確 Remote URL。此問題屬最終 Remote release 的 FAIL_BLOCKER；本輪只記錄計畫，沒有改 runtime 或建 installer。

最小後續工作：

1. 加一個明確命名的 Remote release wrapper。以 process-local env 設定並驗證完整 canonical URL： https://classroom-relay.ryanaddy1102.workers.dev/ 。拒絕缺值、HTTP、query/fragment/userinfo、非允許 origin/path；不修改系統全域環境。
2. 使用既有 Node/PowerShell 與 Tauri build，不新增 dependency。Focused tests mock build invocation，驗證缺值/錯誤/非允許 origin 時在 build 前失敗、成功時只有 child build 收到非秘密 URL。明確區分 LAN-only build，不改 LAN offline contract。
3. 保留 Windows x64、NSIS current-user、identifier com.classtools.teacher、既有 app-data 路徑、未簽章與 WebView2 downloadBootstrapper policy。無 MSI、portable、updater、migration 或任意 version bump。
4. Cargo.toml 宣告 rust-version=1.88；沒有 pinned rust-toolchain 文件。本機讀到 stable rustc/cargo 1.97.1，Node v24.19.0、pnpm 9.15.0；不是 1.88 實測。Pass C 記錄選定工具鏈並做同一 source 的可重現 build；若要維持 1.88 保證，另做最低版本驗證或明確收斂 policy，不先升 dependency。
5. Gate 通過後只建一次最終候選版，新增文字 RC manifest：source HEAD + 未提交 patch/file digest、Worker version、Remote Protocol version、Student bundle hash、完整 build command/非秘密 URL/toolchain、installer 絕對路徑/bytes/SHA-256/unsigned。不得把未提交修正說成在 HEAD，也不將 installer/target/fixtures/secrets 入 Git。
6. 最小更新 docs/windows-release.md 的 Remote build 與安裝後操作；不讓 Teacher 安裝 Node/pnpm、設定環境變數、Wi-Fi sharing/NAT/VPN 或登入 Cloudflare。學校出站 WSS 必須由現場 pilot 驗證，不能由開發者環境推定。

### Installed Human QA，尚未執行

由使用者在最終 RC 驗證：不設定環境變數即可用 Remote；既有 credential 重用與隔離測試 enrollment 跨重啟保存；LAN listener stopped 下手機 4G join/Quiz；代表性 detail/image/PDF；Teacher 斷線/恢復與 idle Student re-auth；Remote close 後 LAN 獨立可用。Fresh install 用可拋棄 Windows 使用者或 VM，不刪真實 DB/Credential Manager。Uninstall data behavior 未驗證也未新增保證。

本機 40 synthetic clients 不等於 40 支實體手機。成本／容量決策、production verification、最終 RC 與 installed QA 尚未完成前，release 建議維持 HOLD，不宣稱 Phase 16F COMPLETE。