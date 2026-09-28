# Changelog

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
