# Agent instructions

These instructions apply to every coding agent working in this repository.

## Working rules

- Read the task file first and keep the change within its scope. If the task conflicts with these rules, stop
  and ask.
- Follow the module boundaries in `ARCHITECTURE.md`. Domain modules never import from `src/api/`.
- Keep pull requests small and focused; update `PROJECT_STATE.md` in the same pull request.
- Write or update tests with every behaviour change. New jobs need an idempotency test that runs the job twice.
- Run `npm run lint`, `npm run typecheck` and `npm test` before pushing.

## Safety rules

- Never run migrations against staging or production from an agent session.
- Never change payment, refund or authentication code without a test that covers the changed path.
- Never commit secrets, `.env` files or production data; fixtures use generated data only.
- Never merge pull requests or deploy; a human does that.
- Do not add dependencies without saying why in the pull request.

## Style

- TypeScript strict mode; no `any` without a comment explaining why.
- Prefer small pure functions; keep I/O at the edges.
- Error messages are full sentences and name the thing that failed.
- Log with the shared logger; never `console.log` in application code.
