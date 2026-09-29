# Acme Orders: architecture

Acme Orders is the order-management service behind the Acme storefront. It accepts orders from the web and
mobile clients, reserves stock, takes payment through the payments gateway, hands paid orders to the warehouse,
and sends customer notifications. This document describes the modules, how data flows between them, and the
rules each module follows. Keep it current: every pull request that changes a module boundary updates it.

## System overview

The service is a single Node.js 22 process written in TypeScript, deployed as a container. It exposes an HTTP
API (Fastify) and runs background jobs from the same codebase with a separate entry point. State lives in
PostgreSQL 16; Redis is used only for rate limiting and short-lived locks. There is no shared state between
HTTP workers other than PostgreSQL and Redis.

```text
clients ──► api (Fastify) ──► orders ──► inventory
                 │              │            │
                 │              ├──► payments (gateway adapter)
                 │              └──► notifications ──► email / SMS providers
                 └──► auth (session + API keys)
jobs runner ──► reservation expiry, payment reconciliation, reporting exports
```

Request handling is synchronous up to the point where an order is persisted. Everything after that
(notifications, warehouse hand-off, exports) is driven by the outbox table and the jobs runner, so an HTTP
request never waits on a third-party provider other than the payments gateway.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/api/` | Fastify server, route modules, request validation schemas |
| `src/orders/` | Order aggregate, state machine, pricing, formatting helpers |
| `src/inventory/` | Stock levels, reservations, warehouse adapters |
| `src/payments/` | Gateway adapter, webhooks, reconciliation |
| `src/notifications/` | Templates, provider adapters, delivery log |
| `src/auth/` | Sessions, API keys, permission checks |
| `src/jobs/` | Jobs runner and individual jobs |
| `src/db/` | Query helpers, migrations, transaction utilities |
| `src/config/` | Typed configuration loaded from the environment |
| `src/observability/` | Logging, metrics, tracing setup |
| `test/` | Unit and integration tests (Vitest), fixtures and factories |
| `docs/` | Operational runbooks and API reference |

## API layer

`src/api/server.ts` builds the Fastify instance, registers plugins (CORS, rate limiting, request IDs) and mounts
the route modules from `src/api/routes/`. Each route module exports a single `register(app, deps)` function so
dependencies are injected rather than imported, which keeps route tests fast.

- Request bodies and query strings are validated with JSON schemas that live next to the route
  (`src/api/routes/orders.schema.ts`). Handlers never re-validate input.
- Handlers translate domain errors into HTTP responses with `toHttpError()` from `src/api/errors.ts`.
  Domain modules never import Fastify types.
- Pagination uses opaque cursors produced by `encodeCursor()`; offset pagination is not allowed on
  collections that can grow without bound.
- All responses include the request ID header so support can correlate logs.

### Orders routes

`src/api/routes/orders.ts` exposes `POST /orders`, `GET /orders/:id`, `GET /orders` and
`POST /orders/:id/cancel`. Order numbers shown to customers come from `formatOrderNumber()` in
`src/orders/format.ts`; internal IDs are UUIDs and are never shown in customer-facing text.
The list endpoint filters by `status` and `createdAfter` and is capped at 100 items per page.

### Admin routes

`src/api/routes/admin.ts` is mounted under `/admin` and requires an API key with the `admin` scope. Admin routes
may read across customers but must log an audit event for every write.

## Orders module

The order aggregate lives in `src/orders/order.ts`. An order moves through a small state machine defined in
`src/orders/states.ts`:

```text
draft ──► pending_payment ──► paid ──► fulfilling ──► shipped ──► delivered
   │             │               │
   └──► cancelled ◄──────────────┘ (refunds handled by payments)
```

- Transitions are only performed through `transition(order, event)`, which returns a new order and a list of
  outbox events. Nothing mutates an order in place.
- Pricing (`src/orders/pricing.ts`) computes line totals, discounts and tax in integer minor units. Currency is
  always carried alongside amounts; mixing currencies in one order is rejected.
- `src/orders/format.ts` holds presentation helpers: `formatOrderNumber()`, `formatMoney()` and
  `describeStatus()`. They are pure functions with no I/O and are safe to use from templates.

## Inventory module

`src/inventory/stock.ts` tracks available quantity per SKU and warehouse. Stock is never decremented directly
by the API; instead a checkout creates reservations.

### Reservations

Reservations live in the `inventory_reservations` table and are managed by `src/inventory/reservations.ts`.

- `reserve(orderId, lines)` creates one reservation per line inside the order's transaction and fails the whole
  order if any line can't be reserved.
- A reservation has a `status` of `held`, `committed` or `released`, and an `expires_at` timestamp. Held
  reservations count against available stock.
- `commit(orderId)` runs when payment succeeds and turns held reservations into committed ones.
- `release(orderId, reason)` returns stock when an order is cancelled.
- Held reservations that pass `expires_at` must be released by a job; until that job exists they are released
  manually by support using the runbook in `docs/operations.md`.
- The default hold time is 15 minutes and comes from `config.inventory.reservationTtlMinutes`.

### Warehouse adapters

`src/inventory/warehouses/` contains one adapter per warehouse partner. Adapters implement
`WarehouseAdapter` (`submitShipment`, `cancelShipment`, `fetchStatus`) and must be idempotent: every call carries
the order ID as an idempotency key.

## Payments module

`src/payments/gateway.ts` wraps the payments provider SDK behind `PaymentsGateway`. Only this module talks to the
provider. Webhooks arrive at `POST /payments/webhook`, are verified with the provider signature, stored in
`payment_events`, and then processed idempotently.

- Amounts are passed to the provider in minor units exactly as computed by pricing.
- Refunds are created only through `refund(orderId, amount, reason)` and always write an audit event.
- Reconciliation (`src/jobs/payment-reconciliation.ts`) compares provider payouts with `payment_events` daily.

## Notifications module

Templates live in `src/notifications/templates/` as MJML plus a small text fallback. Providers (email and SMS)
are adapters behind `Notifier`. Delivery attempts are recorded in `notification_deliveries` with the provider
message ID. Notifications are sent from the outbox processor, never from request handlers.

- Customer-facing text uses `formatOrderNumber()` and `formatMoney()`.
- Failed deliveries retry with exponential backoff up to five times, then alert.

## Auth module

`src/auth/` implements customer sessions (signed, HTTP-only cookies) and API keys for partners and admins.
Permission checks go through `can(principal, action, resource)`; handlers never compare roles directly.

## Jobs runner

`src/jobs/runner.ts` is a small scheduler that runs registered jobs on an interval with a Redis lock per job so
only one instance runs a job at a time. Jobs are registered in `src/jobs/index.ts`.

- A job is a module exporting `{ name, intervalSeconds, run(deps) }`.
- `run` must be idempotent and safe to interrupt; it processes work in batches of at most 500 rows and commits
  each batch in its own transaction.
- Jobs log a summary line per run (`job=<name> processed=<n> duration_ms=<n>`) and emit the
  `jobs_run_duration_seconds` histogram.
- Existing jobs: `outbox-processor`, `payment-reconciliation`, `reporting-export`.

## Database

Migrations live in `src/db/migrations/` and run with `npm run migrate`. Every migration is forward-only and must
be safe to run while the previous release is serving traffic (expand/contract). Query helpers in
`src/db/query.ts` enforce parameterised queries; string-built SQL is rejected in review.

### Transactions

`withTransaction(fn)` in `src/db/tx.ts` runs `fn` in a serializable transaction with automatic retry on
serialization failures (three attempts). Long-running work must not hold a transaction open across network calls.

## Configuration

`src/config/index.ts` loads configuration from environment variables once at start-up, validates it with a
schema and exposes a typed, frozen object. Adding a setting means adding it to the schema, to
`.env.example` and to the deployment manifest.

## Observability

Logging uses pino with the request ID bound to every log line. Metrics use prom-client and are served on a
separate port. Tracing uses OpenTelemetry with the HTTP and PostgreSQL instrumentations. Never log full card
details, addresses or tokens; the logger redacts known fields but new sensitive fields must be added to its
redaction list.

## Testing strategy

- Unit tests sit in `test/unit/` and cover pure logic (pricing, formatting, state machine).
- Integration tests in `test/integration/` run against a disposable PostgreSQL started by the test harness.
- Route tests build the Fastify app with fake dependencies.
- `npm test` runs everything with Vitest in verbose mode; CI also runs `npm run lint` and `npm run typecheck`.
- New jobs need an integration test that runs `run()` twice to prove idempotency.
