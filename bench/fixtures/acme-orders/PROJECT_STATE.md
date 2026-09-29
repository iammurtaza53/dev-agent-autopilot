# Project state

Last updated at the end of phase 4. This file is the running log of what has shipped, what is in progress, and
what is planned. Update it in the same pull request as the work it describes.

## Current focus

Phase 5: operational hardening. The storefront team wants fewer support tickets about stock that looks
available but can't be bought, and finance wants reconciliation reports without manual steps.

## Phase 1: foundations (done)

- Repository, CI (lint, typecheck, tests) and container build.
- Fastify server with request IDs, CORS and structured logging.
- PostgreSQL connection pool, migrations tooling and the transaction helper.
- Typed configuration with schema validation and `.env.example`.
- Health and readiness endpoints for the orchestrator.
- First version of the order aggregate with draft and pending_payment states.

Notes: the original plan used an ORM; it was dropped in favour of query helpers after the spike showed it hid
transaction boundaries (see the decision log). Migration tooling was switched from a hosted service to plain SQL
files in the repository during this phase.

## Phase 2: checkout (done)

- Pricing in integer minor units with discounts and tax.
- Inventory stock levels per SKU and warehouse.
- Reservations created at checkout inside the order transaction.
- Payments gateway adapter with card payments and 3-D Secure.
- Webhook endpoint with signature verification and idempotent processing.
- Order state machine extended with paid, cancelled and refunds.

Notes: checkout latency p95 was 480 ms at the end of the phase, mostly spent in the payments gateway. We agreed
not to optimise further until the gateway's regional endpoint is available.

## Phase 3: fulfilment (done)

- Warehouse adapter interface and the first two partner adapters.
- Outbox table and processor for reliable hand-off to warehouses.
- Shipping status polling and the shipped/delivered transitions.
- Customer notifications for order confirmation, shipment and delivery.
- Admin routes for support: order lookup, manual cancel, resend notification.

Notes: one warehouse partner rate-limits aggressively; its adapter uses a token bucket with a limit of two
requests per second. Keep that when refactoring.

## Phase 4: reporting and partners (done)

- Daily reporting export to the finance bucket (CSV, one file per day).
- Partner API keys with scopes and per-key rate limits.
- Partner order creation endpoint with idempotency keys.
- Audit events for every admin write and every refund.
- Payment reconciliation job comparing payouts to payment events.

Notes: the reporting export originally ran inside a request; it moved to the jobs runner once exports exceeded
30 seconds. The export format is agreed with finance and must not change without notice.

## Phase 5: operational hardening (in progress)

Planned work, roughly in order:

1. Release expired inventory reservations automatically. Today support releases them by hand when customers
   report "out of stock" for items that are in the warehouse. The job must respect the batch and idempotency
   rules for jobs and emit the standard job metrics.
2. Order number formatting: customer emails show inconsistent order numbers between templates. Consolidate on
   `formatOrderNumber()` everywhere.
3. Alerting on repeated notification delivery failures per provider.
4. Reconciliation report emailed to finance when mismatches are found.
5. Runbook updates for the new job and alerts.

Open questions:

- Should expired reservations notify the customer? Product says no for now; revisit after a month of data.
- Should the expiry job also release reservations of orders stuck in pending_payment for more than a day?
  Current answer: yes, but only after checking the payment status with the gateway.

## Phase 6: multi-currency (planned)

- Price lists per currency and per market.
- Currency conversion at checkout using daily rates.
- Reporting in the settlement currency.
- Tax rules per market.

Nothing started. Depends on the payments provider enabling multi-currency settlement for our account.

## Known issues

- The shipping status poller occasionally double-sends the shipped notification when a warehouse reports the
  same status twice within a minute. A fix is planned alongside the alerting work.
- Admin order search is slow on customers with more than 5,000 orders; needs an index on
  `(customer_id, created_at)`.
- Integration tests take about four minutes locally; most of that is PostgreSQL start-up.
- The reporting export does not yet handle daylight-saving transitions correctly for markets outside UTC.

## Release history

| Version | Date | Highlights |
| --- | --- | --- |
| 0.1.0 | Phase 1 | Foundations, health checks |
| 0.2.0 | Phase 2 | Checkout, payments, reservations |
| 0.3.0 | Phase 3 | Fulfilment, notifications, admin |
| 0.4.0 | Phase 4 | Reporting, partner API, audit |
| 0.4.1 | Phase 4 | Hotfix: webhook retries on gateway timeouts |
| 0.4.2 | Phase 4 | Hotfix: partner rate limits per key |

## Team agreements

- Pull requests stay small: one phase item per PR where possible.
- Every PR updates this file and, when module boundaries change, `ARCHITECTURE.md`.
- Decisions that affect more than one module get an entry in `DECISIONS.md`.
- Nobody merges their own PR; a second reviewer approves.
- Production deploys happen from main after CI is green, during working hours only.

## Metrics we watch

- Checkout success rate (target above 97 percent excluding card declines).
- p95 latency of `POST /orders` (target below 600 ms).
- Reservations held longer than their TTL (target zero once the expiry job ships).
- Notification delivery failure rate per provider (alert above 2 percent over 15 minutes).
- Reconciliation mismatches per day (target zero; any mismatch pages finance on-call).

## Environments

- `local`: Docker Compose with PostgreSQL and Redis; seed data from `npm run seed`.
- `staging`: deployed on every merge to main; uses the payments provider sandbox.
- `production`: deployed manually from a tagged release after staging verification.

Staging data is reset weekly. Never copy production data to staging.
