# Classroom Remote relay (Phase 16C)

This Worker hosts the Remote Student shell and the authenticated Teacher control plane. D1 holds only activation-code hashes and installation identity hashes. A SQLite-backed `ClassroomSession` Durable Object holds one Remote Session's relay state. Classroom data remains in the Teacher application's local database.

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

In another terminal, run `pnpm --filter @classtools/relay test` and `pnpm --filter @classtools/relay test:restart`. The integration test uses the protected operator endpoint only when its local token is present. The restart test keeps tickets and credentials in process memory; its temporary Wrangler state is removed when possible.

To run the Teacher Rust smoke against local Wrangler, set `CLASSROOM_REMOTE_BASE_URL=http://127.0.0.1:8787/` and set `CLASSROOM_TEST_OPERATOR_TOKEN` to the local token. Then run `cargo test --lib application::remote_control::tests` from `apps/teacher/src-tauri`. The test uses an isolated Windows Credential Manager target and removes it when finished.

## Production provisioning

The production Worker does not require an `OPERATOR_TOKEN` secret. Without that secret, the operator HTTP endpoint always rejects requests. A Cloudflare operator can create a short-lived, single-use activation code through authenticated Wrangler access to D1. Keep the raw code only long enough to deliver it to the test Teacher installation:

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

The remote Student shell only reports generic bootstrap availability. Student join, participant authentication, classroom payloads, realtime operations, and media relay are not enabled in this phase.
