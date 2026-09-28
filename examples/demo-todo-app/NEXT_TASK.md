# Next task: filtering, removal and a summary

Extend the todo list in `src/todos.js`.

## What to build

1. `list({ status })` filters by status: `'all'` (default), `'open'` or `'done'`.
   An unknown status throws `Error('Unknown status: <value>')`.
2. `remove(id)` deletes a todo and returns the removed item.
   An unknown id throws the same "not found" error as `complete`.
3. `summary()` returns `{ total, open, done }`.

## Acceptance criteria

- Existing behaviour and tests keep working; `list()` with no argument still returns everything.
- Every new function and error path has a test in `test/todos.test.js`.
- `npm test` passes.
- No new dependencies.

## Out of scope

- Persistence, a CLI or an HTTP API.
