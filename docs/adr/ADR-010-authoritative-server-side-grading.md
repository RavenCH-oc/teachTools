# ADR-010：權威後端評分

## Context

學生瀏覽器可被修改、重送或偽造，若接受 client score/correct 會破壞成績、公平性與統計準確度。

## Decision

學生 client 只提交答案與 submission_id。LocalBackend 或受信任的 cloud operation 依題目快照與 grading config 產生 Grade、score、correct 和統計；submission 處理以原子 idempotency 規則去重。

## Consequences

題目正解與評分規則需保留在受保護邊界，client DTO 必須最小化。雲端 RLS/operations、本機 Rust backend、retry semantics 與測試都需要保障不能重複評分或讓學生提前取得正解。
