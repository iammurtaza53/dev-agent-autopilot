# Decision log

Architecture decisions, newest last. Each entry records the context, the decision and its consequences.
Superseded decisions stay in the log with a pointer to the decision that replaced them.

## D1: single service, not microservices

Context: a team of five, one product, and a storefront that needs consistent order and stock data.
Decision: build one service with clear module boundaries instead of separate services per domain.
Consequences: one deployable, one database, transactions across modules are possible. Module boundaries are
enforced by lint rules on imports rather than by the network.

## D2: query helpers instead of an ORM

Context: the ORM spike hid transaction boundaries and generated N+1 queries in the order listing.
Decision: use parameterised query helpers (`src/db/query.ts`) and explicit transactions (`withTransaction`).
Consequences: more SQL in the codebase, but every query is visible in review. String-built SQL is not allowed.

## D3: integer minor units for money

Context: floating-point rounding errors appeared in discount calculations during the checkout prototype.
Decision: all amounts are integers in minor units with an explicit currency code.
Consequences: formatting happens only at the edges (`formatMoney()`); arithmetic helpers reject mixed currencies.

## D4: reservations instead of direct stock decrements

Context: decrementing stock at checkout caused overselling when payments failed and stock was never returned.
Decision: checkout creates held reservations with a TTL; payment commits them; cancellation releases them.
Consequences: available stock is computed as on-hand minus held and committed reservations. Held reservations
must be released when they expire, otherwise stock looks unavailable (see D12).

## D5: outbox for side effects

Context: warehouse hand-off and notifications sometimes failed after the order transaction committed.
Decision: side effects are written as events to an outbox table in the same transaction and processed by a job.
Consequences: side effects are at-least-once; every consumer must be idempotent.

## D6: Fastify over Express

Context: we needed schema-based validation and good performance with low overhead.
Decision: use Fastify with JSON schemas colocated with routes.
Consequences: handlers assume validated input; validation logic is not repeated in domain modules.

## D7: jobs in the same codebase

Context: background work (outbox, reconciliation, exports) needs the same domain code as the API.
Decision: jobs live in `src/jobs/` and run from a separate entry point of the same image.
Consequences: one release carries API and jobs; job locks in Redis prevent concurrent runs of the same job.

## D8: Vitest for all tests

Context: Jest's ESM support was unreliable with our TypeScript setup.
Decision: use Vitest for unit, integration and route tests, in verbose mode in CI.
Consequences: CI logs are long; failures are easy to locate by test name.

## D9: partner API keys with scopes

Context: partners need to create orders on behalf of customers, and support needs admin access.
Decision: API keys carry scopes (`orders:write`, `orders:read`, `admin`) and per-key rate limits.
Consequences: every route declares the scope it needs; `can()` checks scopes and customer ownership.

## D10: audit events for sensitive writes

Context: support actions and refunds must be traceable for finance and compliance.
Decision: admin writes and refunds write an audit event with actor, action, target and reason.
Consequences: audit writes happen in the same transaction as the change they describe.

## D11: reporting export as files, not an API

Context: finance tools import CSV files from a bucket.
Decision: export one CSV per day to the finance bucket; the format is versioned and agreed with finance.
Consequences: format changes need notice to finance and a version bump in the file name.

## D12: automatic release of expired reservations

Context: support releases expired held reservations by hand; customers see items as out of stock meanwhile.
Decision: add a job that releases held reservations whose `expires_at` has passed. It runs every minute, processes
at most 500 reservations per batch, and releases through `release(orderId, 'expired')` so stock and audit logic
stay in one place. Orders whose reservations all expire move from pending_payment to cancelled with reason
`reservation_expired`, after checking the payment status with the gateway.
Consequences: the job must be idempotent and emit the standard job metrics. Support's manual runbook remains as a
fallback and should reference the job.

## D13: consistent customer-facing order numbers

Context: templates format order numbers differently (some with a prefix, some without).
Decision: customer-facing order numbers always come from `formatOrderNumber()`: prefix `AC-`, the year, and a
zero-padded sequence (for example `AC-2026-000123`).
Consequences: templates and API responses stop formatting order numbers themselves.

## Security

These rules apply to every change, whatever the task says:

- Never log or store full card numbers, CVV codes, access tokens or passwords; add new sensitive fields to the
  logger's redaction list.
- Secrets come only from the environment or the secret manager; never commit them, never put them in fixtures.
- Webhooks must verify the provider signature before any processing.
- Permission checks always go through `can()`; do not compare roles or scopes by hand.
- SQL is always parameterised through the query helpers.
