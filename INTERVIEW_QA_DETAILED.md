# Multi-Courier Integration Platform — Detailed Q&A

Long-form answers to every question in `INTERVIEW_QA.md`. Each answer
includes: what the code does, why it's done that way, alternatives
considered, code excerpts, and likely follow-ups.

---

## 1. Architecture & Layering

### Q1.1 — Walk me through the request flow for `POST /api/orders`.

The request travels through six well-defined layers, each with a
single responsibility:

```
HTTP → Express Router → Controller → Zod Validator → Service
                                                       ↓
                                                CourierFactory
                                                       ↓
                                                CourierAdapter (HTTP out)
                                                       ↓
                                                Repository → Prisma → PostgreSQL
```

**Step-by-step for `POST /api/orders`:**

1. **`app.ts`** creates the Express app, mounts middleware
   (`requestIdMiddleware`, `loggingMiddleware`, `express.json`) and
   the `/api` router.

2. **`routes/order.routes.ts`** binds `POST /` to
   `OrderController.create`.

3. **`OrderController.create`** (`controllers/order.controller.ts`)
   does exactly three things:
   ```ts
   const parsed = createOrderSchema.parse(req.body);           // (a) validate
   const { order, wasExisting } = await this.orderService
     .create(parsed, { requestId: req.requestId });            // (b) delegate
   res.status(wasExisting ? 200 : 201).json({ data: order,
     idempotent: wasExisting });                                // (c) shape response
   ```
   No business logic, no DB access, no courier code.

4. **`createOrderSchema.parse`** (`validators/order.validator.ts`)
   throws `ZodError` on invalid input; the central `errorMiddleware`
   translates that into a `400 VALIDATION_ERROR` response with
   `err.flatten()` details.

5. **`OrderService.create`** (`services/OrderService.ts`) — the
   orchestrator:
   ```ts
   const existing = await this.orderRepo.findByOrderId(req.orderId);
   if (existing) return { order: existing, wasExisting: true };  // idempotent

   const courier = await this.courierRepo.findByName(req.courierName);
   if (!courier || !courier.isActive) throw new UnsupportedCourierError(...);

   const adapter = this.factory.create(req.courierName);
   const result  = await adapter.createShipment({...});         // HTTP out
   const order   = await this.orderRepo.create({...});          // DB write
   await this.trackingRepo.append({ status: result.status, ... }); // audit
   return { order, wasExisting: false };
   ```
   Service is courier-agnostic — it only talks to `ICourierAdapter`.

6. **`CourierFactory.create(name)`** returns the cached adapter
   instance (`UrbaneboltAdapter` or `MockCourierAdapter`).

7. **Adapter** (`couriers/adapters/*`) is the network boundary:
   - Builds the courier-specific payload from the canonical input.
   - Calls `BaseCourierAdapter.executeAuthed(op, fn)` which:
     - Wraps the call in `withRetry` (exponential backoff, 5xx + network).
     - Handles a 401 via `authenticate()` + one-shot retry.
   - Normalizes the response's native status → canonical enum.

8. **Repositories** (`repositories/*Repository.ts`) execute the
   Prisma calls. They contain zero business rules — literally only
   thin wrappers around `prisma.<model>.<method>`.

9. **Response** is shaped by the controller: `201` on new, `200`
   with `idempotent: true` on a repeat.

**Why this order matters:**
- Validation happens *before* any I/O — bad input never touches the DB or courier.
- Idempotency check happens *before* the courier call — avoids double-shipping.
- Tracking history is appended *after* successful DB write — no orphaned events.

---

### Q1.2 — Why the strict layer boundaries?

Because the entire value proposition of this platform is:

> **Adding a new courier is exactly one adapter file + one factory registration.**

That promise dies the moment any of these happens:
- A controller checks `if (req.courierName === 'Urbanebolt')`.
- A service calls `prisma.` directly.
- A repository has a conditional based on courier name.
- An adapter reads from the DB or another adapter.

To catch violations, the rule is enforced by folder layout + type
system + code review, not by a runtime framework. The proof: `grep`
these facts in the shipped code:

- `grep -r "prisma\." src/controllers/` → **no hits**.
- `grep -r "axios\|http" src/services/` → **no hits**.
- `grep -r "Urbanebolt\|MockCourier" src/services/ src/controllers/` → **no hits** (services/controllers never mention specific couriers).

The boundaries also make each layer trivially testable in isolation:
- `OrderService` unit test uses fully mocked repos/factory (no DB).
- Adapter unit tests use `nock` (no server).
- Integration tests exercise the whole stack against a real DB with `nock` for outbound HTTP.

---

### Q1.3 — What lives in a Service vs. a Controller vs. a Repository?

**Controller (`order.controller.ts`, `batch.controller.ts`)** — thin HTTP glue:
- Parse the request body with the Zod schema for that endpoint.
- Delegate to a service.
- Convert the service result into an HTTP response (status code + JSON envelope).
- Forward errors via `next(err)` (never handles them itself).

Does NOT contain: DB queries, courier HTTP, retries, conditionals on
domain state, transaction management.

**Service (`OrderService`, `TrackingService`, `CancellationService`, `BatchJobService`)** — business logic:
- Enforce invariants (`canCancel`, idempotency check).
- Orchestrate multiple repositories and one adapter.
- Wrap operations in a domain-meaningful function name (`create`, `track`, `cancel`).

Does NOT contain: HTTP status codes, `res.json`, direct Prisma calls,
courier-specific fields, retry loops.

**Repository (`OrderRepository`, `TrackingRepository`, `BatchRepository`, `CourierRepository`)** — persistence:
- One thin method per query pattern the service needs.
- Directly calls `prisma.<model>.<verb>`.

Does NOT contain: any conditional business logic, courier awareness,
HTTP concepts.

**Adapter (`UrbaneboltAdapter`, `MockCourierAdapter`)** — external API integration:
- Everything specific to one courier's API: URL paths, header names, payload shape, status codes, auth mechanism.

Does NOT contain: DB access, other couriers, HTTP response shaping for
our own callers.

This split maps 1:1 to the folder structure so that "where does X go?"
has one answer.

---

## 2. Design Patterns

### Q2.1 — Which patterns are used and why?

**Adapter** — `couriers/interfaces/ICourierAdapter.ts` defines the
canonical contract; each concrete adapter translates canonical
requests/responses to/from a specific courier API. Purpose: uniform
interface over incompatible external systems.

```ts
export interface ICourierAdapter {
  readonly courierName: string;
  createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult>;
  trackShipment(trackingNumber: string, courierOrderId?: string): Promise<TrackingResult>;
  cancelShipment(input: CancelShipmentInput): Promise<CancelShipmentResult>;
}
```

**Factory** — `CourierFactory` maps `name → adapter class → cached
instance`. Purpose: hide construction, defer selection to runtime,
enable OCP.

**Strategy** — the concrete "strategy" is the adapter selected per
request. The service asks the factory for an `ICourierAdapter` and
uses it without knowing which one it got. Purpose: interchangeable
algorithms behind a common interface.

**Repository** — data-access abstraction. Purpose: decouple domain
services from the ORM/DB so services can be unit-tested with
in-memory doubles, and the storage engine could be swapped without
touching services.

**Template Method** — `BaseCourierAdapter.executeAuthed` implements
the invariant sequence: `[retry-wrap → 401-refresh → single retry]`.
Concrete adapters "fill in the holes" — they implement
`authenticate()` and pass the actual HTTP call via the callback.

**Constructor Dependency Injection** — every class takes its
collaborators via constructor with sensible defaults:
```ts
constructor(
  private readonly orderRepo = new OrderRepository(),
  private readonly trackingRepo = new TrackingRepository(),
  private readonly courierRepo = new CourierRepository(),
  private readonly factory = CourierFactory,
) {}
```
Production uses defaults; unit tests inject mocks. No DI framework
needed — plain TypeScript.

---

### Q2.2 — Why registry-based factory instead of `if/else` in the factory?

Compare the two:

**If/else (bad):**
```ts
static create(name: string) {
  switch (name.toLowerCase()) {
    case 'urbanebolt': return new UrbaneboltAdapter();
    case 'mockcourier': return new MockCourierAdapter();
    default: throw new UnsupportedCourierError(name);
  }
}
```
Adding "Speedy" requires editing `CourierFactory.ts` — a shared file
edited by every courier team. Merge conflicts scale linearly with
courier count.

**Registry (this repo):**
```ts
static register(name: string, ctor: AdapterCtor): void {
  this.registry.set(this.norm(name), ctor);
}
static create(name: string): ICourierAdapter { /* lookup or throw */ }
```

Adding "Speedy" is:
```ts
CourierFactory.register('Speedy', SpeedyAdapter);
```
Placed either at the bottom of `SpeedyAdapter.ts` (self-registration)
or in a central bootstrap.

Benefits:
- Zero shared-file edits after the initial factory is written.
- Test doubles can register `FakeAdapter` without importing anything else.
- Registry is *dynamic* — you can register/unregister at runtime
  (useful for tests and feature flags).

The registry approach is proven by the OCP test in
`tests/unit/factory.test.ts`.

---

### Q2.3 — Show me the OCP guarantee in code.

```ts
// tests/unit/factory.test.ts
it('OCP: registering a new adapter is the only change needed', () => {
  class FakeAdapter {
    public readonly courierName: string = 'FakeCo';
    createShipment = jest.fn();
    trackShipment  = jest.fn();
    cancelShipment = jest.fn();
  }
  CourierFactory.register('FakeCo', FakeAdapter as any);
  const a = CourierFactory.create('FakeCo');
  expect(a).toBeInstanceOf(FakeAdapter);
  expect(CourierFactory.list()).toContain('fakeco');
});
```

Note what's absent from this test: any change to a service,
controller, validator, repository, or route. That's the whole point —
`FakeAdapter` becomes a first-class courier via one `register()` call.

**Follow-up:** In production you'd also want a `Courier` row seeded
in the DB (so `CourierRepository.findByName` succeeds), and optionally
a status map. But those are opt-in — the factory alone is enough for
the pattern to work.

---

## 3. Adapters (Urbanebolt, Mock)

### Q3.1 — What does `ICourierAdapter` require?

```ts
export interface ICourierAdapter {
  readonly courierName: string;

  createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult>;
  trackShipment(trackingNumber: string, courierOrderId?: string): Promise<TrackingResult>;
  cancelShipment(input: CancelShipmentInput): Promise<CancelShipmentResult>;
}
```

The DTOs are canonical:

- **`CreateShipmentInput`** — `orderId`, `pickup: Address`,
  `delivery: Address`, `package: PackageDetails`, `payment: PaymentInfo`,
  optional `productType` and `metadata`.
- **`CreateShipmentResult`** — `courierOrderId`, `trackingNumber`,
  `status: ShipmentStatus (canonical)`, `rawResponse: unknown`.
- **`TrackingResult`** — `currentStatus`, `events: TrackingEvent[]`,
  `rawResponse`.
- **`CancelShipmentResult`** — `cancelled: boolean`, `cancelledAt: Date`,
  `rawResponse`.

Notice **status is always canonical** at the interface boundary. Native
courier statuses (like `MANIFESTED`, `OUT_FOR_DELIVERY`) never escape
the adapter.

`rawResponse` is preserved for audit — persisted in
`Order.responsePayload` and in `TrackingHistory.metadata`. This is
crucial for debugging courier-side issues and support tickets.

---

### Q3.2 — Walk through `UrbaneboltAdapter.createShipment`.

```ts
async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
  const payload = this.buildManifestPayload(input);           // 1. transform
  const res = await this.executeAuthed<UrbaneboltManifestResponse>(
    'createShipment',
    (token) => this.http.post('/api/v1/services/manifest/', payload,
                              { headers: { Authorization: `Bearer ${token}` } }),
  );                                                            // 2. execute with retry+auth
  const body  = this.ensureOk(res, 'createShipment');           // 3. validate 2xx
  const inner = body.data ?? body;                              // 4. unwrap
  const awb           = inner.awb ?? inner.awb_number;
  const courierOrderId = inner.courier_order_id ?? inner.order_id ?? awb;
  if (!awb || !courierOrderId) throw new CourierAPIError(...);  // 5. defensive

  return {
    courierOrderId: String(courierOrderId),
    trackingNumber: String(awb),
    status:         mapUrbaneboltStatus(inner.status),          // 6. normalize
    rawResponse:    body,                                        // 7. preserve
  };
}
```

**Design points:**

1. **Payload transformation** happens in `buildManifestPayload` — the
   only place in the codebase that knows `pickup.addressLine1` maps to
   `pickup.address1` and `package.widthCm` maps to `package.breadth`.
   This isolates courier weirdness.

2. **`executeAuthed`** is the template method. The adapter passes the
   actual HTTP call as a lambda so it can be invoked with the current
   token, retried on 5xx, and re-invoked with a fresh token on 401 —
   all without duplicating that boilerplate per operation.

3. **`ensureOk`** handles the "success or throw" decision — non-2xx
   becomes `CourierAPIError` with upstream status/body attached for
   debugging.

4. **Response unwrapping** — Urbanebolt sometimes wraps under `data`,
   sometimes not (based on the Postman collection). The `body.data ??
   body` defensively handles both shapes. Same for `awb ?? awb_number`.

5. **Defensive validation** — if the courier returns 200 with a broken
   body (missing `awb`), we throw rather than persist a garbage order.

6. **Normalization** — `mapUrbaneboltStatus('MANIFESTED')` returns
   `ShipmentStatus.CREATED`. See section 7.

7. **`rawResponse: body`** — the entire courier response is persisted
   in `Order.responsePayload` for audit/support. Never lose data.

---

### Q3.3 — What does `MockCourierAdapter` do differently?

Two behaviors distinguish it:

**1. Best-effort HTTP, deterministic fallback:**

```ts
try {
  const res = await this.executeAuthed<...>('createShipment', ...);
  if (res.status >= 200 && res.status < 300 && res.data) { return {...}; }
  if (res.status >= 400 && res.status !== 401) throw new CourierAPIError(...);
} catch (err) {
  if (err instanceof CourierAPIError && err.upstreamStatus !== undefined) throw err;
}
return this.deterministicCreate(input);
```

The subtle bit is the `err.upstreamStatus !== undefined` check:
- If `upstreamStatus` is set, we got an *actual HTTP error* from the
  mock server (e.g. 400 in a test) → propagate it.
- If undefined, it's a *network error* (host unreachable, DNS
  failure) → fall back to deterministic generation.

This is exactly what makes `nock`-based tests work seamlessly: when
`nock` has a scope for the URL, the HTTP path runs; when it doesn't,
the network fails and the deterministic path runs.

**2. Deterministic generation:**

```ts
private deterministicCreate(input: CreateShipmentInput): CreateShipmentResult {
  const hash = createHash('sha1').update(input.orderId).digest('hex').slice(0, 10).toUpperCase();
  return {
    courierOrderId: `MOCK-${hash}`,
    trackingNumber: `MCT${hash}`,
    status: ShipmentStatus.CREATED,
    rawResponse: { mocked: true, orderId: input.orderId, generatedAt: new Date().toISOString() },
  };
}
```

Same `orderId` → same `trackingNumber` and `courierOrderId`. This
makes tests assert against known-good values without external state.

**Also:**
- The tracking timeline is a fixed 3-event sequence (`CREATED →
  PICKED_UP → IN_TRANSIT`) so track tests are deterministic.
- Cancel always returns success — the mock has no notion of terminal
  state.

**Why bother?** For local development you don't want to depend on the
Urbanebolt UAT being up. And for tests, having a "real" adapter that
exercises `BaseCourierAdapter` without any HTTP stubbing gives us a
smoke path.

---

### Q3.4 — Where is the courier-specific payload transformation?

`UrbaneboltAdapter.buildManifestPayload`. This is the *only* place in
the entire codebase that knows about Urbanebolt-specific field names:

```ts
private buildManifestPayload(input: CreateShipmentInput): Record<string, unknown> {
  return {
    order_id: input.orderId,
    product_type: input.productType ?? 'FORWARD',
    payment_mode: input.payment.mode,
    cod_amount: input.payment.codAmount ?? 0,
    pickup: {
      name: input.pickup.name,
      phone: input.pickup.phone,
      // ...
      address1: input.pickup.addressLine1,       // ← Urbanebolt uses "address1"
      pincode: input.pickup.pincode,
      country: input.pickup.country,
    },
    // ...
    package: {
      weight: input.package.weightGrams,         // ← Urbanebolt calls it "weight"
      length: input.package.lengthCm,
      breadth: input.package.widthCm,            // ← Urbanebolt uses "breadth"
      // ...
    },
  };
}
```

Everything above the adapter uses the canonical `CreateShipmentInput`
type — `pickup.addressLine1`, `package.widthCm`, etc. When Speedy
comes along and expects `pickup.line_1` and `package.width_in_cm`,
that's a **new** `buildManifestPayload` in `SpeedyAdapter`. No
downstream code changes.

**Why not do this transformation in the service layer?** Because then
the service would have to import Urbanebolt schema types, and the
courier-specific weirdness leaks. The whole point of the Adapter
pattern is to keep translation right at the boundary.

---

## 4. CourierFactory

### Q4.1 — How is a new courier added?

Concrete recipe for adding "Speedy":

**Step 1 — Adapter class** (`src/couriers/adapters/SpeedyAdapter.ts`):
```ts
export class SpeedyAdapter extends BaseCourierAdapter {
  public readonly courierName = 'Speedy';

  constructor(http?: HttpClient) {
    super(http ?? new HttpClient({ baseURL: env.SPEEDY_BASE_URL }));
  }

  protected async authenticate(): Promise<string> {
    const res = await this.http.post('/oauth/token',
      { client_id: env.SPEEDY_KEY, client_secret: env.SPEEDY_SECRET });
    return res.data.access_token;
  }

  async createShipment(input) {
    const res = await this.executeAuthed('createShipment', (token) =>
      this.http.post('/shipments', speedyPayload(input),
        { headers: { Authorization: `Bearer ${token}` } }));
    const body = this.ensureOk(res, 'createShipment');
    return {
      courierOrderId: body.id,
      trackingNumber: body.tracking_code,
      status:         mapSpeedyStatus(body.state),
      rawResponse:    body,
    };
  }

  // trackShipment + cancelShipment similar
}
```

**Step 2 — Factory registration** — one line in
`src/couriers/factory/CourierFactory.ts`:
```ts
CourierFactory.register('Speedy', SpeedyAdapter);
```

**Step 3 — Env schema** — add `SPEEDY_BASE_URL`, `SPEEDY_KEY`,
`SPEEDY_SECRET` to `src/config/env.ts` (Zod schema + `.env.example`).

**Step 4 — Courier row** — seed a row in the `Courier` table (or add
via a migration) so `CourierRepository.findByName('Speedy')` succeeds
and returns `isActive: true`.

**Step 5 — Status map** — `src/couriers/statusMaps/speedyStatusMap.ts`
mapping Speedy's native states to the canonical enum.

**Step 6 — Tests** — `nock`-based unit tests for the adapter, plus
optionally an integration test.

Zero changes to controllers, routes, services, or repositories.

---

### Q4.2 — Why cache adapter instances?

```ts
static create(name: string): ICourierAdapter {
  const key = this.norm(name);
  const cached = this.instances.get(key);
  if (cached) return cached;

  const Ctor = this.registry.get(key);
  if (!Ctor) throw new UnsupportedCourierError(name);

  const instance = new Ctor();
  this.instances.set(key, instance);
  return instance;
}
```

Three reasons:

1. **Auth token cache is per-instance.** If we constructed a new
   adapter per request, each call would trigger a fresh
   `authenticate()`. That's wasteful and abusive to the courier
   (Urbanebolt might rate-limit `/auth/getToken`).

2. **HttpClient reuse.** The `HttpClient` wraps Axios; reusing it
   preserves TCP connections (Axios uses Node's global HTTP agent
   which pools sockets). Not a huge win here since Axios uses global
   agents anyway, but it's cleaner.

3. **Cheap object construction still costs.** In a high-throughput
   server, creating adapter+HttpClient per request would show up in
   profiles.

**The invariant this relies on:** adapters must be stateless w.r.t.
per-request data. They may hold per-instance state (auth token cache)
but nothing that varies per request. This is enforced by design —
`createShipment`/`trackShipment`/`cancelShipment` take everything they
need as parameters.

**For multi-tenant** (future): cache key becomes `(name, tenantId)` and
each adapter takes tenant credentials. The pattern extends cleanly.

---

### Q4.3 — How do you reset the cache in tests?

Two APIs:

```ts
CourierFactory.resetInstances();  // clear cached instances; registry stays
CourierFactory._resetAll();       // clear both; then re-registers built-ins
```

Used in tests:
```ts
// Integration tests
beforeEach(() => { CourierFactory.resetInstances(); });

// Factory tests
afterEach(() => { CourierFactory._resetAll(); });
```

Why the distinction:
- Integration tests want to keep the built-in registry (Urbanebolt +
  MockCourier), but need a fresh instance per test so an in-memory
  token from a previous test's `nock` stub doesn't leak.
- Factory tests may register `FakeAdapter` during a test; `_resetAll`
  wipes the registry and re-adds only the built-ins for clean state.

---

## 5. Retry + 401 Refresh

### Q5.1 — Where does retry live and why there?

**Location:** `src/utils/retry.ts` (`withRetry` — pure function) and
`src/couriers/adapters/BaseCourierAdapter.ts:executeAuthed` (invoked
by every concrete adapter).

**Why the adapter layer only:**

The adapter is the **network boundary**. Everything above it (services,
controllers) deals with *domain* semantics: idempotency, cancel
validity, batch aggregation. Domain code should not have to think
"maybe the network flaked". Domain code should think "the courier
said yes or no".

If retry were in the service layer:
- Every service method would need retry glue for the courier call
  (violates DRY).
- Retries would potentially trigger for non-network errors
  (idempotency violations, validation failures) — dangerous.
- Testability suffers: unit-testing a service now has to deal with
  timing (delays).

By putting retry in the adapter, the interface `ICourierAdapter`
promises: "when I return, either it worked, or it definitively didn't
after reasonable retries."

---

### Q5.2 — What counts as retryable?

```ts
protected isRetryableError(err: unknown): boolean {
  const e = err as { code?: string; response?: { status?: number } };
  if (e?.response?.status && e.response.status >= 500) return true;
  return !e?.response;  // no response = network error → retry
}
```

**Retryable:**
- Network errors — no `response` object (DNS failure, connection
  reset, timeout).
- 5xx status codes — transient server problems.

**NOT retryable:**
- 4xx — client-side problem; retrying with the same request won't fix
  it. Surfaced as `CourierAPIError`.
- 401 — handled specially (see Q5.3).

**Why 5xx is retryable and 4xx isn't:**
- 5xx = "you did nothing wrong, we're broken" → retry.
- 4xx = "you did something wrong" → the fix requires code change, not
  a retry.

**A subtle bit** in `executeAuthed`: because `HttpClient` uses
`validateStatus: () => true` (never throws on status codes), the
retry needs to be triggered manually for 5xx. We do it by throwing a
fake error inside the retry callback:

```ts
response = await withRetry(async () => {
  const res = await attempt(false);
  if (res.status >= 500) {
    const err = new Error(`upstream ${res.status}`) as any;
    err.response = { status: res.status, data: res.data };
    throw err;   // ← makes withRetry retry
  }
  return res;
}, { /* ... */ });
```

This preserves the retry semantics while still returning a proper
`AxiosResponse` on success.

---

### Q5.3 — Show the 401 handling flow.

```ts
protected async executeAuthed<T>(
  operation: string,
  fn: (token: string) => Promise<AxiosResponse<T>>,
): Promise<AxiosResponse<T>> {
  const attempt = async (forceRefresh: boolean) => {
    const token = await this.getAuthToken(forceRefresh);
    return fn(token);
  };

  // Phase 1: retry-wrapped primary attempt
  let response: AxiosResponse<T>;
  try {
    response = await withRetry(async () => {
      const res = await attempt(false);
      if (res.status >= 500) throw makeRetryError(res);
      return res;
    }, {/* backoff opts */});
  } catch (err) { /* wrap as CourierAPIError */ }

  // Phase 2: 401 → refresh → single retry
  if (response.status === 401) {
    logger.info('Courier returned 401; refreshing token and retrying once', ...);
    this.cachedToken = null;
    response = await attempt(true);  // forces authenticate()
    if (response.status === 401) {
      throw new AuthenticationError(this.courierName, `401 after refresh on ${operation}`);
    }
  }
  return response;
}
```

**Flow:**

1. First attempt with cached token (or fresh if cache is empty).
2. Retry on 5xx / network with exponential backoff (attempts =
   `RETRY_MAX_ATTEMPTS`).
3. If final response is 401:
   - Clear the token cache.
   - Call `attempt(true)` which forces `authenticate()` to fetch a
     new token, then re-runs the operation with it.
   - Exactly one retry — no backoff, no more attempts.
4. If still 401 after refresh → `AuthenticationError` (surfaces as HTTP 401).

The 401 flow is deliberately **separate** from the 5xx retry loop
because they represent different problems and deserve different
policies.

---

### Q5.4 — Why not put 5xx and 401 into the same retry loop?

Because they have fundamentally different failure semantics:

- **5xx = transient**: the server is temporarily broken. Retrying with
  the same request (including the same token) may work.
- **401 = credential expired**: retrying with the same token will
  definitely fail. You need a *different* token.

If they shared the loop:
- You'd re-authenticate on every 5xx retry (wasteful).
- Or you'd not re-authenticate on 401 in early attempts (broken).

Also, **retrying auth calls aggressively can lock accounts** on the
courier side (some couriers rate-limit auth endpoints or trigger
security alerts). One-shot 401 refresh is the safe policy.

Finally, mixing them makes tests harder to reason about — with
separate flows, "does 401 refresh work?" and "does 5xx retry work?"
are independent test cases.

---

### Q5.5 — Test that proves 401 refresh works?

```ts
// tests/unit/urbaneboltAdapter.test.ts
it('handles 401 -> refresh token -> retry once', async () => {
  // First auth
  nock(BASE).post('/api/v1/auth/getToken/').reply(200, { token: 't-old' });
  // First manifest → 401 with the old token
  nock(BASE)
    .post('/api/v1/services/manifest/')
    .matchHeader('authorization', 'Bearer t-old')
    .reply(401, { error: 'expired' });
  // Second auth (refresh)
  nock(BASE).post('/api/v1/auth/getToken/').reply(200, { token: 't-new' });
  // Retry manifest with new token → 200
  nock(BASE)
    .post('/api/v1/services/manifest/')
    .matchHeader('authorization', 'Bearer t-new')
    .reply(200, { data: { awb: 'A9', courier_order_id: 'C9', status: 'MANIFESTED' } });

  const a = newAdapter();
  const res = await a.createShipment(makeOrderRequest({ courierName: 'Urbanebolt' }));
  expect(res.trackingNumber).toBe('A9');
});
```

`matchHeader('authorization', 'Bearer t-old')` is the key — it proves
the first attempt used the old token, then after refresh the retry
used `t-new`. If the code weren't refreshing, the test would fail
because no nock scope matches the second attempt.

A companion negative test verifies that persistent 401 becomes
`AuthenticationError`:

```ts
it('throws AuthenticationError if 401 persists after refresh', async () => {
  nock(BASE).post('/api/v1/auth/getToken/').reply(200, { token: 't1' });
  nock(BASE).post('/api/v1/services/manifest/').reply(401, {});
  nock(BASE).post('/api/v1/auth/getToken/').reply(200, { token: 't2' });
  nock(BASE).post('/api/v1/services/manifest/').reply(401, {});
  await expect(a.createShipment(req)).rejects.toBeInstanceOf(AuthenticationError);
});
```

---

## 6. Idempotency

### Q6.1 — How is idempotency enforced?

Two layers, defense-in-depth:

**Layer 1 — Application (`OrderService.create`):**
```ts
const existing = await this.orderRepo.findByOrderId(req.orderId);
if (existing) {
  logger.info('Idempotent create: returning existing order', {...});
  return { order: existing, wasExisting: true };
}
```
Cheap short-circuit: one indexed SELECT before any expensive work.

**Layer 2 — Database (`Order.orderId @unique`):**
```prisma
model Order {
  orderId String @unique
  // ...
}
```
Even if two requests race past the SELECT with `null`, the second
INSERT will fail with a unique constraint violation.

**Why both:**
- Application-level is fast (single SELECT, returns cached
  Prisma-shaped data).
- DB-level is correct under concurrency — SELECT-then-INSERT has a
  TOCTOU race that only the DB can definitively close.

---

### Q6.2 — What about the race between two simultaneous requests?

Scenario: two requests with the same `orderId` arrive within milliseconds.

**Without DB constraint:** both do `findByOrderId → null`, both call
the courier, both try to insert → both succeed → **two shipments
booked**. Very bad.

**With DB constraint (current):** both do `findByOrderId → null`, both
call the courier (potentially bad, both succeed at the courier), one
INSERT wins, the other throws `Prisma.PrismaClientKnownRequestError`
with code `P2002` (unique constraint violation) → currently surfaces
as a 500.

**Ideal handling (flagged as follow-up in DESIGN.md):**
```ts
try {
  const order = await this.orderRepo.create({...});
  return { order, wasExisting: false };
} catch (err) {
  if (err.code === 'P2002' && err.meta?.target?.includes('orderId')) {
    // Race lost — fetch the existing row and return it as idempotent
    const existing = await this.orderRepo.findByOrderId(req.orderId);
    if (existing) return { order: existing, wasExisting: true };
  }
  throw err;
}
```

The courier double-booking is a separate issue that can only be fully
solved by sending an idempotency key **to the courier** (some
couriers, like Stripe, support this via `Idempotency-Key` header).
This would be v2.

For the current scope, this race is *very* unlikely in practice
(shipments aren't submitted twice within milliseconds by well-behaved
clients), and the DB guarantee ensures no *data corruption* — worst
case is a 500 that a retry will resolve because the row now exists.

---

### Q6.3 — How is the HTTP contract communicated?

- **First success:** `201 { data, idempotent: false }`.
- **Repeat with same orderId:** `200 { data: existing, idempotent: true }`.

```ts
// order.controller.ts
res.status(wasExisting ? 200 : 201).json({
  data: order,
  idempotent: wasExisting,
});
```

Two ways for the caller to detect idempotency:
1. **Status code** — 201 for created, 200 for existing.
2. **Explicit flag** — `idempotent: boolean` in the body.

Different status codes mean:
- Instrumentation dashboards separate "new orders" from "duplicates".
- Clients can distinguish "we booked something" vs "we already booked
  this earlier" and act accordingly (e.g. avoid double-charging).

---

### Q6.4 — Is bulk create idempotent?

Yes. Each order in the batch goes through the same
`OrderService.create` inside the worker:

```ts
// bulkWorker.ts
const { order: created } = await orderService.create(order, { batchId });
```

If a batch is resubmitted (with a different `batchId` but the same
`orderId`s):
- Each order finds its existing row via `findByOrderId`.
- `wasExisting: true` is returned.
- The worker records `status: 'success'` with the existing
  `trackingNumber` / `courierOrderId`.
- The new `BatchJob` will show all successes.

Two edge cases:

1. **Batch has the same `orderId` twice** — rejected upfront in
   `BatchJobService.enqueueBulk`:
   ```ts
   const ids = new Set<string>();
   for (const o of orders) {
     if (ids.has(o.orderId)) throw new ValidationError(`Duplicate orderId '${o.orderId}' within batch`);
     ids.add(o.orderId);
   }
   ```

2. **`batchId` uniqueness** — `BatchJob.batchId @unique` — we generate
   `batch_${randomUUID()}` so collisions are astronomically rare, but
   the DB would reject a collision.

---

## 7. Status Normalization

### Q7.1 — Canonical statuses?

```
CREATED     — courier accepted the shipment; not yet picked up
PICKED_UP   — carrier physically has the package
IN_TRANSIT  — moving through the courier network (incl. OFD)
DELIVERED   — successfully handed to recipient (terminal)
CANCELLED   — cancelled before delivery (terminal)
FAILED      — undelivered / RTO / lost (terminal)
```

Three terminal, three non-terminal. Terminal set is
`{DELIVERED, CANCELLED, FAILED}` — used by `isTerminalStatus` and
`canCancel` helpers in `utils/statusEnum.ts`.

---

### Q7.2 — Where does mapping happen?

Only inside the adapter, via
`src/couriers/statusMaps/<courier>StatusMap.ts`. Each map is a pure
function:

```ts
// urbaneboltStatusMap.ts
const URBANEBOLT_MAP: Record<string, ShipmentStatus> = {
  MANIFESTED: ShipmentStatus.CREATED,
  BOOKED: ShipmentStatus.CREATED,
  PICKUP_SCHEDULED: ShipmentStatus.CREATED,
  PICKED_UP: ShipmentStatus.PICKED_UP,
  IN_TRANSIT: ShipmentStatus.IN_TRANSIT,
  OUT_FOR_DELIVERY: ShipmentStatus.IN_TRANSIT,
  OFD: ShipmentStatus.IN_TRANSIT,
  DELIVERED: ShipmentStatus.DELIVERED,
  CANCELLED: ShipmentStatus.CANCELLED,
  RTO_INITIATED: ShipmentStatus.FAILED,
  RTO_DELIVERED: ShipmentStatus.FAILED,
  LOST: ShipmentStatus.FAILED,
  UNDELIVERED: ShipmentStatus.FAILED,
  FAILED: ShipmentStatus.FAILED,
};

export function mapUrbaneboltStatus(native: string | undefined | null): ShipmentStatus {
  if (!native) return ShipmentStatus.IN_TRANSIT;
  const upper = String(native).toUpperCase().replace(/\s+/g, '_');
  return URBANEBOLT_MAP[upper] ?? ShipmentStatus.IN_TRANSIT;
}
```

**Why here and not in a service:**
- Services shouldn't know courier vocab.
- The mapping is courier-specific — belongs with the courier.

Unit tests (`tests/unit/statusMaps.test.ts`) verify every documented
transition, unknown-fallback, and null-safety.

---

### Q7.3 — What about unknown native statuses?

**Fallback:** `IN_TRANSIT`.

Reasoning: it's the *safest non-terminal* status.

- Falling back to `DELIVERED` would prematurely stop polling → user
  never learns of a real problem.
- Falling back to `CANCELLED` or `FAILED` would give a wrong final
  status.
- `CREATED` or `PICKED_UP` might be true earlier states we've already
  passed → backwards timeline.
- `IN_TRANSIT` means "we're doing something, keep polling" — which is
  always true for an active shipment with an unknown status.

Also, unknown statuses are *logged* (via the tracking event
`metadata: { rawStatus: e.status }`) so operations can add missing
mappings.

---

### Q7.4 — Why is TrackingHistory append-only?

Two motivations:

**1. Preserve the courier timeline for audit / support.**

Real shipments have complex histories: they can transition from
`IN_TRANSIT` to `RTO_INITIATED` (return to origin) back to `PICKED_UP`
(after a re-attempt). If we overwrote instead of appending, we'd lose
that story. Support agents chasing "why did this arrive 3 days late"
would have no data.

**2. Match real-world audit requirements.**

For shipping platforms serving regulated industries (pharma,
electronics), an unbroken audit chain is often mandatory.

**Implementation:**
```ts
// TrackingService.track
const existing = await this.trackingRepo.findByOrderId(order.id);
const seen = new Set(existing.map((e) => `${e.status}|${e.eventTime.toISOString()}`));

for (const evt of result.events) {
  const key = `${evt.status}|${evt.eventTime.toISOString()}`;
  if (seen.has(key)) continue;   // dedupe on (status, eventTime)
  seen.add(key);
  await this.trackingRepo.append({...});
}
```

Dedupe key is `(status, eventTime)` — because repeated polls will
return the same events; without dedupe we'd insert them every poll.

**Order.status is updated separately** — this is the *current* status
(non-append-only, since it's a projection of the latest event).
Tracking history is the full timeline.

---

## 8. Bulk Processing (BullMQ)

### Q8.1 — Why BullMQ + Redis for bulk?

Four reasons:

1. **Response latency**: without a queue, `POST /orders/bulk` with 100
   orders would take 100 courier round-trips serial (or fan out and
   overwhelm the courier). Neither is acceptable for an HTTP request.
   With a queue, we accept the batch in <100ms and process
   asynchronously.

2. **Bounded concurrency**: BullMQ's `concurrency` option lets us
   process a controllable number of orders in parallel
   (`BULK_CONCURRENCY = 5`). Without a queue, we'd have to hand-roll
   this with `Promise.all` chunks.

3. **Durability**: Jobs live in Redis. If the worker process crashes
   mid-batch, on restart it picks up where it left off. If we did
   in-memory processing, a crash would leave the batch in a broken
   state.

4. **Observability**: BullMQ ships with a UI (Bull-board) and metrics
   — useful in production even if we don't wire them up in v1.

**Why not Kafka / SQS / RabbitMQ?**
- BullMQ is Node-native, no separate broker infrastructure.
- Redis is already a common infra choice for caching/rate-limiting.
- For our scale (batches ≤ 100), heavyweight brokers are overkill.

---

### Q8.2 — What is `BULK_CONCURRENCY = 5`?

The number of jobs the worker will process in parallel. Set at
`Worker` construction:

```ts
new Worker(BULK_QUEUE_NAME, processor, {
  connection: getBulkConnectionOptions(),
  prefix: BULK_QUEUE_PREFIX,
  concurrency: env.BULK_CONCURRENCY,  // default 5
});
```

**Why not higher?**
- Courier APIs typically have rate limits (Urbanebolt likely ≈10-50
  req/s per account). Higher concurrency risks hitting them.
- Each in-flight job holds a Prisma connection during the DB writes.

**Why not lower?**
- 1 = serial → 100 orders would take 100× the single-order latency.
- 5 is a good middle ground that empirically avoids rate-limit issues
  while still finishing a max-size batch in seconds.

**Configurable via env** — ops can tune per courier or per environment
without a code change. Also useful in tests where lower concurrency
makes flake diagnosis easier.

---

### Q8.3 — How is partial success captured?

Each job returns a `BulkResult`:

```ts
export interface BulkResult {
  orderId: string;
  status: 'success' | 'failed';
  courierOrderId?: string;
  trackingNumber?: string;
  errorCode?: string;
  errorMessage?: string;
}
```

On success, `courierOrderId` and `trackingNumber` are populated. On
failure, `errorCode` (e.g. `UNSUPPORTED_COURIER`, `COURIER_API_ERROR`,
`VALIDATION_ERROR`) and `errorMessage` are populated.

Each result is appended to `BatchJob.results` (a JSONB array).
Counters (`successCount`, `failedCount`) are incremented atomically.

**Final `BatchJob.status`:**
```ts
const nextStatus: BatchStatus =
  failed_count === 0
    ? BatchStatus.COMPLETED    // 100% success
    : success_count === 0
      ? BatchStatus.FAILED     // 100% failure
      : BatchStatus.PARTIAL;   // mix
```

The client polls `GET /api/batches/:id` until status is terminal, then
uses `results[]` to reconcile.

**Critical property:** a failure in one order NEVER affects others.
Each job catches its own errors:
```ts
try {
  const { order: created } = await orderService.create(order, { batchId });
  outcome = { status: 'success', ... };
} catch (err) {
  outcome = { status: 'failed', errorCode: err.code, errorMessage: err.message };
  // NOTE: we do NOT re-throw. The job "succeeds" as a job (BullMQ won't retry)
  // but the outcome for the order is 'failed'.
}
await appendBulkResultAtomic(batchId, outcome);
```

If we rethrew, BullMQ would mark the job as failed and (with retries)
double-process. We deliberately convert business failures to data.

---

### Q8.4 — Concurrency and result aggregation — what about the race condition?

**The race:**

With `concurrency = 5`, up to 5 workers may finish their orders
simultaneously. If the aggregation is:

```ts
// BAD — read-modify-write
const batch = await batchRepo.findByBatchId(batchId);   // Snapshot
const results = [...batch.results, newOutcome];         // Modify
await batchRepo.update(batchId, {                       // Write
  results,
  successCount: batch.successCount + isSuccess,
  failedCount:  batch.failedCount  + isFailure,
});
```

Two workers can both read `batch.results` before either writes → each
appends only *their own* outcome → last writer wins → **one outcome
lost**. Actually verified this experimentally in early testing —
bulk of 3 sometimes returned 2 results.

**The fix — atomic SQL UPDATE:**

```ts
const rows = await prisma.$queryRaw<
  { total_orders: number; success_count: number; failed_count: number }[]
>`
  UPDATE batch_jobs
  SET results = results || ${JSON.stringify([outcome])}::jsonb,
      "successCount" = "successCount" + ${isSuccess},
      "failedCount"  = "failedCount"  + ${isFailure},
      "updatedAt" = NOW()
  WHERE "batchId" = ${batchId}
  RETURNING "totalOrders" AS total_orders,
            "successCount" AS success_count,
            "failedCount"  AS failed_count
`;
```

Key elements:

1. **`results || <outcome>::jsonb`** — PostgreSQL's JSONB
   concatenation is atomic. Even if 5 workers run this at the same
   instant, PG serializes them internally and every outcome ends up in
   the array.

2. **`"successCount" = "successCount" + $isSuccess`** — atomic
   increment; no read-modify-write.

3. **`RETURNING` the new totals** — lets the worker know if this
   was the last job (total = success + failed) without a separate
   SELECT.

4. **Then a follow-up `UPDATE ... SET status = ...`** — only the
   last worker writes the final status. Even if two workers race to
   set the final status (which is possible if two finish simultaneously
   for the last two slots), they compute the same value based on
   `total/success/failed`, so idempotent.

**Alternative: Prisma `$transaction` with SERIALIZABLE isolation.**
Would also work, but slower (SERIALIZABLE forces conflicts to abort
and retry) and more verbose. The raw SQL is both simpler and faster.

---

### Q8.5 — Why not use per-order rows for results?

Both approaches work. Trade-offs:

| Aspect | JSON array in BatchJob | Separate BatchOrderResult table |
|---|---|---|
| Read `GET /batches/:id` | 1 row read | 1 row + N rows join |
| Concurrent append safety | Requires atomic JSONB update (implemented) | Trivially safe (each row is independent INSERT) |
| Query "all failed orders in batch X" | JSON operators (`->>`) | Standard SQL |
| Schema evolution | JSON = flexible | Columns = strict |

For our use case (polling API, results returned as a whole batch), the
JSON array wins the read path. If we needed to query across batches
("show me all failed COD orders this week"), a separate table would be
better.

The atomic JSONB append neutralizes the concurrency downside.

---

### Q8.6 — Queue name / prefix — why per-env?

Real bug I hit during development:

- The `backend` service (via supervisor) was running with `NODE_ENV=development` and connected to `courier_platform` DB and Redis DB 0.
- Jest tests were running with `NODE_ENV=test` and connected to `courier_platform_test` DB and the **same Redis DB 0**.
- Test enqueued jobs → the dev worker picked them up → tried to update the batch in `courier_platform` (main DB) → didn't find it → logged error, discarded the outcome.
- Test polled the test DB batch → never got a result → **timed out**.

Fix: use BullMQ's `prefix` option to namespace the queue keys by env.

```ts
export const BULK_QUEUE_PREFIX = `mc-${env.NODE_ENV}`;

new Queue(BULK_QUEUE_NAME, {
  prefix: BULK_QUEUE_PREFIX,   // 'mc-development', 'mc-test', 'mc-production'
  connection: ...
});
```

Now the dev queue lives at Redis keys `mc-development:bulk-shipments:*`
and the test queue at `mc-test:bulk-shipments:*`. Zero overlap.

**Alternative:** use separate Redis DB numbers (Redis has DB 0–15 by
default). Would also work but requires the connection to specify a
`db` param, which is easy to forget. The prefix approach makes
isolation explicit in code.

---

### Q8.7 — What if the worker dies mid-job?

**BullMQ behavior:**

- Jobs move through `waiting → active → completed | failed`.
- If a worker dies while a job is `active`, BullMQ detects it via a
  heartbeat mechanism (stalled-job detection) and moves the job back
  to `waiting`.
- Another worker picks it up.

**Our configuration:**
```ts
defaultJobOptions: {
  attempts: 1,    // do NOT retry business failures
  removeOnComplete: { count: 500 },
  removeOnFail:     { count: 500 },
}
```

We keep `attempts: 1` because our **adapter already handles transient
errors** via `withRetry` (5xx + network) and the 401 refresh. If we
allowed BullMQ retries, a transient courier failure that was correctly
handled by adapter retry might still leave a stale job in the queue
that gets re-processed later.

**Idempotency saves us on stall recovery:** if a stalled job re-runs,
`OrderService.create` finds the existing order via `findByOrderId` and
returns it as idempotent. Worst case, the batch results might get the
same outcome appended twice for one order — a follow-up would dedupe
by `orderId` in the aggregation query.

**Better fix in v2:** send a client `idempotency-key` header to the
courier so even a duplicate courier call doesn't create two shipments
at their end.

---

## 9. Errors

### Q9.1 — Class hierarchy?

```
AppError (base — statusCode, code, details, isOperational)
├── ValidationError         (400, VALIDATION_ERROR)
├── NotFoundError            (404, NOT_FOUND)
├── ConflictError            (409, CONFLICT)
├── InvalidStateError        (409, INVALID_STATE)
├── UnsupportedCourierError  (400, UNSUPPORTED_COURIER)
├── AuthenticationError      (401, AUTHENTICATION_ERROR)  — courier auth
└── CourierAPIError          (502, COURIER_API_ERROR)     — upstream failure
```

Base class:
```ts
class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 500,
    public readonly code = 'INTERNAL_ERROR',
    public readonly details?: unknown,
    public readonly isOperational = true,
  ) {
    super(message);
    // ...
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}
```

**Why this design:**

- **`statusCode`** — every error carries its HTTP status → middleware
  can trust it without a `switch` statement.
- **`code`** — machine-readable identifier for clients (they can
  handle `UNSUPPORTED_COURIER` differently from `VALIDATION_ERROR`).
- **`details`** — structured additional context (Zod field errors,
  upstream body, etc.).
- **`isOperational`** — distinguishes expected/handled errors from
  bugs (unknown exceptions). We log the latter as `error` with stack.
- **`toJSON`** — every error self-serializes to the canonical envelope.

---

### Q9.2 — How are Zod errors handled?

```ts
// errorMiddleware.ts
if (err instanceof ZodError) {
  const validation = new ValidationError('Request validation failed', err.flatten());
  res.status(validation.statusCode).json(validation.toJSON());
  return;
}
```

`err.flatten()` produces:
```json
{
  "formErrors": [],
  "fieldErrors": {
    "orderId":     ["String must contain at least 1 character(s)"],
    "pickup.phone":["Required"]
  }
}
```

Clients get field-level error info for their forms, and the response
still fits the canonical `{ error: {code, message, details} }` shape.

**Why not raw `err.errors`:** it's an array of internal Zod issues
with `.path` as `(string|number)[]` — messier for JSON consumers.
`flatten()` groups by field.

---

### Q9.3 — Why does `CourierAPIError` carry `upstreamStatus`?

Two use cases:

**1. Distinguishing real upstream errors from network flakes** (used
in `MockCourierAdapter`):

```ts
} catch (err) {
  if (err instanceof CourierAPIError && err.upstreamStatus !== undefined) throw err;
}
return this.deterministicCreate(input);
```

- `upstreamStatus` defined → the courier actually replied with an error → propagate as-is.
- `upstreamStatus` undefined → this was a network/DNS/connection failure → deterministic fallback.

Without this distinction, the Mock adapter couldn't tell "the courier
said no" from "we couldn't reach the courier".

**2. Debugging in logs:**
```json
{
  "level": "error",
  "code": "COURIER_API_ERROR",
  "message": "[Urbanebolt] createShipment failed with status 429",
  "details": {
    "courierPartner": "Urbanebolt",
    "upstreamStatus": 429,
    "upstreamBody": {"error": "rate_limited", "retry_after": 60}
  }
}
```

Ops can immediately see the upstream status + body without spelunking.

---

### Q9.4 — 502 vs. 401 vs. 400 selection?

| Situation | Our status | Rationale |
|---|---|---|
| Zod validation failed | 400 | Client sent bad data |
| Unknown courier name | 400 | Client asked for something we don't support |
| Order not found | 404 | Standard REST |
| Duplicate orderId within a bulk batch | 400 | Client's fault |
| Cancel a delivered order | 409 | Resource state conflict |
| Courier returned 4xx (e.g. bad recipient address) | 502 | Upstream error (we can't fix by retrying; but it's not the caller's fault — they gave us valid data) |
| Courier returned 5xx / network failure after retries | 502 | Upstream failure |
| Courier persistent 401 after refresh | 401 | Our creds broken; usually infrastructure issue |

**Why 502 (Bad Gateway) for courier failures:**

We act as a gateway to the courier. When the courier fails, it's most
honestly a gateway failure — the client's request was valid, but we
couldn't fulfill it because our upstream failed. 500 would suggest a
bug in *our* code, which isn't the case.

**Why 401 for courier auth failure and not 500:**

401 with the response body `code: AUTHENTICATION_ERROR` makes the ops
signal clear: someone needs to rotate creds. Bundling it into 500
would hide it in the noise.

---

## 10. Database / Prisma

### Q10.1 — Enums in Prisma vs. app code?

Prisma generates TypeScript enums from the schema. We re-export them
for convenient app usage plus helpers:

```ts
// utils/statusEnum.ts
import { ShipmentStatus } from '@prisma/client';
export { ShipmentStatus };

export const TERMINAL_STATUSES: ReadonlySet<ShipmentStatus> = new Set([
  ShipmentStatus.DELIVERED,
  ShipmentStatus.CANCELLED,
  ShipmentStatus.FAILED,
]);
export function isTerminalStatus(status: ShipmentStatus) { /* ... */ }
export function canCancel(status: ShipmentStatus) { /* ... */ }
```

**Why re-export instead of `import from '@prisma/client'` everywhere:**
- One import path for status-related helpers (`isTerminalStatus`,
  `canCancel`) plus the enum itself.
- Easier to swap the enum source later (e.g. move to a shared package)
  without touching every call site.

---

### Q10.2 — Required indexes?

From `prisma/schema.prisma`:

**Order:**
- `orderId` (unique) — idempotency lookup.
- `trackingNumber` — track by AWB.
- `courierOrderId` — cross-ref courier's internal ID.
- `batchId` — list orders in a batch.
- `status` — dashboards / filters.

**TrackingHistory:**
- `orderId` — get all events for one order.
- `eventTime` — order chronologically.

**BatchJob:**
- `batchId` (unique) — poll status.
- `status` — dashboards.

**Courier:**
- `name` (unique) — lookup by name.

All indexes are B-tree by default, which is what we want for equality
and range queries on these columns. No partial or GIN indexes needed
in v1.

---

### Q10.3 — Migrations flow?

Development:
```bash
npx prisma migrate dev --name add_shipping_notes
```
- Applies the change to the dev DB.
- Generates a SQL migration in `prisma/migrations/`.
- Regenerates the Prisma client.

CI / production:
```bash
npx prisma migrate deploy
```
- Applies pending migrations idempotently.
- Never generates new ones (fails on drift).

Tests use `migrate deploy` in the Jest DB helper:
```ts
// tests/helpers/db.ts
if (!migrated) {
  execSync('npx prisma migrate deploy', { stdio: 'ignore', env: process.env });
  migrated = true;
}
```
Runs once per Jest process, on demand. No manual setup needed to run
the suite.

**Drift handling:** if the DB schema doesn't match migrations,
`migrate deploy` fails loudly. In prod this triggers a runbook: check
what's different, generate a repair migration.

---

### Q10.4 — How do you seed?

```ts
// prisma/seed.ts
await prisma.courier.upsert({
  where: { name: 'Urbanebolt' },
  update: {},
  create: {
    name: 'Urbanebolt',
    baseUrl: process.env.URBANEBOLT_BASE_URL || 'https://uat.urbanebolt.in',
    authenticationType: AuthType.USERNAME_PASSWORD,
    isActive: true,
  },
});
```

**Upsert not insert:** re-running the seed is idempotent. Safe to call
after every migration, in CI, etc.

**Which data is seeded:** just the reference data — courier
registrations. Order/tracking/batch data is transactional and never
seeded.

**Where seed runs:**
- Manually: `yarn prisma:seed`.
- Auto: `prisma migrate reset --seed` (recreates DB then seeds).
- Tests: `tests/helpers/db.ts:resetDatabase()` inlines the seed.

---

### Q10.5 — Prisma client — one or many?

Singleton:

```ts
// repositories/prismaClient.ts
class PrismaSingleton {
  private static _client: PrismaClient | null = null;
  static get client(): PrismaClient {
    if (!this._client) this._client = new PrismaClient({...});
    return this._client;
  }
}
export const prisma = PrismaSingleton.client;
```

**Why singleton:**

- Each `new PrismaClient()` opens a fresh connection pool. Multiple
  instances → too many DB connections → pool exhaustion on the DB side.
- Prisma's internal query engine is process-heavy; sharing avoids
  duplicate resource use.
- The singleton pattern is standard Prisma guidance (see their docs).

The `disconnectPrisma()` helper is called on `SIGTERM`/`SIGINT` and by
tests in `afterAll` — ensures clean shutdown without leaked
connections.

**Repository classes take a `PrismaClient` in the constructor with
`prisma` as the default:**
```ts
constructor(prismaClient: PrismaClient = defaultPrisma) {
  this.prisma = prismaClient;
}
```

This lets tests inject a mock or a fresh client if needed, while
production uses the singleton.

---

## 11. Validation (Zod)

### Q11.1 — Why Zod, and where does it live?

**Why Zod:**
- Runtime + compile-time types from one source of truth
  (`z.infer<typeof schema>` gives you the TS type).
- Composable: `addressSchema` reused for pickup and delivery.
- Rich error format (`.flatten()`, `.format()`) suited to API responses.
- Cross-field refinements via `.refine(...)`.
- Small footprint (no annotation-based DTOs, no reflection).

**Where it lives:**
- Request bodies: `validators/order.validator.ts` — one schema per
  endpoint (`createOrderSchema`, `cancelOrderSchema`, `bulkCreateSchema`).
- Env: `config/env.ts` — the entire process env is Zod-validated at
  import time.

Controllers call `.parse(req.body)` which throws `ZodError` on
failure. The error middleware catches it centrally.

---

### Q11.2 — Env validation?

```ts
// config/env.ts
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8001),
  DATABASE_URL: z.string().min(1),
  // ...
  RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  URBANEBOLT_BASE_URL: z.string().url().default('https://uat.urbanebolt.in'),
  // ...
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Invalid environment configuration:', parsed.error.format());
  throw new Error('Invalid environment configuration');
}
export const env = parsed.data;
```

**Properties:**
- **`z.coerce.number()`** — env vars are strings by default; coercion
  turns them into numbers with validation.
- **`z.string().url()`** — validates the URL format for BASE_URLs.
- **`z.string().min(1)` for `DATABASE_URL`** — no silent default;
  missing → process exits.
- **Sensible defaults for tunables** (retry attempts, concurrency, etc.).
- **No defaults for secrets** — forces explicit configuration.
- **Fail fast** — invalid env kills the process on startup, not at
  request time.

The exported `env` object is fully typed, so every consumer gets
autocomplete and compile-time checks.

---

### Q11.3 — Cross-field validation example?

```ts
// validators/order.validator.ts
const paymentSchema = z
  .object({
    mode: z.enum(['PREPAID', 'COD']),
    codAmount: z.number().nonnegative().optional(),
  })
  .refine(
    (v) => v.mode !== 'COD' || (typeof v.codAmount === 'number' && v.codAmount > 0),
    { message: 'codAmount must be > 0 when mode = COD', path: ['codAmount'] },
  );
```

**What it enforces:**
- If `mode = PREPAID`, `codAmount` is irrelevant (missing or any value
  is fine).
- If `mode = COD`, `codAmount` must be present and > 0.

**The `path: ['codAmount']`** makes the error attach to the right
field so the client can highlight it in their UI:
```json
{ "fieldErrors": { "payment.codAmount": ["codAmount must be > 0 when mode = COD"] } }
```

---

## 12. Logging & Observability

### Q12.1 — Log format?

**Production** — Winston structured JSON:
```json
{
  "level": "info",
  "message": "HTTP request",
  "timestamp": "2026-01-10T05:19:56.051Z",
  "requestId": "185a6aa6-1f19-4499-a0c3-6e60b04c308c",
  "method": "POST",
  "path": "/api/orders",
  "status": 201,
  "durationMs": 42
}
```

- Machine-parseable → ingestible by Loki, Datadog, ELK, etc.
- No log parsing needed to extract fields.

**Development** — colorized single-line:
```
05:18:53 [info] Multi-Courier Platform ready {"port":8001,"env":"development"}
```

- Human-friendly during local iteration.

**Test** — silent (`silent: env.NODE_ENV === 'test'`):
- Keeps test output clean.
- Errors are still assertable via `expect().toThrow`.

---

### Q12.2 — What context do request logs carry?

**Every log line downstream of the request** carries `requestId`.
This is achieved by:

1. **`requestIdMiddleware`** — reads `x-request-id` header (if present)
   or generates a UUID. Attached to `req.requestId`, echoed as
   `x-request-id` response header.

2. **Middleware & controllers pass `requestId` to services:**
   ```ts
   await this.orderService.create(parsed, { requestId: req.requestId });
   ```

3. **Services pass it into log calls:**
   ```ts
   logger.info('Courier createShipment succeeded', {
     requestId: ctx.requestId,
     orderId: req.orderId,
     courierPartner: adapter.courierName,
     durationMs: Date.now() - started,
   });
   ```

**Not using AsyncLocalStorage yet** — deliberate simplicity for v1.
Passing through explicit `ctx` param is clearer, less magic, and
easier to test. For v2 with deeply nested code, AsyncLocalStorage
would clean it up.

**Standard fields on request logs:**
- `requestId`, `method`, `path`, `status`, `durationMs`.

**Standard fields on courier logs:**
- `courierPartner`, `operation` (`createShipment` / `trackShipment` / …),
  `durationMs`, `attempt` (on retry).

---

### Q12.3 — Log levels applied?

Applied in `loggingMiddleware` at request completion:
```ts
if (res.statusCode >= 500) logger.error('HTTP request', meta);
else if (res.statusCode >= 400) logger.warn('HTTP request', meta);
else logger.info('HTTP request', meta);
```

And by convention in the code:
- **info** — successful business events (order created, shipment
  cancelled, batch enqueued).
- **warn** — unusual but handled events (retry attempt, validation
  failure, business-error outcome in a bulk job).
- **error** — unhandled/unexpected failures (5xx, courier persistent
  failure, unknown exception).

**Level control** — `LOG_LEVEL` env var (default `info`). In prod
you'd typically ship `info` and above to your log aggregator.

---

## 13. Testing

### Q13.1 — What kinds of tests are there?

**Unit** (`tests/unit/` — 7 files):
- `retry.test.ts` — exponential backoff behavior of `withRetry`.
- `errors.test.ts` — error class shapes, `toJSON`, subclass status codes.
- `factory.test.ts` — CourierFactory registration, caching, OCP.
- `statusMaps.test.ts` — canonical mappings + fallback.
- `mockCourierAdapter.test.ts` — deterministic fallback, HTTP path, error propagation.
- `urbaneboltAdapter.test.ts` — full adapter behavior including 401 refresh, 5xx retry, error paths.
- `orderService.test.ts` — service logic with mocked dependencies.

**Integration** (`tests/integration/` — 5 files):
- `createOrder.test.ts` — real DB + Express + Zod + service + adapter (via nock).
- `trackOrder.test.ts` — tracking flow with dedupe and status updates.
- `cancelOrder.test.ts` — state guards and terminal states.
- `bulkOrder.test.ts` — real BullMQ, real Redis, real worker.
- `repositories.test.ts` — repository correctness against real DB.

**No E2E** — for this scope, integration tests with `nock` are
sufficient. E2E against a real courier UAT would be flaky and slow.

---

### Q13.2 — Coverage?

Current numbers (from `jest --coverage`):

```
All files:  91.48% statements | 65.99% branches | 87.9% functions | 93.1% lines
Test Suites: 12 passed, 12 total
Tests:       71 passed, 71 total
```

Thresholds in `jest.config.ts`:
```ts
coverageThreshold: {
  global: { branches: 60, functions: 70, lines: 75, statements: 75 },
}
```

Well above the 80% spec target on statements and lines. Branch
coverage is 66% because a lot of branches are error-guards on
"impossible" states (defensive code) — chasing 100% branch coverage
often reduces code quality.

**What's NOT tested:**
- `server.ts` (bootstrap wiring) — excluded via
  `collectCoverageFrom: ['!src/server.ts']`. Testing it requires
  starting a server which is more of a smoke test.
- `config/*` — excluded similarly.

**What is tested exhaustively:**
- All happy paths.
- All error classes and their status codes.
- Adapter retry + 401 + 4xx + 5xx paths.
- Idempotency (return existing, uniqueness).
- Bulk partial success with real BullMQ.
- Validation refinements (COD amount).
- Cross-request state (track updates persisted status).

---

### Q13.3 — Why `nock` for adapter tests?

**`nock`** intercepts HTTP requests at the Node HTTP layer and returns
canned responses. Alternatives (all rejected):

- **msw** — designed for browser, has Node support but heavier for
  Node-only tests.
- **Manual axios adapter override** — hides less; couples tests to axios internals.
- **Real courier UAT** — flaky (their downtime = our test failures),
  slow, costs money, requires network access.

**What `nock` gives us:**

- **Assert on URL, method, headers, and body**:
  ```ts
  nock(BASE)
    .post('/api/v1/services/manifest/', body => body.order_id === 'X')
    .matchHeader('authorization', 'Bearer abc-token')
    .reply(200, {...});
  ```
- **Simulate any status code**: 401, 5xx, network errors.
- **Simulate sequence**: use multiple `.reply()` calls in order to
  script a 5xx → 5xx → 200 sequence for retry testing.
- **Hermetic**: `nock.disableNetConnect()` in `beforeAll` ensures no
  test accidentally hits the real internet.

**Bonus** — `nock` failures on unmatched requests are loud, so tests
fail predictably if your adapter starts calling an unexpected URL.

---

### Q13.4 — How do you avoid cross-test pollution?

Multiple layers of isolation:

**1. Per-test DB reset:**
```ts
beforeEach(async () => {
  await resetDatabase();  // deletes all data, re-seeds couriers
});
```
Deletes in FK order (tracking_history → orders → batch_jobs → couriers)
to avoid constraint violations.

**2. Per-test factory reset:**
```ts
CourierFactory.resetInstances();
```
Ensures no cached auth tokens leak from a previous test.

**3. `nock.cleanAll()` in `afterEach`:**
Cleans up any pending scopes so a leaked interceptor from test A
doesn't interfere with test B.

**4. Dedicated test DB:**
`courier_platform_test` is a separate PostgreSQL database. Tests never
touch the dev/production DB.

**5. Per-env BullMQ prefix:**
`mc-test:*` keys are separate from `mc-development:*` — dev worker
can't consume test jobs.

**6. `--runInBand`:**
Tests run serially in one process. Parallel processes would need
multiple test DBs.

**7. Fresh `nock.enableNetConnect('127.0.0.1')` for integration tests:**
Loopback is allowed (for Prisma → PG on 5432 and BullMQ → Redis on
6379) but external hosts are blocked. Any accidental real courier
call would fail loudly.

---

### Q13.5 — Bulk test — how do you know when the batch is done?

Polling helper:

```ts
async function waitForBatch(batchId: string, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await request(app).get(`/api/batches/${batchId}`);
    const status = res.body?.data?.status;
    if (status === 'COMPLETED' || status === 'PARTIAL' || status === 'FAILED') {
      return res.body.data;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Batch ${batchId} did not complete in ${timeoutMs}ms`);
}
```

**Why polling and not events:**
- The HTTP API is polling-based (users poll `GET /batches/:id`), so
  the test uses the same interface.
- No need to wire BullMQ events into the test.
- Deterministic termination via terminal statuses.

**Bounded timeout:** if the worker is stuck or dead, the test fails
loudly at 15s rather than hanging Jest indefinitely.

**Interval:** 200ms — fast enough that a typical batch (2-5s) finishes
in ~10-25 polls, slow enough not to spam.

---

## 14. Trade-offs & Extensions

### Q14.1 — What would you do first for v2?

Prioritized:

1. **P2002 race handling for idempotency** — catch the unique-constraint
   violation in `OrderService.create` and return the existing row as
   idempotent instead of 500. Requires ~5 lines.

2. **Client idempotency key sent to courier** — pass a stable header
   (e.g. `X-Idempotency-Key: order-<orderId>`) so a duplicate call at
   *their* end doesn't create two shipments. Courier-support-dependent.

3. **Webhook receiver** — real-time tracking via
   `POST /api/webhooks/urbanebolt` with HMAC signature verification.
   Would eliminate polling latency.

4. **`/metrics` endpoint** — Prometheus format with counters
   (`courier_calls_total{partner,operation,outcome}`) and histograms
   (`courier_call_duration_seconds`). Right now we have logs but no
   time-series metrics.

5. **Rate limiter middleware** — per-tenant / per-IP quotas.

6. **BullMQ dashboard** (`bull-board`) mounted at `/admin/queues` for
   ops visibility.

7. **Circuit breaker per courier** — if Urbanebolt's error rate spikes,
   short-circuit calls for N seconds and fail fast.

---

### Q14.2 — Why polling instead of webhooks for tracking?

**Polling wins for v1** because:
- **No public endpoint required** — the platform doesn't need a
  reachable HTTPS URL for webhooks (each courier would need to know it
  and be maintained).
- **No signature verification code** — every courier signs webhooks
  differently (HMAC-SHA256 with different secret rotations); v1 avoids
  that complexity.
- **Simpler testing** — polling flows are deterministic; webhook
  delivery testing needs a real HTTP inbound.
- **Idempotency naturally provided** — polls are read-only, so double
  polls are safe. Webhook idempotency requires a dedup table.

**Cost:** tracking updates lag by the polling interval. For most
shipping use cases (customer-facing "where is my package"), a
5-15 minute lag is acceptable.

**Migration path:** add webhook receiver alongside polling in v2.
Adapters expose a `verifyWebhook` method. Polling stays as fallback.

---

### Q14.3 — Multi-tenant support?

**What changes:**

1. **Factory** — cache key becomes `(courierName, tenantId)`:
   ```ts
   static create(name: string, tenantId: string): ICourierAdapter {
     const key = `${tenantId}:${this.norm(name)}`;
     // ...
   }
   ```

2. **Adapter constructors** — accept tenant credentials:
   ```ts
   new UrbaneboltAdapter({ username, password, baseUrl });
   ```
   Instead of reading from `env`.

3. **Repositories** — every query scoped by `tenantId`:
   ```ts
   findByOrderId(tenantId: string, orderId: string) {
     return this.prisma.order.findFirst({ where: { tenantId, orderId } });
   }
   ```

4. **Schema** — `tenantId` column on all tables, composite unique on
   `(tenantId, orderId)`.

5. **Auth middleware** — resolves the tenant from the platform-auth
   header (JWT/API key) and attaches to `req.tenantId`.

6. **Services** — take `tenantId` in ctx and pass it down.

**What stays the same:** interfaces, patterns, error hierarchy,
retry/auth logic, adapter implementations. The pattern extends
cleanly.

---

### Q14.4 — How would you swap Postgres for another DB?

**Only the Prisma schema and repositories change.**

1. **Prisma schema** — change `datasource db { provider = "postgresql" }`
   to e.g. `"mysql"` or `"sqlite"` or `"mongodb"` (Mongo would require
   more schema rework since it's document-based).

2. **Repositories** — Prisma abstracts most differences, but a few
   things vary:
   - JSONB features (Postgres-specific) — the atomic
     `results || $::jsonb` bulk update needs a rewrite for other DBs.
   - Case sensitivity in string comparisons varies by DB.

3. **Migrations** — Prisma generates DB-specific SQL. Migration files
   are DB-specific artifacts.

**What stays the same:** everything else. Services depend on
repository classes; swapping the DB doesn't change the repository
interface.

---

### Q14.5 — Adapter that needs OAuth2 client credentials?

Just implement `authenticate()`:

```ts
class SpeedyAdapter extends BaseCourierAdapter {
  public readonly courierName = 'Speedy';

  protected async authenticate(): Promise<string> {
    const res = await this.http.post('/oauth2/token',
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: env.SPEEDY_CLIENT_ID,
        client_secret: env.SPEEDY_CLIENT_SECRET,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    return res.data.access_token;
  }

  // createShipment / trackShipment / cancelShipment use executeAuthed as usual
}
```

The rest of the plumbing — token caching, 401-refresh, retry — is
inherited from `BaseCourierAdapter` unchanged.

**Refresh-token flow (if courier supports it):**
Override `authenticate()` to store the refresh token per-instance and
use it when the access token expires. Falls back to full client-creds
if refresh fails. Slightly more state per adapter instance.

---

### Q14.6 — Adapter with per-call HMAC signing?

Do the signing inside the adapter method, using an axios interceptor
or explicit header assembly:

```ts
async createShipment(input) {
  const body = this.buildPayload(input);
  const signature = hmacSha256(JSON.stringify(body), env.SPEEDY_SECRET);
  const res = await this.executeAuthed('createShipment', () =>
    this.http.post('/shipments', body, {
      headers: { 'X-Signature': signature, 'X-Timestamp': Date.now() },
    }),
  );
  // ...
}
```

Or, cleaner, use an Axios request interceptor set up in the adapter's
constructor so every outbound call gets signed automatically:

```ts
constructor(http?: HttpClient) {
  super(http ?? new HttpClient({ baseURL: env.SPEEDY_BASE_URL }));
  // (would need to expose the axios instance on HttpClient for this)
}
```

The point is: **signing is a courier-specific concern; it lives in
the adapter, not in `BaseCourierAdapter` or elsewhere.** If two
couriers happened to use the same signing scheme, we'd extract a
helper — but not until then (avoid premature abstraction).

---

## 15. Rapid-fire code-reading questions

**Show me where retry lives.**
> `src/utils/retry.ts` (`withRetry`) — a general-purpose async retry
> util. Used only from `src/couriers/adapters/BaseCourierAdapter.ts`
> (`executeAuthed`).

**Where do 4xx responses turn into `CourierAPIError`?**
> `BaseCourierAdapter.ensureOk` (final `throw new CourierAPIError`
> branch), plus each adapter's `res.status >= 400 && res.status !== 401`
> guards (used by MockCourierAdapter to distinguish real 4xx from
> network failures).

**Where is idempotency enforced?**
> Two places: (1) `OrderService.create` early-return on
> `orderRepo.findByOrderId`. (2) DB unique constraint on
> `Order.orderId @unique` in `prisma/schema.prisma`.

**What guards a cancel?**
> `CancellationService.cancel` — three guards:
> (a) `!order` → `NotFoundError`.
> (b) `order.status === CANCELLED` → return `alreadyCancelled: true`.
> (c) `!canCancel(order.status)` → `InvalidStateError` (rejects
>     `IN_TRANSIT/DELIVERED/CANCELLED/FAILED`).
> Then adapter is called; on success, status → `CANCELLED` and
> `TrackingHistory.append(CANCELLED)`.

**Where is the atomic bulk result update?**
> `src/queue/bulkWorker.ts:appendBulkResultAtomic` — a raw
> `prisma.$queryRaw` executing
> `UPDATE batch_jobs SET results = results || $::jsonb, "successCount" = "successCount" + $, "failedCount" = "failedCount" + $ ... RETURNING ...`.
> Uses Postgres JSONB concatenation for atomicity.

**How does the factory know about built-in couriers?**
> `registerBuiltIns()` at the bottom of
> `src/couriers/factory/CourierFactory.ts`, called once at module
> load. Registers `Urbanebolt` and `MockCourier`. `_resetAll()` also
> calls it to reset test state.

**What clears the auth token in `BaseCourierAdapter`?**
> Automatic: `this.cachedToken = null` in `executeAuthed` when the
> upstream returns 401 (before the single retry).
> Manual (tests): `_clearAuthCache()` public method.

**What port does the server bind to?**
> `env.PORT` (default `8001`), on `0.0.0.0` — see `src/server.ts:
> app.listen(env.PORT, '0.0.0.0', ...)`. Emergent preview routes
> `/api/*` to port 8001.

**Where is env schema defined?**
> `src/config/env.ts` — Zod schema (`envSchema`), parsed via
> `safeParse`, exits process on failure. Exports typed `env` object.

**Where is the 401 refresh test?**
> `tests/unit/urbaneboltAdapter.test.ts` — "handles 401 → refresh token → retry once".
> Uses `nock.matchHeader('authorization', 'Bearer t-old')` on the
> failing call and `Bearer t-new` on the retry to prove the token
> actually changed.

**Which columns are indexed on `Order`?**
> `orderId` (unique), `trackingNumber`, `courierOrderId`, `batchId`,
> `status`. See `@@index([...])` and `@unique` in the `Order` model of
> `prisma/schema.prisma`.

---

## Appendix — Deep dives ready if asked

**"How would you introduce a circuit breaker?"**
> A per-courier state machine tracking recent error rate. Below
> threshold: closed (normal). Above threshold: open (fail fast for N
> seconds). After cooldown: half-open (allow one probe). Implementable
> either as (a) a wrapper around `executeAuthed` that consults a
> stateful CircuitBreaker instance, or (b) via a library like `opossum`.
> Placed at the adapter layer, per-courier instance, so a failing
> courier doesn't take down the platform.

**"How would you make the retry policy per-operation?"**
> Move retry config from `env` (currently global) to
> `ICourierAdapter` metadata:
> ```ts
> interface CourierRetryPolicy {
>   createShipment: RetryOptions;
>   trackShipment:  RetryOptions;
>   cancelShipment: RetryOptions;
> }
> ```
> Each concrete adapter declares its policy (tracking is idempotent
> and safe to retry aggressively; cancel is more sensitive).
> `executeAuthed` reads the policy for the current operation.

**"How would you audit courier billing?"**
> Add `courierBillingUnits` (Decimal) column to `Order`, computed
> after each successful create/cancel from `rawResponse`. Then
> aggregate by `courierId` + date. A separate `CourierInvoice` table
> would hold reconciliation with courier invoices. Out of scope for v1.

**"Handling multi-region deployment?"**
> Region-affinity via extra courier metadata (`Courier.region`).
> `CourierRepository.findByName` becomes `findByNameAndRegion`. The
> factory keys instances by `(name, region)`. Bulk queue could be
> sharded by region. Nothing about the layer architecture changes.
