# Acme Orders

Order-management service (Node.js 22, TypeScript, Fastify, PostgreSQL). See `ARCHITECTURE.md` for modules and
`AGENTS.md` for agent rules.

- Install: `npm ci`. Local services: `docker compose up -d`.
- Checks: `npm run lint`, `npm run typecheck`, `npm test`.
- Tests use Vitest; integration tests need the Compose services running.
- Money is integer minor units; format only with `formatMoney()`.
- Never log tokens, card data or addresses.
