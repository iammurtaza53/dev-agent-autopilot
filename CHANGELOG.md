# Changelog

## 0.4.0: official Codex plugin support and workflow hardening

OpenAI now publishes an official Codex plugin for Claude Code ([openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)). v0.4 supports it as a companion for reviews you start yourself, and keeps the native Codex CLI as Autopilot's unattended planner and reviewer. The reasons and the evidence are in [docs/codex-plugin.md](docs/codex-plugin.md): the plugin's review commands are user-invoked only (`disable-model-invocation: true`), and it has no other supported interface for unattended use.

- **The plugin is switched off inside Autopilot sessions.** Session settings now include `"enabledPlugins": {"codex@openai-codex": false}`. The plugin's optional Stop-time review gate therefore can't run a second, unbounded review loop next to `reviewer.maxRounds`. Only the Autopilot session is affected; your own Claude Code sessions and settings files are untouched. Opt in with `"codexPlugin": { "loadInAutopilotSessions": true }`, and doctor and `run` then warn about the review gate.
- **Codex stays read-only.** Sessions always deny the plugin's `codex:codex-rescue` subagent (write access by default), `/codex:rescue` and `/codex:setup`.
- **`doctor`** now reports the Codex login (`codex login status`, exit code only), the automated reviewer (backend, command, round limit) and config problems. It also reports the official plugin: installed, enabled, version and role, found with the documented `claude plugin list --json`, or "detection unavailable" if that fails. A missing plugin never fails doctor. The plugin's review-gate state has no supported read command, so doctor says so instead of reading private files.
- **`install-reviewer`** also checks your Codex login and looks for the plugin. By default it only prints the official install steps. The new `--install-plugin` flag runs `claude plugin marketplace add openai/codex-plugin-cc` and `claude plugin install codex@openai-codex`, but only in an interactive terminal and after you answer yes. It never enables the review gate.
- **Config validation.** `run` and `doctor` now reject an unsupported `reviewer.transport` or `planner.transport` (including plugin values, with an explanation), a `reviewer.maxRounds` that isn't a whole number of 1 or more, and a non-boolean `codexPlugin.loadInAutopilotSessions`. There is no config schema bump: existing v0.3.x configs are valid unchanged.
- **Codex failures are blockers.** The Claude rule now says: if `codex exec` or `codex review` fails (login, usage or credits, network), retry once, then stop and report the error. Claude must never substitute its own review. The launch prompt names the reviewer command, base branch and round limit, and the PR description gains a "Review (Codex)" summary.
- **Session ids.** `attach`, `logs`, `stop` and `resume` accept the short `id`, the full `sessionId` or the session name, and pass Claude the short id. If nothing matches, or the match is an interactive session, the error explains which value to use.
- **Stale sessions.** `status` now lists background sessions with an `autopilot` label (`active`, `current` or `stale`, plus owned and useId), counts interactive sessions separately and explains the ids. The new `cleanup` command lists finished Autopilot sessions from earlier tasks. `cleanup --apply` removes them with a plain `claude rm <id>`, which keeps transcripts and refuses to delete worktrees with uncommitted changes or unpushed commits. Autopilot never passes override flags or runs git cleanup itself.
  - A session counts as Autopilot's only if it has the exact generated name (`<prefix>-<first 6 hex digits of the task hash>`) or is the recorded last session.
  - The current task's session is recognised by that name even if `.autopilot/runtime/` was lost.
  - Without a task file, nothing is removed. `run` also uses the name to find the current task's session.
- `run` refreshes the session settings before respawning a stopped session, so resumed sessions get the new permissions.
- `upgrade` switches the reviewer transport of v0.2.0-era configs (the removed MCP bridge) to `codex-cli`. Otherwise it leaves the config byte-for-byte unchanged, and it stays idempotent.
- Fixed: the project filter for `claude agents` sessions matched sibling folders that share a prefix (for example `app` and `app2`).
- Fixed: unknown command-line flags are now rejected instead of being ignored. Expected errors print just their message; set `DEV_AUTOPILOT_DEBUG=1` to see the stack trace.
- Tests: a fake `claude`/`codex`/`gh` runner covers doctor, run, install-reviewer, id resolution, status, cleanup and v0.3.1 upgrades. A tracked-file privacy test checks that no runtime state, credentials, tokens or personal email addresses are committed.

## 0.3.1

Maintenance release from the first real end-to-end v0.3 demo run.

- `init`, `upgrade` and `migrate-v1` now add `.claude/worktrees/` to the project `.gitignore`, next to `.autopilot/runtime/`. Claude Code background sessions create their Git worktrees there. Before this fix the folder showed up as untracked content, and that also made the next `dev-autopilot run` refuse to start on a "dirty" tree. Run `dev-autopilot upgrade` in existing projects to add the entry.
- Only `.claude/worktrees/` is ignored, never all of `.claude/`, so the committed `.claude/rules/dev-autopilot.md` stays tracked.
- `.gitignore` updates keep existing content, skip entries that are already present (including `/dir/` and `dir` spellings) and leave an up-to-date file untouched.
- Docs: the merge guidance now uses `gh pr merge <number> --merge --repo OWNER/REPO` without `--delete-branch`, because the PR branch may still be checked out in a Claude session's worktree. Local branch/worktree cleanup is covered separately in the FAQ. Autopilot still never merges.

## 0.3.0 (first public release)

- **Codex as architect.** New `planner` config section (on by default for new projects): before writing code, Claude asks Codex for an architecture and implementation plan with `codex exec --sandbox read-only`, then summarizes it in the PR. Set `planner.enabled` to `false` to opt out. Projects without a `planner` section keep the previous behaviour.
- New `dev-autopilot upgrade` command: refreshes `.claude/rules/dev-autopilot.md` and adds new config sections (such as `planner`) to existing projects.
- New `--version` flag. The CLI, Claude rule and help text now read the version from `package.json`, so they can't drift apart.
- `doctor`, `run` and `install-reviewer` now also check `codex exec` when the planner is enabled.
- The deny list now also blocks `bun`/`cargo publish`, NuGet push, Maven deploy and Gradle publish.
- Removed the project-specific `--preset` option. `init` now creates the same generic config for every project.
- Added a runnable demo project (`examples/demo-todo-app`), MIT license, CI on Windows/macOS/Linux, and contributing and security guides.

## 0.2.2

- Fix first-run native Claude session initialization when runtime state does not yet exist.
- `readJson()` now uses a sentinel for "no fallback", so an explicit `null` fallback is returned for a missing file instead of rethrowing `ENOENT`. A missing `.autopilot/runtime/last-session.json` now means "no prior Claude session".
- Added regression tests for `readJson()` fallback semantics and first-run runtime-state initialization.

## 0.2.1

- Removed the `codex mcp-server` reviewer bridge because current Codex/Windows builds can fail the stdio MCP initialize handshake.
- Claude remains the native background-session orchestrator.
- Independent review now uses the stable native `codex review --base <branch>` CLI path.
- No Claude or Codex model names are pinned.
- `install-reviewer` now verifies `codex review` availability; it does not alter Claude MCP configuration.

## 0.2.0

- Replaced the custom Claude/Codex orchestration loop with Claude Code native background sessions.
- Added native `claude agents` status/monitoring integration.
- Added automatic session respawn for unchanged tasks after stopped/failed native sessions.
- Added one-time user-scoped Codex MCP reviewer registration using `codex mcp-server`.
- Codex is reviewer-only with read-only/never guidance in the project rule.
- Removed all Claude/Codex model pinning.
- Added v0.1 project migration with local backup of old state/config.
- Added project-level Claude rule rather than giant transported prompts.
- Kept human merge/production gates.
