# DESIGN.md — Multi-Courier Integration Platform

## 1. Goals & Non-Goals

**Goals**
- One HTTP API that abstracts multiple courier providers.
- New courier onboarded via a single adapter file + one factory line.
- Idempotent shipment creation.
- Bulk creation (≤100 orders) with partial success.
- Retry + auth-refresh built into the adapter layer only.
- Structured logging, typed errors, DB-backed audit trail (tracking history).

**Non-Goals (v1)**
- Webhooks from courier → us (polling only for tracking).
- Platform-level API auth (JWT/API key for our own callers).
- Rate limiting / per-tenant quotas.

## 2. Layered architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  Route  →  Controller  →  Validator (Zod)                          │
│                            │                                       │
│                            ▼                                       │
│                        Service  →  CourierFactory  →  CourierAdapter (HTTP)
│                            │                                       │
│                            ▼                                       │
│                       Repository  →  Prisma  →  PostgreSQL         │
└────────────────────────────────────────────────────────────────────┘
```

**Hard rules enforced by code review + folder split:**

| Layer         | Allowed to know about                       |
|---------------|---------------------------------------------|
| Route         | Controllers only                            |
| Controller    | Zod schemas + services; NO DB, NO adapters  |
| Validator     | Zod only                                    |
| Service       | Repositories + `CourierFactory` (never adapters directly) |
| Factory       | Registered adapter classes                  |
| Adapter       | One courier's HTTP API + its status map     |
| Repository    | Prisma only                                 |

Anything crossing these boundaries is a review-blocker.

## 3. Sequence flows

### 3.1 Create shipment
```
POST /api/orders {orderId, courierName, ...}
    │
    ▼
Controller → Zod.parse(body)
    │
    ▼
OrderService.create(req)
    │
    ├── OrderRepository.findByOrderId(orderId)  ── if exists → return existing (idempotent=true)
    ├── CourierRepository.findByName(courierName) ── if missing/inactive → UnsupportedCourierError
    │
    ├── CourierFactory.create(courierName)      → ICourierAdapter
    ├── adapter.createShipment(input)
    │        │
    │        ├── BaseCourierAdapter.executeAuthed
    │        │      ├── withRetry (5xx / network) [exponential backoff]
    │        │      ├── on 401 → authenticate() → retry ONCE
    │        │      └── returns AxiosResponse
    │        │
    │        └── normalize native status → canonical (adapter local)
    │
    ├── OrderRepository.create({ courierOrderId, trackingNumber, status, requestPayload, responsePayload })
    └── TrackingRepository.append({ status: CREATED, description: 'Shipment created' })

→ 201 { data: order, idempotent: false }
```

### 3.2 Track shipment
```
GET /api/orders/:id/track
  → OrderService/TrackingService.track(orderId)
      → OrderRepository.findByOrderId
      → adapter.trackShipment(trackingNumber)
      → dedupe & append new events (append-only history)
      → update Order.status to normalized currentStatus
  → 200 { orderId, currentStatus, trackingNumber, events[] }
```

### 3.3 Cancel shipment
```
POST /api/orders/:id/cancel
  → CancellationService.cancel(orderId)
      → guard: canCancel(status)  (rejects DELIVERED/CANCELLED/FAILED/IN_TRANSIT)
      → adapter.cancelShipment
      → OrderRepository.updateStatus(CANCELLED)
      → TrackingRepository.append(CANCELLED)
  → 200 { data: order }
```

### 3.4 Bulk create
```
POST /api/orders/bulk  { orders[] }   (≤100, unique orderIds inside batch)
  → BatchJobService.enqueueBulk
      → BatchRepository.create({ status: PENDING })
      → for each order: bulkQueue.add(...)
      → mark PROCESSING
  → 202 { batchId, totalOrders, status: PROCESSING }

Worker (concurrency = BULK_CONCURRENCY):
  ├── OrderService.create(order, { batchId })      ── same idempotent path
  ├── ATOMIC SQL UPDATE:
  │       results = results || <outcome>::jsonb
  │       successCount / failedCount incremented
  │       updatedAt = now()
  │       RETURNING totals
  └── if totals == totalOrders:
          success == total  → COMPLETED
          failed  == total  → FAILED
          else              → PARTIAL

GET /api/batches/:batchId → { status, successCount, failedCount, results[] }
```

The atomic `UPDATE ... SET results = results || $::jsonb` avoids the
classic lost-update race that concurrent workers would otherwise have
against a JSON array field.

## 4. Patterns and where they live

| Pattern             | Where                                                  |
|---------------------|--------------------------------------------------------|
| **Adapter**         | `ICourierAdapter` + `BaseCourierAdapter` + concrete   |
| **Factory**         | `CourierFactory` (registry map, cached instances)     |
| **Strategy**        | Runtime adapter selection through the factory          |
| **Repository**      | `OrderRepository`, `TrackingRepository`, `BatchRepository`, `CourierRepository` |
| **Dependency Injection** | All services & repositories take collaborators via constructor; production wiring uses sane defaults, tests inject mocks |
| **Template method** | `BaseCourierAdapter.executeAuthed` orchestrates retry + 401-refresh; subclasses provide `authenticate()` and per-operation calls |

## 5. Error model

`AppError { message, statusCode, code, details, isOperational }`

Subclasses:

| Class                     | HTTP | `code`                |
|---------------------------|------|-----------------------|
| `ValidationError`         | 400  | `VALIDATION_ERROR`    |
| `UnsupportedCourierError` | 400  | `UNSUPPORTED_COURIER` |
| `AuthenticationError`     | 401  | `AUTHENTICATION_ERROR`|
| `NotFoundError`           | 404  | `NOT_FOUND`           |
| `ConflictError`           | 409  | `CONFLICT`            |
| `InvalidStateError`       | 409  | `INVALID_STATE`       |
| `CourierAPIError`         | 502  | `COURIER_API_ERROR`   |

All errors are shaped by `errorMiddleware` into:
```json
{ "error": { "code": "…", "message": "…", "details": { … } } }
```

Zod errors are auto-converted to `VALIDATION_ERROR` with `.flatten()`
details.

## 6. Retry & 401 refresh

Adapter layer only. `BaseCourierAdapter.executeAuthed`:

1. Wraps the network call in `withRetry`:
   - Attempts = `RETRY_MAX_ATTEMPTS`
   - Delays = `initial * factor^(n-1)` clamped to `RETRY_MAX_DELAY_MS`
   - `shouldRetry` = network errors (no `.response`) + any status `>= 500`
2. If the final response is **401**, clears the token cache, calls
   `authenticate()` again, and retries the operation **exactly once**.
3. If the second attempt is still 401 → `AuthenticationError`.
4. Non-401 4xx → `CourierAPIError` with upstream status/body.

## 7. Status normalization

Each adapter owns a `statusMaps/<courier>StatusMap.ts` that maps
its native strings to the canonical enum:

```
CREATED     ← MANIFESTED, BOOKED, PICKUP_SCHEDULED, ...
PICKED_UP   ← PICKED_UP, PICKUP
IN_TRANSIT  ← IN_TRANSIT, OUT_FOR_DELIVERY, OFD, <unknown>
DELIVERED   ← DELIVERED
CANCELLED   ← CANCELLED, CANCELED
FAILED      ← RTO_INITIATED, RTO_DELIVERED, LOST, UNDELIVERED, FAILED
```

Unknowns fall back to `IN_TRANSIT` (conservative, non-terminal).

## 8. Data model

```
Courier(id, name UNIQUE, baseUrl, authenticationType, isActive, ts)

Order(id, orderId UNIQUE, courierId → Courier,
      courierOrderId, trackingNumber, status,
      requestPayload JSON, responsePayload JSON,
      batchId?, ts)
      ★ indexes: orderId, trackingNumber, courierOrderId, batchId, status

TrackingHistory(id, orderId → Order CASCADE,
                status, description, location, eventTime, metadata JSON, createdAt)
      ★ indexes: orderId, eventTime   — APPEND-ONLY

BatchJob(id, batchId UNIQUE, totalOrders, successCount, failedCount,
         status, results JSON[], ts)
      ★ indexes: batchId, status
```

`TrackingHistory` is append-only — updates would obscure the real
courier timeline. Duplicate events are dedup'd inside `TrackingService`
by `(status, eventTime)` before insert.

## 9. Bulk processing

- Queue: `bullmq` on Redis
- Queue name: `bulk-shipments`, prefix `mc-${NODE_ENV}` (isolates envs on shared Redis)
- Worker concurrency: `BULK_CONCURRENCY` (default 5)
- Per-job:
  - Runs `OrderService.create(order, { batchId })` — same idempotent code path as single-order.
  - Failures are captured as `{ status:'failed', errorCode, errorMessage }` in the batch results — the job does NOT throw; workers should never fail catastrophically over business errors.
- Aggregation: single atomic Postgres UPDATE per job for correctness under concurrency.

## 10. Observability

Winston JSON logs, at INFO for all HTTP requests, WARN for `4xx`,
ERROR for `5xx`. Every log line downstream of the request pipeline
carries `requestId` for cross-service tracing. Courier calls also log
`courierPartner`, `operation`, `durationMs`, `attempt`.

## 11. Testing strategy

- **Unit tests (`tests/unit/`)**: pure logic — retry util, factory,
  status maps, error classes, adapters against `nock`, `OrderService`
  with mocked repos/factory.
- **Integration tests (`tests/integration/`)**: exercise Express +
  Zod + services + repositories + real Postgres, still with `nock`
  isolating outbound HTTP.
- **Bulk tests**: enqueue via BullMQ against real Redis (dedicated
  queue prefix). Worker started in-test.

Coverage guardrails in `jest.config.ts`; current run: **91% statements**.

## 12. Tradeoffs

- **Polling not webhooks** — simpler, deterministic, no public
  webhook endpoint or signature-verification code. Downside: latency
  in status updates.
- **JSON-array `BatchJob.results`** vs. a `BatchOrderResult` table —
  the JSON approach is faster to read and requires no join for the
  common "poll a batch" flow. We accept mild schema opacity for the
  simpler read path.
- **Adapter-caching in the Factory** — instances are process-cached.
  This means adapters must be stateless w.r.t. per-request data
  (only auth-token cache is per-instance, which is intentional). For
  future multi-tenant support, the factory would key by
  `(name, tenantId)`.
- **`ts-node-dev` in production** — for the emergent preview
  environment we run via `ts-node-dev`. A production deploy would use
  `yarn build && node dist/server.js`.

## 13. Open items / next steps

- Webhook receiver for real-time tracking (v2).
- Rate-limiter middleware and per-tenant quotas.
- Cross-adapter response schema for `rawResponse` (typed union).
- Prometheus /metrics endpoint (currently only structured logs).
