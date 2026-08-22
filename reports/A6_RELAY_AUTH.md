# A6 — Relay Networking, Radmin Binding, and Pairing/Auth

Status: implemented. 46/46 tests passing, `tsc --strict` clean (verified in an external sandbox against fastify@5 + zod@4 + @types/node; the repo root has no package.json yet — see "Integration interfaces").

## Files

Owned by this lane:

```
src/main/auth/
  index.ts          re-exports
  controller.ts     AuthController facade (pairing + tokens + revocation)
  pairing.ts        PairingService (code generation, TTL, one-time use, rate limits)
  tokenStore.ts     TokenStore (HMAC token ids, constant-time verify, revoke, persistence port)
  ratelimit.ts      MemoryRateLimiter (sliding-window, injectable clock)
src/main/relay/
  index.ts          re-exports + createRelayManager() convenience wiring
  adapters.ts       interface enumeration, IPv4 candidate collection, Radmin selection logic
  lifecycle.ts      RelayManager (start/stop/rebind/watch), planWatchTick pure decision fn
  jobService.ts     JobService port (DI) aligned with src/main/jobs/types.ts
  http/
    app.ts          buildRelayServer(): Fastify instance, error handler, log redaction
    routes.ts       route registration (public + authenticated plugin)
    schemas.ts      zod validation schemas
    errors.ts       ServiceError
tests/auth/
  pairing.test.ts   ratelimit.test.ts   tokenStore.test.ts
tests/relay/
  helpers.ts        FakeJobService, buildTestApp, pairClient
  adapters.test.ts  lifecycle.test.ts   server.test.ts
reports/
  A6_RELAY_AUTH.md  this file
```

Read-only dependency: `import type { ... } from "../jobs/types.js"` (A5 types). No other lane's files are imported or modified.

## Route contract

Base: `http://<radmin-ipv4>:47821` (port configurable via `RelayManagerOptions.port` or `RELAY_PORT` env).

Unauthenticated:

| Method | Path         | Body / Query                                   | Responses |
|--------|--------------|------------------------------------------------|-----------|
| GET    | `/v1/health` | —                                              | 200 `{ ok: true }` (minimal on purpose) |
| POST   | `/v1/pair`   | `{ code, name? }`                              | 200 `{ clientId, name, token }` (raw token returned exactly once); 400 `validation_error`; 400 `invalid_code`; 410 `expired_code`; 429 `rate_limited` (+ `Retry-After`) |

Authenticated (`Authorization: Bearer <token>`; 401 `unauthorized` + `WWW-Authenticate: Bearer` otherwise):

| Method | Path                            | Body / Query                                              | Responses |
|--------|---------------------------------|-----------------------------------------------------------|-----------|
| POST   | `/v1/intakes`                   | `{ source: {kind:"magnet"\|"url", value}, idempotencyKey? }` | 201 `IntakeDraftView`; 400 validation |
| GET    | `/v1/intakes/:id`               | —                                                         | 200 view / 404 `job_not_found` |
| POST   | `/v1/jobs`                      | `{ intakeId, selection?, zipRequired?, idempotencyKey? }` | 201 `JobRecord`; 400 validation |
| GET    | `/v1/jobs`                      | —                                                         | 200 `{ jobs: JobRecord[] }` |
| GET    | `/v1/jobs/:id`                  | —                                                         | 200 authoritative snapshot / 404 |
| POST   | `/v1/jobs/:id/cancel`           | —                                                         | 200 snapshot / 404 / 409 `job_conflict` |
| POST   | `/v1/jobs/:id/retry-packaging`  | —                                                         | 200 snapshot |
| POST   | `/v1/jobs/:id/retry-upload`     | —                                                         | 200 snapshot |
| POST   | `/v1/jobs/:id/recheck-storage`  | —                                                         | 200 snapshot |
| GET    | `/v1/history`                   | `?limit=1..500`                                           | 200 `{ history: JobRecord[] }` |
| GET    | `/v1/server/status`             | —                                                         | 200 `{ ok, server, transport: RelaySnapshot, pairedClients, time }` |

Notes:
- Idempotency key resolution: `Idempotency-Key` header wins over body `idempotencyKey`; both passed verbatim into `JobService.createIntake/createJob`. No dedup is done at the HTTP layer — the engine owns dedup semantics.
- GET job responses are full authoritative snapshots from the engine.
- No CORS handling is registered at all (desktop client over Radmin is not a browser app); requests presenting unexpected origins are simply treated like any other client and must authenticate.

## Pairing model

- Server dashboard action "Pair New Client" calls `AuthController.beginPairing()` → `{ code, expiresAt }`.
- Code: 8 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no I/L/O/0/1), rejection-free modulo over `crypto.randomBytes` → ~40 bits entropy. Human-enterable, uppercase.
- TTL: 10 minutes (default). One-time use: consumed on success. Codes stored only as SHA-256 hashes; comparison via hash lookup (fixed-length digests).
- Rate limiting (in-memory sliding window, no Redis): per-IP 10 attempts / 10 min and global 100 attempts / 10 min (configurable). 429 carries `Retry-After`. Max 5 active codes; oldest evicted beyond that.
- On success: permanent bearer token = `crypto.randomBytes(32)` base64url (256-bit, 43 chars). Raw token returned once in the pair response; server stores only HMAC-SHA256(token, secret) as `tokenId`. The pairing code never becomes a secret.
- Revocation: `AuthController.revokeClient(clientId)` / `revokeAll()`; revoked tokens fail verification immediately.
- Token hash secret: random per process unless injected. For tokens to survive restarts, Electron main should persist `(secret, digest[])` via safeStorage-backed storage (see integration).

## Radmin detection / binding rules

Detection (`src/main/relay/adapters.ts`, Node APIs only — `os.networkInterfaces()`):
1. Collect non-internal IPv4 candidates (valid dotted-quad, explicitly excluding `0.0.0.0` and loopback; IPv6 ignored).
2. Strong match: adapter name matches `/radmin|famatech/i`.
3. Configured match: `preferredAdapterNames` substring match (case-insensitive).
4. Explicit override: `overrideAddress` must exist among candidates, else `override_not_found`.
5. Otherwise: `ambiguous` when multiple candidates exist (dashboard lets the user pick from the safe list); optional `allowUnmatchedSingleAdapter` binds the sole candidate only when explicitly enabled. The 26.x.x.x range is deliberately NOT used as an identification heuristic.

Lifecycle (`RelayManager`):
- Binds ONLY the selected address; there is no code path that can bind `0.0.0.0` (filtered at candidate level + hard guard before `listen`). No silent fallback to Wi-Fi/Ethernet.
- States: `stopped | starting | listening | unavailable | error`; `snapshot()` exposes state, host/port, adapterName/address, bindError (`radmin_adapter_not_detected`, `radmin_adapter_lost`, `override_address_not_found`, `unsafe_bind_target`, `bind_failed:E*`), and detected candidates — this is the renderer/dashboard interface.
- Watcher (default poll 5s, injectable): adapter disappears → listener closes, state `unavailable` (watcher keeps running, never rebinds elsewhere). Adapter returns same name → rebinds automatically, including to a NEW address (`adapter_address_changed` / `adapter_returned` causes surfaced in logs). Decision logic isolated in pure `planWatchTick()` for tests.
- `start()/stop()/rebind({address?})` are serialized through an internal promise chain; suitable for Electron main. Transport stop does NOT touch the JobService pipeline (work lifecycle is separate; verified by test).

## Firewall caveat

No firewall manipulation is performed in this lane (no netsh, no privileged calls). Binding failures surface as `state: "error"` with `bindError: "bind_failed:<code>"` in the snapshot for UI display. Integration note for the UI lane: first launch on a new Radmin network may require a Windows Defender Firewall inbound rule for the Electron executable on the Radmin adapter profile (Private/Public); suggest offering a documented command (`netsh advfirewall firewall add rule name="Viking Relay" dir=in action=allow protocol=TCP localport=47821`) behind an explicit user-consented elevation prompt, never silent.

## Security posture

- Constant-time comparison (`crypto.timingSafeEqual`) for token verification (over fixed-length HMAC digests).
- Structured pino logs with `redact` on `req.headers.authorization` and `req.headers.cookie` (`[REDACTED]`); request serializer includes headers so redaction is exercised end-to-end (tested). Tokens/codes never logged.
- Error responses never include stack traces; unknown errors → 500 `{ error: "internal_error" }` with details only in logs.
- Body limit 128 KB default (configurable); oversized → 413 `payload_too_large`.
- Zod strict-object validation everywhere; magnet URIs must start `magnet:?`; URLs restricted to http(s); ids/idempotency keys pattern-restricted; unknown fields rejected.
- qBittorrent credentials/API keys and Viking credentials never enter relay payloads or responses (engine stays behind the JobService port).

## Tests / results

Runner: `node:test` via tsx, Fastify `inject` for all HTTP paths; real sockets for lifecycle binding tests (loopback stand-ins for Radmin addresses).

```
tests/auth/pairing.test.ts        8 pass  (happy path, wrong/expired codes, rate limits,
                                           cap eviction, hashed-at-rest, case/space tolerance)
tests/auth/ratelimit.test.ts      4 pass
tests/auth/tokenStore.test.ts     6 pass  (round-trip, tamper, malformed, hash-only digest,
                                           revoke client/all, persistence round-trip)
tests/relay/adapters.test.ts      9 pass  (name/preferred/override selection, ambiguity,
                                           single-candidate opt-in, 0.0.0.0 never selected,
                                           loopback/IPv6 exclusion, numeric family)
tests/relay/lifecycle.test.ts     6 pass  (planWatchTick matrix; live bind+health; adapter loss
                                           -> unavailable; return w/ different address -> live
                                           rebind serving health; no-fallback-to-Wi-Fi;
                                           explicit rebind accept/reject; transport vs jobs)
tests/relay/server.test.ts       13 pass  (health; pair happy/replay; wrong/expired over HTTP;
                                           rate limit + Retry-After; missing/invalid/revoked auth;
                                           log redaction of Authorization + raw token; delegation
                                           to all JobService methods; idempotency header precedence;
                                           validation matrix; 413; 404s; server/status snapshot)
Total: 46 pass / 0 fail.  tsc --strict --noEmit: clean.
```

## Integration interfaces

For Electron main (root lane wiring):

```ts
import { createRelayManager } from "./relay/index.js";   // src/main/relay
import { AuthController } from "./auth/index.js";        // src/main/auth

const auth = new AuthController({
  // optional TokenPersistence { load(), save(digest) } backed by safeStorage so
  // paired clients survive restarts; omit => ephemeral tokens
});
const relay = createRelayManager({
  auth,
  jobs,                 // A5 JobService implementation (injected, not owned here)
  port: 47821,          // or RELAY_PORT env
  pollIntervalMs: 5000, // 0 disables the watcher
  selection: { preferredAdapterNames: [], overrideAddress: null },
});

await relay.start();
relay.snapshot();                       // -> renderer dashboard state
const off = relay.onChange(cb);         // push updates to dashboard
await relay.rebind({ address });        // user picked a specific adapter address
await relay.stop();                     // transport only; job pipeline unaffected

// dashboard actions:
auth.beginPairing();                    // "Pair New Client"
auth.revokeClient(id); auth.revokeAll(); auth.listClients();
```

Expected root package.json deps (not added by this lane): `fastify@^5`, `zod@^4`, dev: `tsx`, `typescript`, `@types/node`. Suggested scripts: `"typecheck": "tsc --noEmit"`, `"test": "tsx --test tests/**/*.test.ts"` (list files explicitly if globbing unsupported).

Open items for other lanes:
- Root/shared: persist `(tokenHashSecret, StoredToken[])` via safeStorage; feed into `new TokenStore(persistence, secret)`.
- Jobs lane: implement the `JobService` port in `src/main/relay/jobService.ts` (shapes already align with `jobs/types.ts`); throw `jobNotFound`/`jobConflict` helpers for 404/409 mapping.
- Renderer lane: consume `RelaySnapshot` from `/v1/server/status` or `relay.onChange` for the dashboard; offer manual adapter choice from `snapshot.candidates` when state is `unavailable` with `radmin_adapter_not_detected`.
