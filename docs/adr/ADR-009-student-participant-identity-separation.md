# ADR-009：分離 Student 與 Participant 身分

## Context

教師名冊身分是長期資料，但一次 session 可包含訪客、臨時加入者、重連者及尚未確認名冊的座位；直接把 Student 當 session login 會混淆授權與歷史資料。

## Decision

Student 是永久 UUID、座號、姓名等名冊身分；Participant 是 session-scoped 身分，具有 optional student reference、display name、seat number 與 temporary credential。所有學生 client 授權以 Participant/session credential 為基礎。

## Consequences

訪客與固定班級流程可共存，重連及撤銷可限定在 session 範圍。資料模型、RLS 和 backend command 必須禁止把座號或可猜 participant ID 當作 authentication。
