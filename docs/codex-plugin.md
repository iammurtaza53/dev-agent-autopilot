# Autopilot and the official Codex plugin for Claude Code

OpenAI publishes an official Claude Code plugin, [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc), that lets you use Codex from inside Claude Code: `/codex:review`, `/codex:adversarial-review`, `/codex:rescue`, `/codex:status`, `/codex:result`, `/codex:cancel`, `/codex:transfer` and `/codex:setup`. This page records how Dev Agent Autopilot v0.4 works with it and why.

## Decision (v0.4)

**The official plugin is a supported companion for reviews you start yourself. Autopilot's unattended planner and reviewer stay on the native Codex CLI.**

| Job | Who does it in v0.4 | Why |
| --- | --- | --- |
| Planning | Native `codex exec --sandbox read-only` | The plugin has no read-only planning interface that an unattended session can call. |
| Automated review loop | Native `codex review --base <baseBranch>`, at most `reviewer.maxRounds` rounds | The plugin's review commands are user-invoked only (see below). |
| Manual and challenge reviews | The official plugin: `/codex:review --base main`, `/codex:adversarial-review --base main <focus>` | These are the plugin's documented, user-invoked surfaces. |
| Checking and installing the plugin | `dev-autopilot doctor`, `dev-autopilot install-reviewer [--install-plugin]` | These use Claude Code's documented `claude plugin` CLI only. |
| Inside Autopilot's background sessions | The plugin is switched off for that session | This prevents a second, unbounded review loop and stops Codex from writing code. |

## Evidence

Checked against `openai/codex-plugin-cc` at commit `db52e28` (plugin 1.0.6), Claude Code 2.1.283 and Codex CLI 0.157.1.

1. **The review commands can't be called by the model.** `/codex:review`, `/codex:adversarial-review`, `/codex:status`, `/codex:result`, `/codex:cancel` and `/codex:transfer` all declare `disable-model-invocation: true`. Claude Code documents this as "Only you can invoke the skill". An Autopilot session is a model working unattended, so it can't run them.
2. **The only other entry point is private.** Each command runs the plugin's internal `scripts/codex-companion.mjs`. That script isn't a documented interface, and Autopilot doesn't call plugin files by path.
3. **Launching the command headlessly doesn't make it an unattended reviewer.** Claude Code documents that `claude -p "/codex:review --wait --base main"` expands a user-invoked command. We ran it: the command ran, but `claude -p` exited `0` even though the review failed, and the reply was paraphrased by the model despite the command's "return verbatim" instruction. To use this from inside Autopilot's session, the session would have to launch a nested Claude process itself. That is a model-triggered invocation of a command whose author disabled model invocation, and it would also require allowing `claude` in the session's Bash allow-list. Neither is acceptable.
4. **The plugin can hand work to Codex with write access.** Its `codex:codex-rescue` subagent and `/codex:rescue` command can be invoked by the model, and the subagent adds `--write` by default. That contradicts Autopilot's rule that Codex plans and reviews but never edits.
5. **The plugin's Stop-time review gate is a second review controller.** When enabled with `/codex:setup --enable-review-gate`, its `Stop` hook runs a Codex review each time Claude finishes a turn and can block the stop. It doesn't check `stop_hook_active`, so only Claude Code's cap of 8 consecutive stop-hook continuations bounds it. The plugin's README warns that it "may drain usage limits quickly". Whether the gate is on is kept in the plugin's private state, and there is no supported command to read it.

## What Autopilot does about it

- **Plugin off inside Autopilot sessions (default).** The per-session settings that `dev-autopilot run` passes with `claude --bg --settings` include `"enabledPlugins": {"codex@openai-codex": false}`. Claude Code documents that `enabledPlugins` merges key by key and that the `--settings` (flag) source outranks user, project and local settings. So this turns the plugin off for that background session only: no files are changed, and your interactive Claude Code sessions keep the plugin.
  - What we tested: a session-only test plugin whose SessionStart hook writes a marker file, run with `claude -p`. Its hook fired without the override and did not fire with `--settings '{"enabledPlugins":{"ap-marker@inline":false}}'`.
  - What we could not test: the same check in a `claude --bg` session. `--plugin-dir` plugins didn't run their hooks there even without an override, so the baseline wasn't usable.
  - What we did confirm for background sessions: they receive Autopilot's `--settings`. The v0.4 end-to-end background session ran under the `dontAsk` allow-list from that file.
- **Defence in depth.** The same settings always deny `Agent(codex:codex-rescue)`, `Skill(codex:rescue)` and `Skill(codex:setup)`. We verified each rule against the real plugin, loaded session-only with `--plugin-dir`. Claude Code blocked the subagent ("The permission rule `Agent(codex:codex-rescue)` in flagSettings blocked the call") and the skill ("Skill execution blocked by permission rules").
- **Opt-in.** `"codexPlugin": { "loadInAutopilotSessions": true }` leaves the plugin as your Claude Code settings have it. The deny rules still apply. `dev-autopilot doctor` and `run` warn that a review gate you enabled with `/codex:setup` would then run alongside `reviewer.maxRounds`. Autopilot never enables the gate itself.
- **No fake backend.** `reviewer.transport` accepts only `"codex-cli"`. Setting it to a plugin value fails with an explanation instead of silently falling back.
- **Codex failures are blockers.** If a Codex plan or review command fails (not signed in, out of usage or credits, network), the rule tells Claude to stop and report it. Claude may not substitute its own review.

## Using the plugin alongside Autopilot

1. Install it once, from Claude Code:

   ```text
   /plugin marketplace add openai/codex-plugin-cc
   /plugin install codex@openai-codex
   /reload-plugins
   /codex:setup
   ```

   Or from a terminal: `dev-autopilot install-reviewer --install-plugin`. It asks before changing anything and runs `claude plugin marketplace add openai/codex-plugin-cc` and `claude plugin install codex@openai-codex`. Then run `/codex:setup` in Claude Code.
2. Leave the review gate off in projects that use Autopilot. Autopilot already runs a bounded review loop.
3. When Autopilot's pull request is ready, get a second opinion from Claude Code on the PR branch:

   ```text
   /codex:adversarial-review --base main challenge the design and failure modes
   ```

## Revisit when

This decision should change if OpenAI ships a documented review or planning interface that a model or script is allowed to call unattended, with a machine-readable result. Examples would be a model-invocable read-only review skill or a supported companion CLI. `reviewer.transport` is the place to add it.
