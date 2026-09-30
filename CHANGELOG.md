# Changelog

## 0.4.2: HostLatch trust-handoff gate

- **Optional trust gate** (`trustGate`, off by default). It runs [HostLatch](https://github.com/iammurtaza53/hostlatch) on the task branch. HostLatch finds agent-written changes that a trusted host could later execute with the developer's authority: package lifecycle scripts, IDE tasks, agent hooks and settings, MCP commands, CI workflows, Git attributes and dev containers. Autopilot runs HostLatch as an external command and only reads its JSON manifest.
  - `dev-autopilot check` ends with a HostLatch scan. The output shows the decision, risk score, findings (rule, path, title; evidence stays in the stored manifest) and manifest path. `failOn` (`block` or `review`) decides what fails the check, and `check --only trust` runs just the scan.
  - If the gate is on and HostLatch can't run, the check fails rather than passing silently. `doctor` reports the gate and fails if HostLatch is missing.
  - A HostLatch finding makes the change high-risk for the adaptive Codex review, so it gets `reviewer.maxRounds`.
  - The Claude rule says what to do with a finding: remove a change the task doesn't need, list a needed one under "Trust handoff (HostLatch)" in the PR, treat a `block` as a human gate, and never rewrite or hide a change to pass the scan.
  - The Context Capsule's settings block, `status` and the task state show the gate and its last decision.
  - `trustGate.command` can be `hostlatch` (global install), an npx command (`npx --yes github:iammurtaza53/hostlatch#v0.2.0`) or `node "<path>/bin/hostlatch.js"`. It is split without a shell.
- **Install without cloning.** The README documents `npx --yes github:iammurtaza53/dev-agent-autopilot#v0.4.2` and `npm install -g github:iammurtaza53/dev-agent-autopilot#v0.4.2`. Nothing is published to the npm registry.
- The README lists HostLatch as a companion project.
- The rule's trust-gate section adds 0.5 KB of project memory. The benchmark total is now 281.1 KB → 65.7 KB (still 77% less); [bench/README.md](bench/README.md) has the updated figures.
- Tests: 15 new tests for the gate, using a fake HostLatch; verified by hand against the real HostLatch 0.2.0 CLI.

## 0.4.1: LeanLoop, token-efficient orchestration

**LeanLoop: send evidence, not history.** v0.4.1 cuts the context and output Autopilot puts in front of Claude Code and Codex, without weakening checks, reviews or safety rules. Nothing in LeanLoop calls a model. It works with hashes, Markdown sections, git diffs and exit codes, and the repository stays the source of truth. The details are in [docs/leanloop.md](docs/leanloop.md).

- **Context Capsule.** `run` no longer asks Claude to read every context file. It builds one capsule per task, without an LLM, and points Claude at it. The capsule contains:
  - the task verbatim;
  - the settings Claude needs, with `safety.humanGates` verbatim;
  - instruction files (`AGENTS.md`) in full;
  - every section under a safety heading;
  - configured `alwaysInclude` entries and `<!-- autopilot:always -->` blocks;
  - the sections that the task's paths, identifiers, called names and numbered references point to.

  Every excerpt is exact text with its path, lines and sha256. The rest is indexed by line range. `CLAUDE.md` and the Autopilot rule, which Claude Code already loads as project memory, are referenced by hash instead of repeated. Credential-named and git-ignored files are never processed, and sections containing credential-like values are withheld.
- **Context cache.** Section maps are cached by content hash. The capsule is reused only while every source hash (including every `.claude/rules/` file), the options and the Autopilot version are unchanged.
- **Delta Resume.** `run` and `resume` continue a stopped or failed session of the current task with `claude --bg --resume <sessionId>` (verified on Claude Code 2.1.284) instead of `claude respawn`. The message says:
  - the context is unchanged, so don't reread it;
  - or here is a delta with only the changed sections;
  - or, when Autopilot has no record of what the session read, read the capsule.

  A changed task file is still a new task. An idle finished session is stopped first so it continues under its own id. Older Claude Code falls back to `respawn`.
- **Quiet Checks.** New `dev-autopilot check` runs the configured checks sequentially, stores full logs under `.autopilot/runtime/checks/`, and prints a PASS line per check, or FAIL with the exit code, the log path and a bounded, ANSI-free, redacted excerpt. `--log <check>` prints a stored log. A pass is reused for an unchanged tree; `--force` reruns. On POSIX a check runs in its own process group, so a timeout stops the whole command.
- **Adaptive Codex review.** New `dev-autopilot codex review` runs the native `codex review --base <branch>` under a budget taken from the git diff:
  - docs-only: 0 rounds (skipped);
  - small low-risk: 1 round;
  - other changes: 2 rounds;
  - high-risk (security/auth, payments, migrations, secrets, release/deploy, dependencies, CI, build config, agent instructions, or changed lines with sensitive keywords): `reviewer.maxRounds`.

  `reviewer.maxRounds` stays the strict cap, a clean round ends the loop, a budget never shrinks within a task, and failed runs don't count as rounds. Everything is configurable under `reviewer.adaptive`; code changes can't be set to 0 rounds. `dev-autopilot review-budget` explains the budget.
- **Planning economy.** New `dev-autopilot codex plan` runs `codex exec --sandbox read-only` only when `planner.enabled` is `true`, and saves the plan per task and context so equivalent planning never runs twice. Configured Codex commands are checked: they must stay native and read-only, with no `--model`, no model config override and no sandbox bypass.
- **Compact task state.** `.autopilot/runtime/task-state.json` records the task, session, branch, base, context fingerprint, checks, review budget, PR, CI, blocker and any quota wait. It never holds prompts or transcripts. Claude records facts with `dev-autopilot state`; `status` shows a short `task` summary.
- **Quota resume tickets (opt-in, `quota.autoResume`, default off).**
  - Failures are classified from the output of Autopilot's own Codex commands and of a failed Claude session's log: quota, rate limit, auth, network, refusal or usage error.
  - A reset time is used only when the output states one explicitly: ISO time with a zone, epoch, relative time, or clock time with a zone. Anything else is rejected as ambiguous.
  - With a stated reset, a ticket and a detached helper resume the session at reset + `graceMinutes` (default 2). Before resuming, it re-checks the project, task hash, task status, session and other active sessions.
  - `stop` cancels a ticket; a changed task cancels it on the next command; `status` shows `waiting-quota — resume scheduled …`; after a reboot the next command re-arms the helper.
  - Without a stated reset time the task stops with "quota exhausted; reset time unavailable for automatic scheduling".
  - It never guesses reset times, buys credits or uses banked resets.
- **Efficiency report.** New `dev-autopilot efficiency [--json] [--task]` reports local bytes: context against capsule, check logs against output shown, Codex transcripts against text shown, review rounds skipped, plans reused, resumes and duplicate starts avoided. Token figures are labelled estimates at 4 bytes per token. Nothing leaves the machine.
- **Subagent and chat discipline.** The Claude rule now says to:
  - work directly;
  - not spawn subagents to read files, run checks, summarize documents or review work;
  - use at most 2 concurrent subagents unless the task needs more;
  - prefer targeted reads;
  - not paste passing logs;
  - keep durable state in Git, the PR or docs.

  The rule is also tighter overall (6.8 KB).
- **Benchmark.** `npm run bench` and `test/benchmark.test.js` compare v0.4.0's exact launch prompt and rule with LeanLoop on deterministic fixtures, running the real v0.4.1 code. Agent-facing text: 281.1 KB → 64.1 KB (77% less); Codex calls 8 → 6; all 21 required-information checks pass. Without check output, the reduction is 39%. These are orchestration-layer bytes, not provider-billed tokens. See [bench/README.md](bench/README.md).
- **Compatibility.**
  - v0.4 and v0.3.1 configs are valid unchanged, and `upgrade` leaves them byte-for-byte as they were.
  - New projects get `reviewer.maxRounds: 2` (the old default was 3), plus `reviewer.adaptive`, `leanloop` and `quota` sections. A config without `reviewer.maxRounds` now means 2.
  - `"leanloop": { "enabled": false }` restores v0.4.0 behaviour exactly.
  - Sessions get five extra allow rules for the LeanLoop helpers, and nothing else of `dev-autopilot`.
  - `doctor` reports LeanLoop and warns (without failing) when `dev-autopilot` is not on PATH or the committed rule is from another version.
  - Ticket notices go to stderr, so `status` output stays pure JSON.
- **Tests.** 200 tests, including:
  - capsule selection, mandatory context, provenance, secrets and cache invalidation;
  - Delta Resume (unchanged, changed context, changed task, lost runtime, stale and multiple sessions);
  - quiet checks on real processes, including worktrees and timeouts;
  - review classification on real git diffs;
  - quota classification and reset parsing, with the real Codex out-of-credits output;
  - tickets: due, not due, replaced, stopped, expired, reboot, the detached helper;
  - efficiency metrics, compatibility with the v0.4.0 and v0.3.1 configs, and the benchmark.

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
- Fixed: the project filter for `claude agents` sessions had two bugs:
  - It matched sibling folders that share a prefix (for example `app` and `app2`).
  - It ignored letter case on Linux, where `/work/App` and `/work/app` are different projects. It now ignores case only on Windows and macOS.
- Fixed: a `claude.sessionNamePrefix` longer than 57 characters no longer cuts the task hash out of generated session names. The prefix is shortened instead.
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
