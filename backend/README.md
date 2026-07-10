# Multi-Courier Integration Platform

A production-grade backend that provides a **unified API abstraction over
multiple courier providers**. Adding a new courier is a two-line change:
create an adapter class and register it with the factory.

Built with **TypeScript, Express, Prisma (PostgreSQL), BullMQ (Redis),
Zod, Winston, Jest, Supertest, and nock**, following Clean Architecture
and strict layer boundaries.

---

## Architecture at a glance

```
Route → Controller → Validator (Zod) → Service → CourierFactory → CourierAdapter → Repository → Prisma → PostgreSQL
```

Mandatory patterns applied: **Adapter, Factory, Strategy, Repository,
Dependency Injection** (constructor-based). See `DESIGN.md` for detail.

Cross-cutting concerns:

- **Retry:** exponential backoff, adapter-layer only, configurable via env.
- **401 handling:** adapter catches 401 → `authenticate()` → retries the
  original call **exactly once**.
- **Idempotency:** DB-enforced (`Order.orderId @unique`). Repeat creates
  return the existing shipment with `idempotent: true`.
- **Status normalization:** courier-native → canonical enum, inside the
  adapter only. Persisted values:
  `CREATED, PICKED_UP, IN_TRANSIT, DELIVERED, CANCELLED, FAILED`.
- **Bulk:** BullMQ worker with `concurrency = BULK_CONCURRENCY (default 5)`;
  partial success is fully supported and each order's outcome is stored
  in `BatchJob.results`.
- **Errors:** `AppError` → `ValidationError, CourierAPIError,
  UnsupportedCourierError, AuthenticationError, InvalidStateError,
  NotFoundError, ConflictError` → central `errorMiddleware`.
- **Logs:** Winston structured JSON with `requestId, orderId,
  courierPartner, duration`.
- **Env:** Zod-validated schema; no hardcoded secrets. See `.env.example`.

---

## Endpoints (all under `/api`)

| Method | Path                          | Description                                |
|--------|-------------------------------|--------------------------------------------|
| POST   | `/api/orders`                 | Create shipment (idempotent via `orderId`) |
| GET    | `/api/orders/:id`             | Get order + tracking history               |
| GET    | `/api/orders/:id/track`       | Track shipment (adapter-driven poll)       |
| POST   | `/api/orders/:id/cancel`      | Cancel shipment                            |
| POST   | `/api/orders/bulk`            | Bulk create (max 100, async via BullMQ)    |
| GET    | `/api/batches/:batchId`       | Batch status polling                       |
| GET    | `/api/health`                 | Liveness check                             |

Adapters in v1: **Urbanebolt**, **MockCourier**.

---

## Setup

### Prerequisites

- **Node.js 22+**
- **PostgreSQL 15+**
- **Redis 7+**
- `yarn` (npm also works but `yarn` is used in scripts)

### Install & configure

```bash
cd backend
yarn install

# copy env template and adjust
cp .env.example .env
# minimum values you MUST set:
#   DATABASE_URL, REDIS_HOST/PORT, URBANEBOLT_USERNAME, URBANEBOLT_PASSWORD
```

### Database

```bash
# generate Prisma client
yarn prisma:generate

# create and migrate the DB
yarn prisma:migrate

# seed the couriers (Urbanebolt + MockCourier)
yarn prisma:seed
```

### Run

```bash
# hot-reload dev server + in-process BullMQ worker
yarn dev

# production
yarn build && yarn start
```

Server binds to `0.0.0.0:${PORT}` (default `8001`), routes mounted under `/api`.

### Docker Compose (optional)

The repo ships a `docker-compose.yml` that spins up Postgres and Redis
so you can develop the app locally on your host.

```bash
docker compose up -d
```

---

## Running the tests

```bash
# unit tests
yarn test

# with coverage (Jest thresholds enforced)
yarn test:coverage
```

The suite is fully offline:

- **`nock`** intercepts every courier HTTP call — the network is
  disabled via `nock.disableNetConnect()` during tests.
- A dedicated `courier_platform_test` DB is used (see
  `DATABASE_URL_TEST` env for override).
- BullMQ uses a **per-env queue prefix** (`mc-test`, `mc-development`,
  …) so dev + test workers never fight over jobs on shared Redis.

Current coverage (Jan 2026):

```
All files: 91.48% statements | 65.99% branches | 87.9% functions | 93.1% lines
71 tests across 12 suites, all passing.
```

---

## Adding a new courier

Suppose you want to add "Speedy":

1. **Create adapter:** `src/couriers/adapters/SpeedyAdapter.ts`

   ```ts
   import { BaseCourierAdapter } from './BaseCourierAdapter';
   import { HttpClient } from '../../utils/httpClient';
   import { env } from '../../config/env';
   import { mapSpeedyStatus } from '../statusMaps/speedyStatusMap';

   export class SpeedyAdapter extends BaseCourierAdapter {
     public readonly courierName = 'Speedy';

     constructor(http?: HttpClient) {
       super(http ?? new HttpClient({ baseURL: env.SPEEDY_BASE_URL }));
     }

     protected async authenticate() { /* ... */ }
     async createShipment(input) { /* ... */ }
     async trackShipment(awb)     { /* ... */ }
     async cancelShipment(input)  { /* ... */ }
   }
   ```

2. **Register it once** in `CourierFactory.ts`:

   ```ts
   CourierFactory.register('Speedy', SpeedyAdapter);
   ```

3. **Optional but recommended:**
   - Add a status map in `src/couriers/statusMaps/`.
   - Seed a `Courier` row (or add via migration).
   - Add a unit test that mocks the upstream via `nock`.

**Nothing else changes.** Services, controllers, validators, and
routes are entirely courier-agnostic — this is the OCP guarantee the
factory provides.

---

## Environment reference

See `.env.example`. Notable variables:

| Var                       | Purpose                                                |
|---------------------------|--------------------------------------------------------|
| `PORT`                    | HTTP port (default `8001`)                             |
| `DATABASE_URL`            | Postgres connection string                             |
| `REDIS_HOST/PORT`         | Redis for BullMQ                                       |
| `BULK_CONCURRENCY`        | Worker concurrency (default `5`)                       |
| `BULK_MAX_ORDERS`         | Max orders per bulk call (default `100`)               |
| `RETRY_*`                 | Retry policy (attempts, initial delay, max delay, factor) |
| `URBANEBOLT_BASE_URL/USERNAME/PASSWORD` | UrbaneBolt UAT credentials                |
| `MOCK_COURIER_*`          | Mock adapter config (used for local dev + tests)       |

---

## Project layout

```
src/
├── config/                # env (Zod), logger (Winston), redis
├── couriers/
│   ├── interfaces/        # ICourierAdapter contract
│   ├── adapters/          # BaseCourierAdapter + Urbanebolt + Mock
│   ├── factory/           # CourierFactory (registry-based)
│   └── statusMaps/        # native → canonical status mappers
├── controllers/           # HTTP glue only (no business logic)
├── validators/            # Zod schemas (route inputs)
├── services/              # Business logic (courier-agnostic)
├── repositories/          # DB only (no logic)
├── queue/                 # BullMQ queue + worker
├── routes/                # Express routers
├── middleware/            # requestId, logging, error handler
├── errors/                # AppError + subclasses
├── utils/                 # retry, httpClient, statusEnum
├── app.ts                 # Express factory
└── server.ts              # bootstrap: HTTP + worker + shutdown

prisma/
├── schema.prisma
├── migrations/
└── seed.ts

tests/
├── unit/                  # factory, adapters, retry, services, status maps, errors
├── integration/           # createOrder, trackOrder, cancelOrder, bulkOrder, repositories
└── helpers/               # db + fixtures
```

---

## License

MIT
