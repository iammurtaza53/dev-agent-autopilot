# Task: consistent order numbers in the orders API

Phase 5 item 2, decision D13. `GET /orders/:id` and `GET /orders` in `src/api/routes/orders.ts` build the
customer-facing order number by hand. Use `formatOrderNumber()` from `src/orders/format.ts` instead.

## Acceptance criteria

- Both endpoints return order numbers such as `AC-2026-000123`.
- The route tests in `test/api/orders.test.ts` cover both endpoints.
- No other behaviour changes.
