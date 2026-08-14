# ADR-016: Local Session and Participant identity

## Status

Accepted for Phase 8.

## Decision

`serverInstanceId`, `sessionId`, and `participantId` are separate UUIDv7 identities. A Local Session belongs to one Classroom and has only `CREATED`, `LOBBY`, and `ENDED` transitions in this phase. SQLite enforces that only one non-terminal Local Session exists.

The join code is an eight-character CSPRNG admission code, not an authentication token. Students submit their own seat number and name; the server normalizes with trim plus Unicode NFKC and verifies the pair without disclosing roster contents.

Successful joins issue a 32-byte CSPRNG base64url participant credential once. SQLite stores only its SHA-256 hash. The Student app stores the credential in `localStorage`, namespaced by server and session identity, so a reload can reconnect. It clears it after authentication failure or session end. Credentials are never placed in URLs or QR payloads.

`Student` is a durable roster record; `Participant` is a session snapshot containing its own seat number and display name. The optional roster FK uses `ON DELETE SET NULL` so historical snapshots remain useful.

On a new Teacher process startup, all previous non-terminal local sessions are marked `ENDED` with a restart reason. Full crash recovery remains future work.

## Consequences

The public server exposes only join information, join submission, Student assets, and authenticated WebSocket lobby state. It never exposes a roster or participant list. Teacher participant views are Tauri IPC only.

Teacher Presence is non-persistent runtime state, separate from durable Participant records and credentials. The local server records `participantId -> connectionId -> lastSeen` leases under a narrow in-memory lock. An authenticated Student renews its own lease through the existing typed `ping`/`pong` protocol every 3 seconds; queries consider it online only if at least one lease is no older than 7 seconds. This makes abrupt network loss converge to offline without storing presence or secrets in SQLite.
