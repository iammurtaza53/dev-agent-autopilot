# Task: release expired inventory reservations automatically

Phase 5 item 1, decision D12. Held reservations that pass `expires_at` are released by hand today. Add a job that
releases them.

## What to build

1. `findExpiredReservations(now, limit)` in `src/inventory/reservations.ts`: held reservations whose
   `expires_at` is before `now`, oldest first, at most `limit` rows.
2. A `reservation-expiry` job in `src/jobs/reservation-expiry.ts` that runs every 60 seconds, processes at most 500
   reservations per batch, and releases each order's expired reservations with `release(orderId, 'expired')`.
3. Register the job in `src/jobs/index.ts`.
4. Log the standard job summary line and emit `jobs_run_duration_seconds`.
5. Update the manual runbook in `docs/operations.md` to mention the job.

## Acceptance criteria

- An integration test runs the job twice and proves the second run changes nothing.
- A unit test covers `findExpiredReservations` ordering and the limit.
- `npm run lint`, `npm run typecheck` and `npm test` pass.

## Out of scope

- Cancelling orders whose reservations all expired (next task).
- Customer notifications about expired reservations.
