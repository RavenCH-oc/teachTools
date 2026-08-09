# ADR-006：不採用 Python runtime

## Context

將 Python 用於 helper、匯入匯出、migration 或 server 會增加教師安裝、更新、安全修補與跨平台封裝的成本。

## Decision

產品不包含 Python runtime、sidecar、FastAPI、Flask、Django、Python PDF/Excel/migration、HTTP/WebSocket server 或 helper。功能分別由 TypeScript、Rust 和 SQL 的既定層處理。

## Consequences

部署鏈更單純且不需要教師安裝 Python。若未來特定能力確實需 Python，必須先提出新的 ADR，包含安全、打包、維護與替代方案分析。
