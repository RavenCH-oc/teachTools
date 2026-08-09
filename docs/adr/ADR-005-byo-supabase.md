# ADR-005：BYO Supabase

## Context

部分課堂需要跨網路 realtime，但不應由 Classroom 代管所有教師的雲端資料、配額與 project ownership。

## Decision

教師自行提供 Supabase Project URL 與 publishable/anon-compatible runtime credential。Supabase 用於 active session、participants、runtime questions、submissions、投票、groups 和 peer review 的暫時 execution layer。

## Consequences

教師保有 Supabase 的帳單、storage、realtime 及 database quota 控制權。產品必須提供明確的 setup、schema 相容性、RLS 驗證與 archive 流程，且 public credential 不得被誤用為 provisioning 權限。
