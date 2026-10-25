# Classroom Remote relay (Phase 16E)

This Worker hosts the shared Remote Student application and relays its join, bounded realtime messages and authenticated read-only detail/media requests to the authenticated Teacher. D1 holds only activation-code hashes and installation identity hashes. A SQLite-backed `ClassroomSession` Durable Object holds one Remote Session's relay metadata. Classroom decisions and data remain in Rust and the Teacher application's local database.

## Local verification

From the repository root, build the shared Student source for both transports:

```powershell
pnpm --filter @classtools/student build
pnpm --filter @classtools/student build:remote
```

Create an ignored `apps/relay/.dev.vars` containing a random local-only `OPERATOR_TOKEN`, then run:

```powershell
pnpm --filter @classtools/relay exec wrangler d1 migrations apply INSTALLATIONS --local
pnpm --filter @classtools/relay dev --port 8787
```

In another terminal, run the Phase 16D targeted tests:

```powershell
pnpm --filter @classtools/relay exec node --test src/realtime.test.js src/lifecycle.test.js
pnpm --filter @classtools/backend-contract exec vitest run src/remote.test.ts
```

The integration tests use the protected operator endpoint only when its local token is present. The existing `test:restart` smoke keeps tickets and credentials in process memory; its temporary Wrangler state is removed when possible.

To run the Teacher Rust smoke against local Wrangler, set `CLASSROOM_REMOTE_BASE_URL=http://127.0.0.1:8787/` and set `CLASSROOM_TEST_OPERATOR_TOKEN` to the local token. Then run `cargo test --lib application::remote_control::tests` from `apps/teacher/src-tauri`. The test uses an isolated Windows Credential Manager target and removes it when finished.

## Production provisioning

The production Worker does not require an `OPERATOR_TOKEN` secret. Without that secret, the operator HTTP endpoint always rejects requests.

### Operator Quick Start

Use a Cloudflare operator account already authenticated with Wrangler and authorized to write the production `INSTALLATIONS` D1 database. From the repository root, run:

```powershell
pnpm --filter @classtools/relay run activation:create:prod
```

The CLI generates 32 cryptographically random bytes with Node.js built-in `node:crypto`, encodes a 43-character base64url activation code, and inserts only its SHA-256 hash with a ten-minute expiry through the existing Wrangler CLI using `--remote`. It prints the code only after Wrangler exits successfully and confirms exactly one inserted row. A failure exits nonzero without releasing a code or echoing child-process output. Keep the displayed code only long enough to enroll the intended Teacher; do not redirect it to a repository file or log.

This is an operator-only local tool. It adds no public API, stores no Cloudflare management credential in Teacher, and does not deploy or apply migrations. A failed or uncertain insert may leave an unused short-lived hash; retry generates a fresh code.

Run the isolated focused tests (they stub Wrangler and never contact production):

```powershell
pnpm --filter @classtools/relay run test:activation
```

### Manual provisioning (troubleshooting)

If the CLI fails, check Wrangler authentication and D1 permissions. The original Windows PowerShell method remains available below. Keep the raw code only long enough to deliver it to the intended Teacher installation:

```powershell
$bytes = New-Object byte[] 32

$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()

$code = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')

$sha = [System.Security.Cryptography.SHA256]::Create()
$hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($code))
$sha.Dispose()

$hash = -join ($hashBytes | ForEach-Object { $_.ToString("x2") })

$expires = [DateTimeOffset]::UtcNow.AddMinutes(10).ToUnixTimeMilliseconds()

pnpm --filter @classtools/relay exec wrangler d1 execute INSTALLATIONS --remote --command "INSERT INTO activation_codes(code_hash, expires_at, consumed_at) VALUES ('$hash', $expires, NULL)"
if ($LASTEXITCODE -ne 0) { throw "Activation-code provisioning failed; no code was released." }

Write-Output $code
```

This example is compatible with Windows PowerShell 5.1. To check the generated lengths, run the following in the same shell; expect `43` and `64`:

```powershell
$code.Length
$hash.Length
```

Run the remote D1 migration before the first deployment:

```powershell
pnpm --filter @classtools/relay exec wrangler d1 migrations apply INSTALLATIONS --remote
pnpm --filter @classtools/relay run deploy
```

The Teacher binary must be built with `CLASSROOM_REMOTE_BASE_URL` set to the deployed HTTPS origin, including a trailing slash. Debug builds may use loopback HTTP for local verification. The installation credential is stored with local-machine persistence in Windows Credential Manager and is never written to the Classroom database.

An operator can revoke an installation through authenticated Wrangler D1 access by setting `status='REVOKED'` and `revoked_at` to the current Unix epoch in milliseconds for its `id`. Revocation blocks new authenticated control requests. A ticket issued before revocation can remain valid until its short expiry; immediate kill of existing sessions is outside Phase 16C.

## Remote Student transport

`/join/<remoteSessionId>` loads the same Student source as the LAN build. The public locator is not a credential. `GET /v1/sessions/<id>/bootstrap` returns only generic availability and exact Remote Protocol version 1.

The separate join request is `POST /v1/sessions/<id>/join`, with `remoteProtocolVersion`, UUID `joinAttemptId`, `seatNumber`, and `name`. The DO forwards a typed `CONTROL join` request to the current Teacher generation. Rust performs the existing roster admission and returns `{ info, participant }`. Teacher-side transient recovery retains successful results for a bounded period, so retrying the same attempt and identity can recover a lost response without creating a duplicate participant. A changed identity on the same attempt is rejected. The DO keeps only an in-memory request correlation, capped at 128 pending requests with an eight-second timeout; it does not persist join bodies or results.

Student opens same-origin `/v1/sessions/<id>/ws` without credentials in its URL. A DO accepts at most 512 Student sockets. Student must send one `AUTH` envelope containing the existing `participant_auth` message within approximately five seconds. The DO adds a connection UUID and Teacher generation, then waits for Rust's correlated validation response. Only a matching successful response authenticates the socket. Personalized sync and realtime messages cannot be routed to an unauthenticated socket. An unsuccessful AUTH requires a new connection. A relay AUTH deadline closes the socket with retryable `TEACHER_UNAVAILABLE`, preserving the existing credential for reconnect; transport latency does not invalidate a Rust-issued credential.

`REALTIME` wraps the existing Classroom ClientMessage and ServerMessage contracts. Quiz, Grouping, bounded Peer Review, ACKs, and presence ping messages are forwarded to Rust; the DO never generates domain ACKs or presence responses. Complete UTF-8 envelopes, including added routing metadata, are limited to 64 KiB. A routed `MESSAGE_TOO_LARGE` reports that a bounded payload cannot be transported; domain data is never silently truncated.

When Cloudflare observes Teacher close/error, Student immediately receives `CONTROL teacher_offline`; mutations are unavailable and are not queued. A failed Student recipient does not prevent broadcasts to the remaining sockets. Silent network loss may not produce an immediate TCP close, so the existing twenty-second Teacher `CONTROL ping` renews a sixty-second transport-liveness deadline. The same earliest-deadline DO alarm expires it and proactively pushes offline without Student interaction or polling. Only a valid ping from the current Teacher generation renews that deadline. A new Teacher generation invalidates every Student authentication and sends `CONTROL REAUTH_REQUIRED`. Student reuses its existing credential, Rust validates it again, and personalized sync restores authoritative state. A DO wake from hibernation also invalidates Student authentication. One earliest-deadline DO alarm serves Teacher liveness, relay expiry, pending join deadlines, and unauthenticated sockets.

Socket attachments contain only role, opaque connection UUID, generation, auth state, auth correlation UUID, and deadline. DO persistent storage contains only relay lifecycle and hashed Teacher-ticket metadata. Participant credentials, roster, questions, answers, grading, Grouping, and Peer Review payloads are not persisted in Cloudflare or logged. Credentials appear only in in-memory AUTH/join/HTTP transport and the existing Student origin's browser storage.

Phase 16E adds eight strictly allowlisted, independently Rust-authorized GET operations for Peer Review/Essay/feedback and image/PDF media. HTTP_RELAY uses 32 KiB chunks, a four-credit window, bounded transient correlations and separate detail/media deadlines. FixedLengthStream enforces complete HTTP responses across cancellation and Teacher-generation changes. Arbitrary URLs/paths/methods, generic proxying, R2, cloud domain/media persistence and offline queues remain unavailable. See [Remote HTTP contract, bounds and synthetic benchmark](../../docs/remote-http-relay.md).
