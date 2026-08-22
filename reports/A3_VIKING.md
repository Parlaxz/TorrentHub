# A3 — Viking Fast Multipart Upload Engine

Status: **implemented, 22/22 tests passing** (Node built-in test runner).
Scope: `src/main/viking/**`, `tests/viking/**`, this report. No shared files touched.

## 1. Verified API behavior (source of truth)

Official documentation: <https://vikingfile.com/api> ("ViKiNG FiLE" API page, fetched during
implementation). The service is S3-multipart-style. Verified endpoints:

### POST `/api/get-upload-url`

- Request: form field `size` (required) — file size in bytes.
- Response:

```json
{
  "uploadId": "ANWA...SE1M",
  "key": "rZ2h9ZqVQi",
  "partSize": 1073741824,
  "numberParts": 3,
  "urls": [
    "https://upload.vikingfile.com/rZ2h9ZqVQi?partNumber=1&uploadId=ANWA...",
    "https://upload.vikingfile.com/rZ2h9ZqVQi?partNumber=2&uploadId=ANWA...",
    "https://upload.vikingfile.com/rZ2h9ZqVQi?partNumber=3&uploadId=ANWA..."
  ]
}
```

Observed `partSize` in docs is 1 GiB; the client never assumes a value and always uses the
server-provided one.

### PUT each signed URL

- Body: the raw byte range for that part (`Content-Length` set; no extra headers added so we do
  not break signature validation).
- Success: response carries the part ETag **in a response header** (`ETag`). Docs show an unquoted
  hex example (`51887c42e7e3ec990574e8fc546faae5…`); real S3-style backends often quote it. The
  client captures the header value **verbatim** and submits it unchanged.

### POST `/api/complete-upload`

- Request: urlencoded form:
  - `key` (required), `uploadId` (required)
  - `parts[i][PartNumber]` / `parts[i][ETag]` per part (docs literally show
    `parts[0][PartNumber]=1&parts[0][ETag]=…`)
  - `name` (required) — filename
  - `user` (required) — account hash; **empty string = anonymous upload** (documented)
  - optional `path` ("Folder/My sub folder"), optional `pathPublicShare`
- Response:

```json
{ "name": "example.txt", "size": 12345, "hash": "TPRSfLvcIu", "url": "https://vikingfile.com/f/TPRSfLvcIu" }
```

### POST `/api/check-file`

- Request: `hash` (single hash or array of up to 100).
- Response: `{ "exist": true, "name": "example.txt", "size": 12345 }`.
- Documented and deterministic → used by `verifyUploadedFile()`.

Also documented but out of scope here: `get-server` + legacy single-request upload, remote-link
upload, `delete-file`, `rename-file`, `list-files`.

## 2. Anonymous vs account behavior

`user` is required-but-may-be-empty: anonymous upload is officially supported by sending an empty
`user`. `VikingClientOptions.userHash` is optional; when absent the client sends `user=` (empty).
The hash lives only in main-process memory and outbound request bodies; it is redacted from error
body snippets and never logged (logger hook receives sanitized metadata only). Nothing here
exposes it to the renderer.

## 3. Exported integration interface

```ts
import { VikingClient, VikingError, computeParts } from 'src/main/viking'

const client = new VikingClient({
  baseUrl?: string          // default https://vikingfile.com (tests override)
  userHash?: string         // '' => anonymous
  timeoutMs?: number        // per-request STALL timeout, default 60_000
  concurrency?: number      // simultaneous parts, default 3
  backoff?: { baseDelayMs?, maxDelayMs?, maxAttempts? }   // defaults 500 / 15_000 / 4
  logger?: { debug|info|warn|error(message, meta?) }
})

await client.createMultipartSession({ path, size, name })            // -> validated session
await client.uploadParts(session, file, { signal?, onProgress?,
                                          progressIntervalMs?, concurrency? }) // -> CompletedPart[]
await client.completeMultipart(session, parts,
                               { name, path?, pathPublicShare? }, { signal? }) // -> { url, hash, name, size? }
await client.verifyUploadedFile(hash, { signal?, expectedSize? })    // -> { exists, name?, size? }
await client.uploadFile(file, { signal?, onProgress?, verify?, ... }) // session→parts→complete (+verify)
```

Errors are `VikingError` with structured fields: `kind`
(`invalid_input | malformed_response | network | timeout | http_status | aborted |
verification_failed`), `retryable`, `statusCode`, `partNumber`, `attempt`, `bodySnippet`,
`retryAfterMs`. UI can map `kind`/`retryable` to a "Retry Upload" affordance directly.

## 4. Progress implementation

- Transport is **node:http/https request streams**, not `fetch`: chunk counts are taken exactly
  where bytes are handed to the socket layer (`onBytesWritten` on each body chunk), which native
  fetch does not expose reliably for streamed bodies. No synthetic/faked progress.
- Parts are streamed with `fs.createReadStream({start, end})` — memory stays bounded at the
  stream high-water mark regardless of part size (docs show 1 GiB parts).
- `uploadedBytes` counts transmitted bytes; on any failed attempt that part's contribution is
  rolled back so totals never double-count retransmits. Final value always equals file size.
- Speed = rolling average over a 5 s sliding window; ETA = remaining / speed (null until speed
  is known). Progress events are throttled (default 100 ms) plus forced on every part completion.

## 5. Concurrency & retry choices

- Worker pool over part indices, **default 3 simultaneous parts** (configurable via
  `concurrency`; tests assert the bound holds and that parallelism actually happens).
- Retry classification (transient only): connection resets/refused, `EPIPE`, DNS-temp failures,
  stall timeouts, HTTP **408 / 429 / all 5xx**. Everything else (400/401/403/404/409…) fails
  immediately with `retryable: false`.
- Bounded exponential backoff with full jitter: base 500 ms, cap 15 s, maxAttempts 4 (i.e. 3
  retries), configurable. `Retry-After` on 429/503 is honored (capped at 60 s).
- Every attempt re-streams its byte range from disk, so retries are exact and the source file is
  only ever opened read-only. Abort/cancel via `AbortSignal` on every public call; cancellation
  destroys in-flight requests, stops scheduling new parts, and rejects with `kind: 'aborted'`.

## 6. Tests

Run: `node tests/viking/run.mjs` (self-contained: compiles src+tests to CJS in the temp dir with
`tsc --strict`, then runs Node's built-in test runner against a local mock Viking server — no repo
package.json changes needed).

Result: **22 pass / 0 fail (~2.5 s)** covering:

- session parsing: valid shape; missing fields; `urls.length !== numberParts`; invalid partSize;
  non-JSON body; HTTP 503 → retryable `http_status`
- part boundaries: byte-exact range reassembly incl. partial last part (`computeParts` unit tests
  + server-side payload comparison)
- ETag capture: submitted `parts[i][ETag]` equal the exact header values issued per part
- complete-upload payload: key/uploadId/name/user/parts encoding; anonymous (`user=''`) and
  configured user hash variants
- successful result mapping: canonical `url`, `hash`, `name`, `size`
- 3-way concurrency bound (max observed ≤ 3, ≥ 2 in parallel)
- byte progress: monotonic, intermediate events, final bytes == size, speed/ETA present
- transient retry: 500×2 then success; connection reset; stall-timeout retry; 429 + Retry-After
- permanent 4xx: exactly 1 attempt, no complete-upload issued
- persistent 5xx: gives up after maxAttempts (4)
- cancellation: mid-upload abort rejects promptly, no completion call; pre-aborted signal fails
  before any I/O
- source file untouched after failure (content + mtime asserted)

## 7. Undocumented limitations / caveats

- **No documented abort endpoint**: there is no `abort-multipart-upload`. If parts were uploaded
  but complete-upload never happens (permanent failure, cancel), the server-side multipart
  session is simply abandoned; Viking's lifecycle for orphaned sessions is undocumented. We make
  no cleanup call (none exists).
- **No resumability**: signed URLs carry `uploadId`/`key` in the query, but there is no documented
  way to re-list parts or refresh expired URLs, and no documented URL/session expiry semantics at
  all. Per the crash policy we therefore implement **no journal, no resume DB, no URL refresh**;
  restart ⇒ job INTERRUPTED, upload restarted from scratch by higher-level logic.
- **Error format/rate limits undocumented**: non-2xx handling is defensive (status code +
  best-effort `error` message extraction + truncated snippet). Rate-limit behavior unknown beyond
  generic 429 handling.
- `check-file` supports arrays up to 100 hashes per the docs; we intentionally implement only the
  single-hash form (sufficient for pre-cleanup verification) to keep the surface explicit.
- Docs' JSON examples contain typos (trailing commas); parser is lenient about whitespace/BOM but
  strict about required fields.
