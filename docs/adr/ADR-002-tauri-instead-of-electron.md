# ADR-002：採用 Tauri 而非 Electron

## Context

教師端需要打包 React UI、本機 SQLite、LAN HTTP/WebSocket server 與學生 web assets，同時避免在教師電腦要求 Node.js runtime。

## Decision

採用 Tauri 2 + Rust 作為桌面端。Teacher React UI 透過 thin Tauri command 呼叫 Rust application services；Student Web App 在建置時被納入 Teacher App。

## Consequences

本機模式可作為單一教師應用程式運作，不需 Electron 或獨立 Node.js server。團隊需維護 Rust 與 Webview 整合，並遵守 Tauri command 不承載商業邏輯的規則。
