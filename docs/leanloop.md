# LeanLoop: send evidence, not history

LeanLoop is the efficiency layer added in Dev Agent Autopilot v0.4.1. It cuts the context and output that Autopilot puts in front of Claude Code and Codex, without weakening checks, reviews or safety rules.

LeanLoop is not another summarizer. Nothing in it calls a model. Every piece is deterministic and local: hashes, Markdown sections, git diffs and exit codes. The repository files stay the source of truth, and every excerpt LeanLoop passes on is the exact text of its source, with the path, line range and sha256.

| Part | What it does |
| --- | --- |
| [Context Capsule](#context-capsule) | Replaces "read all the context files" with one file: the task verbatim, the mandatory instructions and the sections that matter to this task |
| [Context cache](#context-cache) | Reuses the capsule and section maps while their source hashes are unchanged |
| [Delta Resume](#delta-resume) | Continues a stopped session with a short message, or with only what changed |
| [Quiet Checks](#quiet-checks) | Keeps full check logs on disk and shows the agent PASS lines, or a bounded failure excerpt |
| [Adaptive Codex review](#adaptive-codex-review) | Gives each change the review rounds its git diff warrants, never more than `reviewer.maxRounds` |
| [Planning economy](#planning-economy) | Never plans when the planner is off, and never plans the same task twice |
| [Compact task state](#compact-task-state) | Keeps orchestration facts in a small file instead of the conversation |
| [Quota resume tickets](#quota-resume-tickets) | Optionally resumes a task after a usage limit resets, but only when the CLI states the reset time |
| [Efficiency report](#efficiency-report) | Shows the bytes LeanLoop kept out of agent context, on this machine only |

Claude Code and Codex have their own context compaction. LeanLoop works one layer earlier, in the orchestration: it decides what reaches the agents in the first place. The savings it reports are bytes of text at that layer. They are not provider-billed tokens, which Autopilot cannot see.

## Context Capsule

In v0.4.0, `run` told Claude to read the rule, the config, the task and every configured context file at the start of a task. In v0.4.1, `run` builds a Context Capsule first and points Claude at it.

The capsule is built without an LLM and contains, in this order:

1. **The task, verbatim**, with its sha256.
2. **The Autopilot settings Claude needs**, derived from `.autopilot/config.json`: the base branch, the checks, the planner and review setup, and `safety.humanGates` and `safety.notes` verbatim.
3. **Project memory already in context.** Claude Code loads the root `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md` and files they import with `@path` by itself. The capsule lists them by hash instead of repeating them, and tells Claude to read one only if it is missing.
4. **Mandatory context, verbatim**, whatever the task says:
   - instruction files (`leanloop.context.instructionFiles`, by default `CLAUDE.md` and `AGENTS.md`), in full;
   - every section under a heading that contains a safety phrase (`leanloop.context.alwaysIncludeHeadings`: safety, security, secrets, credentials, policy, guardrails, constraints, never, do not, must not, forbidden, human gates);
   - entries in `leanloop.context.alwaysInclude`: `"FILE"` for a whole file, or `"FILE#Heading"` for one section and its subsections;
   - any block between `<!-- autopilot:always -->` and `<!-- /autopilot:always -->` in a context file.
5. **Task-relevant excerpts, verbatim.** Each configured context file is split into Markdown sections (non-Markdown files into 40-line windows). Each section is scored with deterministic signals from the task:
   - file paths and file names the task mentions;
   - identifiers (camelCase, snake_case, dotted names), called names such as `release()`, and numbered references such as "Phase 5" or "D12";
   - module and folder names from those paths;
   - rarer words, weighted by how few sections contain them and capped so that prose alone can't select a section.

   Sections close to the best score are included, up to `leanloop.context.maxExcerptBytes`, each labelled with the path, heading, lines, sha256 and the signals that matched.
6. **An index of everything else**: second-level headings with line ranges, so Claude can read exactly the part it needs.
7. **What was not processed and why**: missing files, git-ignored files, files whose names suggest credentials, and sections withheld because they contain a credential-like value.

Claude reads the capsule and opens an original source only when it needs more.

**Safety.** Keyword matching never decides whether a safety rule reaches Claude. Mandatory material doesn't depend on the task at all, and it is never cut to fit the budget. Nothing is paraphrased: a policy appears verbatim or is pointed to by path and lines.

**Credentials.** Files named like credentials (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `*secret*.json` and similar) are never read. Git-ignored files are not processed; the capsule names them so Claude can open one if it really needs to. A section that contains a known credential format (GitHub, OpenAI, Anthropic, AWS, Slack, Google, npm or Stripe keys, private keys) is withheld from the capsule and from the cache. Paths outside the repository are refused.

Inspect a capsule yourself with `dev-autopilot capsule` (size and path) or `dev-autopilot capsule --print`.

## Context cache

Runtime data lives in `.autopilot/runtime/context/` (git-ignored):

- `index.json` stores each context file's section map (headings, line ranges, section hashes; no text), keyed by the file's sha256. A changed file is re-parsed automatically.
- `capsule-<task>.md` and `capsule-<task>.json` hold the capsule and its manifest. The manifest has every source's role, status, sha256 and per-section hashes. Sources include the task, the config, the context and instruction files, and all project memory: `CLAUDE.md`, every file under `.claude/rules/`, and their `@` imports. A changed rule is therefore never reported as unchanged. The capsule is reused only when the context fingerprint matches. The fingerprint covers the Autopilot version, the capsule options and every source's path, status and hash. The capsule file's own hash is checked too, so a hand-edited capsule is rebuilt.
- `session-<task>.json` is the manifest of what the session was actually given, which Delta Resume compares against.

No LLM-generated summary is stored or used as a source of truth.

## Delta Resume

When `run` (or `dev-autopilot resume <id>`) finds a stopped or failed session of the current task, it compares that session's manifest with the current context:

| Situation | What the session receives |
| --- | --- |
| Task and context unchanged | A short continuation, about 0.4 KB: the context is unchanged, what you read before stays authoritative, continue from the current git and PR state |
| Context changed | A delta file with only the changed sources: the exact new text of changed sections that are mandatory or relevant to the task, line ranges for the rest, and removed sections |
| No record of what the session read (runtime folder lost, or another session) | The Context Capsule path, as for a new task |
| Task file changed | Nothing: it is a different task, so `run` starts a new session as before |

The message is sent with `claude --bg --resume <sessionId> "<message>"`, with no other flags. Claude Code documents that this continues the session under the same id with its saved options, and Autopilot verified it against Claude Code 2.1.284. A session that finished its turn is still running idle, so Autopilot stops it first; otherwise Claude Code would start a copy. If the installed Claude Code doesn't accept `--bg --resume`, Autopilot falls back to v0.4's `claude respawn` and prints the delta path for you.

Stale context is never reused to save bytes. v0.4.0's `respawn` sent no message at all, so a session never learned that a context file had changed.

## Quiet Checks

`dev-autopilot check` runs the configured `checks` one after another in the current checkout. In a Claude Code worktree, that is the worktree. It saves each check's complete output, byte for byte, to:

```text
.autopilot/runtime/checks/<task>/<run>/<nn>-<check>.log
```

and prints only:

```text
PASS  npm run lint  (2.1s)
PASS  npm test  (6.9s) · 93 passed
FAIL  npm run build  exit 2  (4.0s)
  log: …/.autopilot/runtime/checks/9e18f9f543b8/20260929-101500-000/03-npm-run-build.log (48.2 KB)
  excerpt: 41 of 1,204 lines
  | … (310 earlier lines)
  | src/index.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.
  | …
checks: 2 passed, 1 failed · full log: dev-autopilot check --log <name>
```

- A failure always shows the exit code (or the timeout), the log path and a bounded excerpt. The excerpt has windows around the first failure markers plus the end of the log, where runners print their summaries. Its size is set by `failureExcerptLines` and `failureExcerptBytes`. Gaps are marked, ANSI codes are removed, and credential-like values are redacted in the excerpt only; the log on disk is untouched.
- A pass shows the duration and, when the runner prints one, a short summary such as "93 passed".
- `dev-autopilot check --log <name|number>` prints the full stored log of a check's latest run.
- A pass is reused when nothing in the tree changed: the same checkout, HEAD, staged, unstaged and untracked content, and check command. Failures are never reused. `--force` reruns everything.
- `--only <name|number>` runs one check; `--bail` stops after the first failure.
- Checks may be plain strings (as in v0.4) or `{ "name": "...", "command": "..." }` objects.

The rule tells Claude to run the configured checks through `dev-autopilot check`, and to open a full log only for a failing check.

## Adaptive Codex review

`dev-autopilot codex review` works out a review budget from the actual git diff of the branch against the merge base with the base branch. The diff includes commits, staged and unstaged edits, and untracked files. It then runs the native `codex review --base <branch>`, never with a model flag.

| Diff | Rounds |
| --- | --- |
| Documentation only (`.md`, `.markdown`, `.txt`, `.rst`, `.adoc`), with none of the high-risk paths below | 0: Codex review is skipped |
| Small and low-risk: at most 3 files and 80 changed lines, no binaries | 1 |
| Anything else | 2 |
| High-risk | `reviewer.maxRounds` |

A change is high-risk when any changed path (old or new name) matches a built-in rule for:

- security and auth;
- payments and billing;
- database migrations;
- secrets and credentials;
- release and deployment;
- dependencies and lockfiles;
- CI and workflows;
- native and build configuration;
- agent instructions (`CLAUDE.md`, `AGENTS.md`, `.claude/`, `.codex/`, `.autopilot/`);
- repository security files (`.gitignore`, `SECURITY.md`).

It is also high-risk when a changed line in a non-documentation file mentions a sensitive keyword (password, secret, token formats, crypto, payment, SQL DDL, `child_process`, `innerHTML` and so on), or matches your own `highRiskPaths` / `highRiskKeywords`.

- `reviewer.maxRounds` stays the strict upper limit for every class. New projects get 2; v0.4 projects keep their 3.
- If a round is clean, Claude stops. Budget left over is never a reason to run another round. After fixes, one verification round is allowed while budget remains.
- A budget never shrinks within a task. If an earlier diff was high-risk, later fixes keep its budget.
- A failed Codex run is not counted as a round.
- `dev-autopilot review-budget [--json]` shows the class, the budget and the reasons.

## Planning economy

- With `planner.enabled` other than `true`, `dev-autopilot codex plan` never calls Codex. The rule and the launch prompt tell Claude not to plan. This suits tasks that already contain a plan, and projects that plan elsewhere, for example in ChatGPT. Codex still reviews.
- With the planner on, the plan is saved per task and context fingerprint. Asking again returns the saved plan without calling Codex. `--force` asks again.
- Autopilot never changes your planner setting.

## Compact task state

`.autopilot/runtime/task-state.json` holds the orchestration facts of the current task:

- task hash, session id and name, branch and base;
- the context fingerprint and capsule;
- the last check run (status, passed/total, time);
- the review class, budget and rounds used;
- PR number, CI state, blocker, status;
- a quota wait with its reset and resume times.

It holds no prompts, responses or transcripts. Claude records PR, CI and blockers with `dev-autopilot state --pr <n> --ci passing --blocker "<reason>" --status ready`. `dev-autopilot status` shows a short summary under `task`, for example `"state": "waiting-quota — resume scheduled 2026-09-29 14:32 UTC (…)"`.

## Quota resume tickets

Off by default. Opt in per project:

```json
"quota": { "autoResume": true, "graceMinutes": 2 }
```

Autopilot looks for exhausted usage in two places it can observe reliably: the output of the Codex commands it runs (`dev-autopilot codex plan|review`), and the recent output of a failed Claude session (`claude logs <id>`). It classifies the failure from that output:

| Kind | Examples | What happens |
| --- | --- | --- |
| quota | "usage limit", "out of credits", "insufficient_quota", "5-hour limit reached" | Stops the task and records the wait |
| rate limit | "429", "too many requests", "overloaded" | Retried once after a short pause; not a quota stop |
| auth | "not logged in", "401" | Reported as a blocker |
| network | ENOTFOUND, "stream disconnected" | Reported as a blocker |
| refusal, bad command | content policy, "unknown option" | Reported as a blocker |

A reset time is used only when the output states one explicitly:

- an ISO timestamp with a time zone;
- a Unix epoch (`limit reached|1759352400`, `"resets_at": …`);
- a relative time (`try again in 4 days 21 hours 35 minutes`, `resets in 2h 15m`);
- a clock time with an IANA zone or UTC (`resets 3pm (Europe/London)`, `resets Oct 6, 5pm (America/New_York)`).

Clock times without a zone are rejected as ambiguous, and so are outputs with two different reset times or a reset more than 8 days away. Nothing is inferred from a plan type, weekly resets are never guessed, credits are never bought, and no banked reset is used.

With a stated reset and `autoResume: true`, Autopilot writes `.autopilot/runtime/resume-ticket.json`. The ticket holds the project root, task hash, session, provider, reset time and `resumeAt = reset + graceMinutes`. Autopilot also starts a small detached helper (`node src/resume-helper.js`) that waits for that time. The helper survives closing the terminal, switching VS Code workspaces and the command that started it exiting. At `resumeAt` it takes a lock and runs the same checked path as `run`, which cancels the ticket unless all of these hold:

- same project folder;
- same task file hash;
- the task is still waiting on this ticket;
- the task hasn't been marked ready, complete or stopped;
- the session still exists and isn't already running;
- no other session is active in the project;
- `quota.autoResume` is still on.

If every check passes, it continues the session with a quota continuation message plus the usual Delta Resume information.

- `dev-autopilot stop <id>` cancels a pending ticket for that session or task, even if the session is already gone.
- Changing the task file cancels the ticket on the next command.
- `dev-autopilot status` shows `waiting-quota — resume scheduled <time>`.

**Reboots.** The helper is a normal process and doesn't survive a reboot or a logout that ends the user's processes. The ticket does. Any later `dev-autopilot` command restarts a helper whose process is gone, and the helper resumes at once if the ticket is due. Autopilot doesn't install OS schedulers or services. A ticket that is still pending three days after its resume time expires.

**Without a stated reset time**, the task stops safely with: `quota exhausted; reset time unavailable for automatic scheduling`. Run `dev-autopilot run` once the limit has reset.

## Efficiency report

`dev-autopilot efficiency [--json] [--task]` summarizes `.autopilot/runtime/efficiency.jsonl`, a local ledger of LeanLoop events:

- configured context bytes against capsule bytes;
- resumes by kind, with unchanged context not resent;
- full check-log bytes against the bytes shown, and passes reused;
- Codex planner calls and plan reuses, review rounds, reviews skipped by the adaptive policy, rounds refused at the budget, and transcript bytes against bytes shown;
- quota stops;
- duplicate session starts avoided.

The total can be shown as a token-equivalent at 4 bytes per token. That is a labelled estimate, not provider billing. Nothing leaves the machine, and there is no analytics service.

## Configuration

Every LeanLoop setting is optional. A v0.4 config works unchanged, and `dev-autopilot upgrade` doesn't rewrite it.

```json
{
  "leanloop": {
    "enabled": true,
    "context": {
      "instructionFiles": ["CLAUDE.md", "AGENTS.md"],
      "alwaysInclude": ["DECISIONS.md#Security"],
      "alwaysIncludeHeadings": ["safety", "security", "never", "must not"],
      "maxExcerptBytes": 12000,
      "maxSectionBytes": 4000
    },
    "checks": {
      "timeoutMinutes": 30,
      "failureExcerptLines": 60,
      "failureExcerptBytes": 6000,
      "reuseUnchangedPasses": true,
      "keepRuns": 10
    }
  },
  "reviewer": {
    "maxRounds": 2,
    "adaptive": {
      "enabled": true,
      "docsOnlyRounds": 0,
      "smallRounds": 1,
      "normalRounds": 2,
      "highRiskRounds": null,
      "smallMaxFiles": 3,
      "smallMaxLines": 80,
      "docsExtensions": [".md", ".markdown", ".txt", ".rst", ".adoc"],
      "highRiskPaths": ["src/billing-core/**"],
      "highRiskKeywords": ["LEGACY_FLAG"],
      "useDefaultHighRisk": true
    }
  },
  "quota": { "autoResume": false, "graceMinutes": 2 }
}
```

- `"leanloop": { "enabled": false }` restores v0.4.0 behaviour exactly: the old launch prompt, `claude respawn`, and no LeanLoop commands in the session allow-list.
- `"reviewer": { "adaptive": false }` keeps a fixed `reviewer.maxRounds` for every change.
- `smallRounds`, `normalRounds` and `highRiskRounds` must be at least 1, so a code change can never be configured to skip Codex review. `highRiskRounds: null` means `reviewer.maxRounds`.

## Session permissions

With LeanLoop on, Autopilot adds only these to the session's allow-list:

```text
Bash(dev-autopilot check*)
Bash(dev-autopilot codex plan*)
Bash(dev-autopilot codex review*)
Bash(dev-autopilot review-budget*)
Bash(dev-autopilot state*)
```

`run`, `stop`, `resume`, `cleanup` and the other commands stay out of the session. `dev-autopilot` must be on PATH (`npm link`); `doctor` warns if it isn't. Without it, Claude falls back to the plain check commands and `codex review`, as in v0.4.

## Benchmark

`npm run bench` runs the real v0.4.1 code on deterministic fixtures and compares it with v0.4.0's exact launch prompt and rule. The methodology, the per-scenario results and the limits of the measurement are in [bench/README.md](../bench/README.md). Headline on that benchmark: 281 KB → 64 KB of agent-facing text (77% less), with every required-information check passing.

## Limitations

- The capsule's relevance scoring is deterministic but heuristic. A relevant section can land in the index instead of the capsule; Claude then reads it by line range. Mandatory material never depends on it.
- On a project with only a small task and little context, such as the demo, the capsule is about the same size as the files it replaces. It carries the settings and human gates explicitly.
- The v0.4.1 Autopilot rule is about 1.7 KB longer than v0.4.0's, and Claude Code loads it into every session in the project.
- Adaptive review classifies by paths and changed-line keywords. A security-sensitive change in an innocuously named file with none of the keywords is classed by size. Add the project's own `highRiskPaths` and `highRiskKeywords` for anything the defaults don't cover.
- Quota detection depends on the wording of the Claude and Codex CLIs. An unrecognised message is treated as an ordinary failure, never as a quota stop with a guessed time.
- The resume helper doesn't survive a reboot; the next `dev-autopilot` command re-arms it.
- Delta Resume needs `claude --bg --resume` (verified on Claude Code 2.1.284). Older versions fall back to `claude respawn`.
