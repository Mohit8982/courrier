# Multi-Courier Integration Platform — Interview Q&A

A curated set of the questions most likely to come up in a review /
interview round, with concise answers grounded in the code that
actually ships in this repo. File paths reference the actual files in
`backend/src/…`.

Table of contents

1. [Architecture & Layering](#1-architecture--layering)
2. [Design Patterns](#2-design-patterns)
3. [Adapters (Urbanebolt, Mock)](#3-adapters-urbanebolt-mock)
4. [CourierFactory](#4-courierfactory)
5. [Retry + 401 Refresh](#5-retry--401-refresh)
6. [Idempotency](#6-idempotency)
7. [Status Normalization](#7-status-normalization)
8. [Bulk Processing (BullMQ)](#8-bulk-processing-bullmq)
9. [Errors](#9-errors)
10. [Database / Prisma](#10-database--prisma)
11. [Validation (Zod)](#11-validation-zod)
12. [Logging & Observability](#12-logging--observability)
13. [Testing](#13-testing)
14. [Trade-offs & Extensions](#14-trade-offs--extensions)
15. [Rapid-fire code-reading questions](#15-rapid-fire-code-reading-questions)

---

## 1. Architecture & Layering

**Q1.1 — Walk me through the request flow for `POST /api/orders`.**

```
Route → Controller → Zod validator → OrderService
     → CourierFactory.create(name) → adapter.createShipment()
     → OrderRepository.create() + TrackingRepository.append()
     → JSON response
```

- `routes/order.routes.ts` wires the URL to `OrderController.create`.
- The controller calls `createOrderSchema.parse(req.body)` (`validators/order.validator.ts`) — the ONLY layer that shapes input.
- `OrderService.create` (`services/OrderService.ts`) is the orchestrator: idempotency check → courier lookup → factory → adapter call → repo writes.
- The adapter is the only layer that talks to the courier API.
- Repositories are Prisma-only (no business rules).

**Q1.2 — Why the strict layer boundaries?**

To keep the "OCP promise" real:

- New courier = 1 new adapter file + 1 factory registration.
- Controllers/services/validators/repos never mention any specific courier.
  Cross-layer coupling would make that promise a lie.

**Q1.3 — What lives in a Service vs. a Controller vs. a Repository?**

| Layer      | Contains                                              | Does NOT contain                                     |
| ---------- | ----------------------------------------------------- | ---------------------------------------------------- |
| Controller | Zod parsing, delegate to service, HTTP response shape | DB, courier HTTP, business rules                     |
| Service    | Business rules, idempotency, orchestration            | HTTP status codes, direct Prisma calls, courier SDKs |
| Repository | Prisma queries                                        | Any conditional business logic                       |
| Adapter    | Courier HTTP + status normalization + auth            | DB, other couriers                                   |

You can literally grep for `prisma.` in controllers → zero hits. Grep for `axios` in services → zero hits.

---

## 2. Design Patterns

**Q2.1 — Which patterns are used and why?**

| Pattern             | Where                                                                               | Why                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Adapter**         | `couriers/interfaces/ICourierAdapter.ts` + `BaseCourierAdapter` + concrete adapters | Each courier's native API is behind one uniform interface.                                                      |
| **Factory**         | `couriers/factory/CourierFactory.ts`                                                | Runtime resolution by name; hides construction; caches instances.                                               |
| **Strategy**        | Choosing an adapter at runtime via the factory                                      | The Service selects a strategy per request (per courierName).                                                   |
| **Repository**      | `repositories/*Repository.ts`                                                       | Isolates persistence; makes services trivially unit-testable with mocks.                                        |
| **Template Method** | `BaseCourierAdapter.executeAuthed`                                                  | Shared skeleton for `retry → 401-refresh → single retry`; each courier provides `authenticate()` + per-op call. |
| **Constructor DI**  | Every service/repo takes collaborators in the constructor with default fallbacks    | Prod uses defaults, tests inject mocks — no framework required.                                                 |

**Q2.2 — Why registry-based factory instead of `if/else` in the factory?**

```ts
CourierFactory.register("Urbanebolt", UrbaneboltAdapter);
```

Adding a new adapter requires touching exactly one place (the factory
registration line — usually kept inside the adapter file for
"self-registration" or in a central bootstrap). No `switch` statement to
edit. Also lets tests register a `FakeAdapter` (see
`tests/unit/factory.test.ts`).

**Q2.3 — Show me the OCP guarantee in code.**

`tests/unit/factory.test.ts` — “OCP: registering a new adapter is the
only change needed” — proves that a new adapter class with a single
`register()` call works end-to-end through the factory. Services and
controllers are untouched.

---

## 3. Adapters (Urbanebolt, Mock)

**Q3.1 — What does `ICourierAdapter` require?**

```ts
createShipment(input): Promise<CreateShipmentResult>
trackShipment(trackingNumber, courierOrderId?): Promise<TrackingResult>
cancelShipment(input): Promise<CancelShipmentResult>
courierName: string
```

Inputs/outputs are canonical types (defined in
`interfaces/ICourierAdapter.ts`). This is the seam.

**Q3.2 — Walk through `UrbaneboltAdapter.createShipment`.**

1. Build the Urbanebolt-shaped `manifest` payload from the canonical
   input (`buildManifestPayload`).
2. `executeAuthed('createShipment', token => http.post('/api/v1/services/manifest/', payload, { Bearer }))`.
3. `ensureOk` validates 2xx and unwraps the body.
4. Read `awb`, `courier_order_id`, `status` (with `data.` fallback since
   the API sometimes wraps under `data`).
5. Normalize status via `mapUrbaneboltStatus`.
6. Return canonical `CreateShipmentResult` (with `rawResponse` for audit).

**Q3.3 — What does `MockCourierAdapter` do differently?**

- Prefers the real HTTP call (so tests can drive it via `nock`), but
  falls back to **deterministic** results (`MOCK-<hash>` /
  `MCT<hash>`) on network failure — this lets local dev + integration
  tests run without any external service.
- We distinguish by inspecting `CourierAPIError.upstreamStatus`:
  - `undefined` ⇒ network error ⇒ fallback.
  - defined ⇒ upstream returned a real HTTP error ⇒ propagate.

**Q3.4 — Where is the courier-specific payload transformation?**

`UrbaneboltAdapter.buildManifestPayload`. Everywhere else uses the
canonical `CreateShipmentInput` (`orderId`, `pickup`, `delivery`,
`package`, `payment`, …). Only the adapter knows Urbanebolt uses
`address1`, `breadth`, `payment_mode`, etc.

---

## 4. CourierFactory

**Q4.1 — How is a new courier added?**

1. Write `MyAdapter extends BaseCourierAdapter`.
2. Add ONE line: `CourierFactory.register('MyCo', MyAdapter);`
3. (Optional) Add a status map + seed a `Courier` row.

That's it. No route/controller/service/repository/DTO changes.

**Q4.2 — Why cache adapter instances?**

- Reuses the auth-token cache inside `BaseCourierAdapter` across
  requests → fewer courier auth calls.
- Cheaper: no per-request `new HttpClient(...)`.
- Trade-off: adapters must be stateless w.r.t. per-request data (which
  they are — only auth token is per-instance).

**Q4.3 — How do you reset the cache in tests?**

`CourierFactory.resetInstances()` between tests (registry stays).
`CourierFactory._resetAll()` also re-registers the built-ins (used in
`factory.test.ts`).

---

## 5. Retry + 401 Refresh

**Q5.1 — Where does retry live and why there?**

`BaseCourierAdapter.executeAuthed` calls `utils/retry.ts:withRetry`.
It is intentionally in the **adapter layer only** — services should
not know that courier calls can be transient. Adapter is the "network
boundary" so retry belongs here.

**Q5.2 — What counts as retryable?**

`isRetryableError`:

- No `err.response` (real network error) → retry.
- `err.response.status >= 500` → retry.
- 4xx → NOT retryable (surfaced as `CourierAPIError`).

**Q5.3 — Show the 401 handling flow.**

Inside `executeAuthed`:

1. First call using cached token.
2. If response is 401:
   a. Log it, clear the cached token.
   b. Call `attempt(true)` which forces a fresh `authenticate()`.
   c. Retry the operation **exactly once**.
3. If still 401 → throw `AuthenticationError`.

401 retry is _distinct from_ the exponential backoff retry.

**Q5.4 — Why not just make 5xx go through `attempt` again on 401 as well?**

Different failure modes deserve different treatment:

- **5xx / network** → assume transient → exponential backoff.
- **401** → probably expired token → refresh & retry exactly once. Doing more risks locking accounts on courier side.

**Q5.5 — Test that proves 401 refresh works?**

`tests/unit/urbaneboltAdapter.test.ts` → `handles 401 -> refresh token -> retry once`. It stubs auth twice and manifest twice, expects the retry to succeed with the second token.

---

## 6. Idempotency

**Q6.1 — How is idempotency enforced?**

Two-layer:

- **DB:** `Order.orderId @unique` — a race can't create two orders with the same ID.
- **Service:** `OrderService.create` first calls `OrderRepository.findByOrderId`. If found, returns the existing order with `wasExisting: true`.

**Q6.2 — What about the race between two simultaneous requests?**

Even if both pass `findByOrderId === null`, the DB unique constraint
prevents a second insert. In future work, that unique constraint would
be caught as `P2002` and mapped to the same `existing` return path so
the second request also gets a 200 idempotent response instead of 500.
(Current code doesn't yet catch that specific race — flagged as a
follow-up.)

**Q6.3 — How is the HTTP contract communicated?**

- First success: `201 { data, idempotent: false }`
- Repeat: `200 { data, idempotent: true }`

Different HTTP status per case gives callers a signal without breaking
the shape.

**Q6.4 — Is bulk create idempotent?**

Yes, each order goes through the same `OrderService.create` inside the
worker. So resubmitting a batch with the same orderIds is safe —
existing orders come back with `wasExisting: true` and are counted as
success.

---

## 7. Status Normalization

**Q7.1 — Canonical statuses?**

`CREATED, PICKED_UP, IN_TRANSIT, DELIVERED, CANCELLED, FAILED`

**Q7.2 — Where does mapping happen?**

Only inside the adapter, via `couriers/statusMaps/<courier>StatusMap.ts`.
Services and repositories only ever see the canonical enum.

**Q7.3 — What about unknown native statuses?**

Fall back to **IN_TRANSIT** (non-terminal, safe). We prefer "keep
polling" to "wrongly mark terminal".

**Q7.4 — Why is TrackingHistory append-only?**

To preserve the actual courier timeline. Updating in place would erase
the story (e.g. why a shipment briefly went into RTO_INITIATED). Also
useful for support/audit.

Dedupe on insert by `(status, eventTime)` — see `TrackingService.track`.

---

## 8. Bulk Processing (BullMQ)

**Q8.1 — Why BullMQ + Redis for bulk?**

- Off-load slow, retryable work from the request thread.
- Bounded concurrency (`BULK_CONCURRENCY = 5`) avoids hammering courier APIs.
- Redis gives durability across process restarts.
- Partial success is natural: each order = one job, independent outcome.

**Q8.2 — What is `BULK_CONCURRENCY = 5`?**

Worker fan-out. At most 5 orders processed in parallel per worker
process (env-configurable). Protects the courier from bursts.

**Q8.3 — How is partial success captured?**

Each job returns a `BulkResult` (`success | failed`, plus tracking
number or `errorCode/errorMessage`) which is appended to
`BatchJob.results` atomically. Final `BatchJob.status`:

- 0 failures → `COMPLETED`
- 0 successes → `FAILED`
- else → `PARTIAL`

**Q8.4 — Concurrency and result aggregation — what about the race condition?**

Two workers finishing near-simultaneously could both `read → append → write` the `results` JSON, losing one result.

I use a **single atomic SQL update**:

```sql
UPDATE batch_jobs
SET results = results || $outcome::jsonb,
    "successCount" = "successCount" + $isSuccess,
    "failedCount"  = "failedCount"  + $isFailure,
    "updatedAt" = NOW()
WHERE "batchId" = $batchId
RETURNING "totalOrders", "successCount", "failedCount";
```

`||` is Postgres JSONB concatenation — atomic and lossless. The
returned counters tell the worker whether this was the last job, in
which case it updates the final status. See
`queue/bulkWorker.ts:appendBulkResultAtomic`.

**Q8.5 — Why not use per-order rows for results?**

Would work too. JSON array is a deliberate trade for the read path:
one row read gives you the whole batch in `GET /api/batches/:id` with
no join.

**Q8.6 — Queue name / prefix — why per-env?**

`BULK_QUEUE_PREFIX = mc-${NODE_ENV}` so the dev-server worker doesn't
consume test jobs off the shared Redis (this actually caused my first
integration-test timeout — good lesson).

**Q8.7 — What if the worker dies mid-job?**

BullMQ requeues stalled jobs. `attempts: 1` for our jobs because our
adapter already handles transient errors via retry/401-refresh — we
don't want double-processing to escape onto the courier. Follow-up
would be to make the outbound courier call idempotent on the courier
side using a client-request-id header.

---

## 9. Errors

**Q9.1 — Class hierarchy?**

`AppError` (base) → `ValidationError, NotFoundError, ConflictError,
InvalidStateError, UnsupportedCourierError, CourierAPIError,
AuthenticationError`.

Every subclass has `statusCode` and a machine-readable `code`.
`errorMiddleware` produces `{ error: { code, message, details } }`.

**Q9.2 — How are Zod errors handled?**

`errorMiddleware` checks `err instanceof ZodError` and converts to
`ValidationError` with `err.flatten()`. Consumers see `code:
VALIDATION_ERROR` and structured field-level errors.

**Q9.3 — Why does `CourierAPIError` carry `upstreamStatus`?**

- It lets the Mock adapter distinguish "true upstream error" (rethrow)
  vs "network error" (fallback to deterministic).
- It's also useful in logs for debugging courier flakiness.

**Q9.4 — 502 vs. 401 vs. 400 selection?**

- 400: caller's problem (`VALIDATION_ERROR`, `UNSUPPORTED_COURIER`)
- 401: courier auth is broken (surfaced when persistent 401 after refresh)
- 409: state conflict (`INVALID_STATE` — e.g. cancel a delivered order)
- 502: upstream courier failed (`COURIER_API_ERROR`)

---

## 10. Database / Prisma

**Q10.1 — Enums in Prisma vs. app code?**

Prisma generates them; we re-export from `utils/statusEnum.ts` for
convenient app-side use plus helpers like `isTerminalStatus`, `canCancel`.

**Q10.2 — Required indexes?**

On `Order`: `orderId`, `trackingNumber`, `courierOrderId`, `batchId`,
`status`. On `TrackingHistory`: `orderId`, `eventTime`. On `BatchJob`:
`batchId`, `status`.

**Q10.3 — Migrations flow?**

- `prisma migrate dev --name <n>` in development.
- `prisma migrate deploy` in tests/CI/prod. Deployed automatically in
  the Jest DB helper (`tests/helpers/db.ts`).

**Q10.4 — How do you seed?**

`prisma/seed.ts` upserts the `Urbanebolt` and `MockCourier` rows. Made
idempotent with `upsert` so re-running is safe.

**Q10.5 — Prisma client — one or many?**

Singleton (`repositories/prismaClient.ts`). Avoids exhausting the
connection pool. Exposed as `prisma` + `disconnectPrisma()`.

---

## 11. Validation (Zod)

**Q11.1 — Why Zod, and where does it live?**

- Runtime validation with TypeScript-native types.
- ONE schema per endpoint (`validators/order.validator.ts`), inferred
  types drive service inputs (`CreateOrderRequest = z.infer<...>`).
- Zod errors are caught centrally by `errorMiddleware`.

**Q11.2 — Env validation?**

Also Zod. `config/env.ts` validates and coerces all env vars at import
time; missing/invalid → process exits with a clear error. No implicit
defaults for sensitive things like `DATABASE_URL`.

**Q11.3 — Cross-field validation example?**

`paymentSchema.refine(v => v.mode !== 'COD' || v.codAmount > 0)` — COD
requires an amount > 0.

---

## 12. Logging & Observability

**Q12.1 — Log format?**

Winston JSON in production, colorized single-line in dev. Silent in
tests (`env.NODE_ENV === 'test'`).

**Q12.2 — What context do request logs carry?**

`requestId` (UUID from `x-request-id` header or generated in
`requestIdMiddleware`), `method`, `path`, `status`, `durationMs`.
Downstream logs from courier calls include `courierPartner`,
`operation`, `durationMs`, retry `attempt`.

**Q12.3 — Log levels applied?**

- INFO for successful requests + successful courier calls
- WARN for 4xx + retryable failures + validation
- ERROR for 5xx + unhandled exceptions

---

## 13. Testing

**Q13.1 — What kinds of tests are there?**

- **Unit** (`tests/unit/`) — pure logic, mocked dependencies.
- **Integration** (`tests/integration/`) — real Postgres, Express +
  Zod + services + repos, `nock` intercepting outbound HTTP, real
  Redis for bulk.

**Q13.2 — Coverage?**

**91.48% statements / 93.1% lines** across 71 tests in 12 suites (all
passing). Thresholds enforced in `jest.config.ts`.

**Q13.3 — Why `nock` for adapter tests?**

- Zero network — tests are hermetic.
- Verifies exact URLs, methods, headers (e.g. `Authorization: Bearer
...`) and payload shapes.
- Enables 401-refresh, 5xx-retry, and 4xx-error tests deterministically.

**Q13.4 — How do you avoid cross-test pollution?**

- Per-test `resetDatabase()` (delete tables in FK order, re-seed
  couriers).
- `CourierFactory.resetInstances()` between tests.
- `nock.cleanAll()` in `afterEach`.
- BullMQ per-env queue prefix isolates test jobs from dev/prod.

**Q13.5 — Bulk test — how do you know when the batch is done?**

`waitForBatch(batchId, timeout)` polls `GET /api/batches/:id` until
status is terminal (`COMPLETED | PARTIAL | FAILED`). Bounded by
timeout, fails loudly.

---

## 14. Trade-offs & Extensions

**Q14.1 — What would you do first for v2?**

1. Webhook receiver for real-time tracking (currently polling only).
2. Handle `Prisma.PrismaClientKnownRequestError P2002` in
   `OrderService.create` to make the concurrent-idempotent case return
   the existing order instead of 500.
3. Add a client request-id header to courier calls so 401-refresh
   retries are dedup'd on the courier side.
4. `/metrics` endpoint (Prometheus) — right now we only have logs.
5. Rate limiting middleware + per-tenant quotas.

**Q14.2 — Why polling instead of webhooks for tracking?**

- No public webhook URL / signature verification code needed.
- Simpler to test.
- Trade: some latency in status updates. Fine for MVP.

**Q14.3 — Multi-tenant support?**

Factory would key by `(courierName, tenantId)` and adapters would
receive tenant credentials at construction. Repositories would
tenant-scope all queries. That's the main change.

**Q14.4 — How would you swap Postgres for another DB?**

Only the Prisma schema and repositories change. Nothing else refers
to Postgres. Services depend on repository interfaces (implicitly —
concrete-class interfaces via class DI), so swapping is mechanical.

**Q14.5 — Adapter that needs OAuth2 client credentials?**

Extend `BaseCourierAdapter.authenticate()`. Nothing else changes —
`getAuthToken(forceRefresh)` and the 401-refresh flow already handle
"acquire a token then use it as Bearer".

**Q14.6 — Adapter with per-call HMAC signing?**

Do it inside the concrete adapter (e.g. `createShipment` builds the
signature over the payload+timestamp+secret and sets a header). The
`BaseCourierAdapter` shell is agnostic to that.

---

## 15. Rapid-fire code-reading questions

**"Show me where retry lives."**
`src/utils/retry.ts` (`withRetry`) — invoked only from
`src/couriers/adapters/BaseCourierAdapter.ts`.

**"Where do 4xx responses turn into `CourierAPIError`?"**
`BaseCourierAdapter.ensureOk` (non-2xx, non-401 branch) plus the
adapter's own `>=400 && !=401` checks.

**"Where is idempotency enforced?"**
`OrderService.create` (early return on `findByOrderId`) + DB unique on
`Order.orderId`.

**"What guards a cancel?"**
`CancellationService.cancel` → `canCancel(order.status)` (returns
false for `IN_TRANSIT/DELIVERED/CANCELLED/FAILED`). Then adapter is
called; on success, status → `CANCELLED` + `TrackingHistory.append`.

**"Where is the atomic bulk result update?"**
`src/queue/bulkWorker.ts:appendBulkResultAtomic` — raw SQL
`UPDATE ... SET results = results || $::jsonb ... RETURNING ...`.

**"How does the factory know about built-in couriers?"**
`registerBuiltIns()` at the bottom of
`src/couriers/factory/CourierFactory.ts`, called at module load.

**"What clears the auth token in `BaseCourierAdapter`?"**
`this.cachedToken = null` in `executeAuthed` on 401. Also
`_clearAuthCache()` for tests.

**"What port does the server bind to?"**
`env.PORT` (default `8001`), on `0.0.0.0`, per `src/server.ts`.

**"Where is env schema defined?"**
`src/config/env.ts` — Zod-validated, fails fast on missing values,
no silent fallbacks for secrets.

**"Where is the 401 refresh test?"**
`tests/unit/urbaneboltAdapter.test.ts` — "handles 401 → refresh token → retry once".

**"Which columns are indexed on `Order`?"**
`orderId`, `trackingNumber`, `courierOrderId`, `batchId`, `status`
(see `prisma/schema.prisma`).

---

## Appendix — Summary of what was built

**Endpoints (all under `/api`):**

- `POST /orders` — create (idempotent)
- `GET /orders/:id` — get + history
- `GET /orders/:id/track` — track (adapter poll)
- `POST /orders/:id/cancel` — cancel with state guard
- `POST /orders/bulk` — bulk (≤100), BullMQ, partial success
- `GET /batches/:batchId` — batch polling
- `GET /health` — liveness

**Adapters:** `UrbaneboltAdapter`, `MockCourierAdapter` (deterministic fallback).

**Patterns:** Adapter, Factory (registry-based), Strategy, Repository, DI, Template Method.

**Cross-cutting:** Zod-validated env + requests, Winston structured JSON logs, exponential-backoff retry, one-shot 401 refresh, canonical status enum, append-only tracking history, atomic bulk result aggregation.

**Tests:** 71 tests / 12 suites, **91.48% statements / 93.1% lines**, offline (`nock` for all courier HTTP, dedicated test DB, per-env queue prefix).

**Docs:** `README.md`, `DESIGN.md`, this Q&A.
