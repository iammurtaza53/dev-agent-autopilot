# Contributing

Thanks for helping. Bug reports, docs fixes and features are all welcome.

## Set up

```bash
git clone https://github.com/<you>/dev-agent-autopilot.git
cd dev-agent-autopilot
npm install
npm link          # makes your local copy the global `dev-autopilot`
```

## Before you open a pull request

```bash
npm run lint
npm test
npm run bench     # LeanLoop benchmark; test/benchmark.test.js also runs it
```

If you change the launch flow (`run`, `status`, `resume`, the Claude rule), please also try it on a real project, such as the [demo project](examples/demo-todo-app), and say what you saw in the PR.

## Guidelines

- **Keep the launcher thin.** Autopilot delegates to Claude Code and Codex rather than rebuilding what they already do. Prefer changing the rule text or config over adding a new runtime loop.
- **No model IDs.** Don't pin or pass model names to Claude or Codex.
- **Safety stays on by default.** New defaults must not weaken the deny list or the human gates.
- **Dependencies:** avoid new ones unless there's a clear reason.
- **Tests:** add a `node:test` test in `test/` for any behaviour change.
- **Changelog:** add a line to `CHANGELOG.md` under an "Unreleased" heading.
