# ADR-015: Local Classroom Server Transport Foundation

## Status

Accepted for Phase 7.

## Decision

The Teacher Tauri process hosts the local Classroom transport directly with Axum and Tauri's Tokio-compatible async runtime. It is not a Node, Python, or executable sidecar. `LocalServerService` owns only the on-demand server lifecycle; it does not own or expose SQLite, `PersistenceService`, `AssetService`, or the full Tauri application state.

The production listener binds to `0.0.0.0:0`, allowing the operating system to choose an unprivileged port while making the service available on all IPv4 interfaces. Automated tests bind only `127.0.0.1:0`. The server status contains the actual port, one UUIDv7 server-instance ID per start, a loopback root URL, classified LAN IPv4 candidate URLs, WebSocket URLs, and local protocol version. It does not expose database paths, asset paths, usernames, hostnames, credentials, or classroom data.

Lifecycle state is narrowly synchronized with `Arc<Mutex<ServerLifecycle>>`: `Stopped`, `Starting`, `Running`, and `Stopping`. The mutex protects only listener metadata, shutdown sender, and task handle; it is never held across an await. Stop removes the running handle while holding the mutex, releases it, signals a oneshot graceful shutdown, awaits the Tauri runtime task, and then records `Stopped`. Repeated start returns the running status and repeated stop returns the stopped status.

The public server exposes only `GET /`, `GET /health`, and `GET /ws`. The root is an embedded static transport page, health returns only `status`, `protocolVersion`, and `serverInstanceId`, and unknown paths return a controlled 404. There is no CORS middleware, directory listing, filesystem access, asset delivery, Teacher administration API, or SQLite access.

WebSocket uses local protocol version `1`. The first message is `server_hello`; the only client message is typed JSON `ping`, which receives request-correlated `pong`. Invalid JSON, unknown versions/types, missing request IDs, oversized messages, and binary frames receive a safe `PROTOCOL_ERROR` response and close safely. Browser upgrades require an `http` Origin whose host and port exactly match the request Host. Authentication, sessions, participants, answer submission, and all classroom data are deferred to Phase 8 or later.

## Consequences

- The Teacher UI starts and stops the server explicitly and shows safe diagnostics, including a Windows Firewall human-QA note. It never creates Firewall rules.
- Network interface discovery reports every non-loopback IPv4 address, ordered as private LAN, link-local, then other adapters; it deliberately does not guess a preferred Wi-Fi adapter.
- Axum, Tokio features, and a small interface-discovery crate are runtime dependencies. The WebSocket client and futures helpers used exclusively by Rust integration tests are dev dependencies.
- Existing SQLite migrations `0001` and `0002` remain unchanged; Phase 7 introduces no schema, session, participant, submission, or media-delivery table.
