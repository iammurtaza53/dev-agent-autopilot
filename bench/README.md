# LeanLoop benchmark

`npm run bench` (or `node bench/leanloop-benchmark.js [--json]`) measures how much text Autopilot puts in front of the agents with v0.4.0-style orchestration and with LeanLoop, on deterministic fixtures. `test/benchmark.test.js` runs the same benchmark in CI. It fails if the reduction drops below 50% or if any required-information check fails.

## What runs

The benchmark builds a temporary git repository, "acme-orders", from `bench/fixtures/`. It is an order-management service with the context documents a mature project keeps: `CLAUDE.md`, `AGENTS.md`, `PROJECT_STATE.md`, `DECISIONS.md` and `ARCHITECTURE.md`, about 23 KB in total. Then it runs the **real v0.4.1 code** on it:

- `dev-autopilot run` with a stand-in `claude`, to build the Context Capsule and the launch prompt;
- the quiet check runner on real processes (`bench/fixtures/verbose-tests.js` prints a Vitest-style verbose log);
- the adaptive review policy on the real git diff of each scenario;
- the Codex wrapper, with fixture plan and review text;
- Delta Resume through `run`.

The v0.4.0 side uses v0.4.0's exact launch prompt and rule, captured from the v0.4.0 release in `test/fixtures/benchmark/v0.4.0/`, and the same fixtures.

| Scenario | Work |
| --- | --- |
| A. docs-only change | A runbook edit in `docs/operations.md`; checks run once (600 tests); Codex plans |
| B. small code change | 2 files, a few lines; checks run twice; v0.4.0 reviews twice (findings, then verification) |
| C. normal code change | 5 files, about 130 lines; checks run three times (1,200 tests, the first run fails one test); two review rounds |
| D. resume, unchanged | The session of task C stopped; nothing changed |
| E. resume, context changed | `ARCHITECTURE.md`'s Reservations section changed before the resume |

## What is measured

UTF-8 bytes of text an agent is given or told to read:

- **Launch context.** The launch prompt, plus the files it tells the agent to read at the start. For v0.4.0 that is the config, the task and the five context files. For v0.4.1 it is the capsule.
- **Project memory.** The Autopilot rule and `CLAUDE.md`, which Claude Code loads into every session in both versions. Counted once per launch for both.
- **Check output.** What the agent sees from each check run. v0.4.0 is counted as the raw output with ANSI codes removed, capped at 30,000 characters (Claude Code's default Bash output limit). v0.4.1 is the output of `dev-autopilot check`.
- **Codex text.** Plan and review text. v0.4.0 is credited with the final text only, with none of Codex's progress output. v0.4.1 includes the wrapper's footer lines.
- **Resume messages.** What Autopilot sends when a stopped session continues.

Choices that favour v0.4.0:

- the 30,000-character Bash cap;
- no Codex progress output counted for v0.4.0;
- the headline doesn't count v0.4.0's explicit rereads of the rule and `CLAUDE.md`, which are already in context as project memory, even though its launch prompt asks for them.

## Results

Produced by `npm run bench` on this commit. v0.4.1's check output includes measured durations, so its totals vary by a few bytes between runs (65,686 to 65,700 bytes in our runs); the v0.4.0 side is byte-for-byte stable at 287,829 bytes.

| Scenario | v0.4.0 | v0.4.1 | Change | Codex calls | Review rounds | Context read at start |
| --- | ---: | ---: | ---: | --- | --- | --- |
| A. docs-only change | 63.0 KB | 17.1 KB | 73% less | 2 → 1 | 1 → 0 | 5 context files → capsule |
| B. small code change | 93.7 KB | 20.4 KB | 78% less | 3 → 2 | 2 → 1 | 5 context files → capsule |
| C. normal code change, verbose tests | 124.4 KB | 24.4 KB | 80% less | 3 → 3 | 2 → 2 | 5 context files → capsule |
| D. resume, unchanged task and context | 0.0 KB | 0.4 KB | +0.4 KB | 0 → 0 | 0 → 0 | none (claude respawn sends no message) → none |
| E. resume after a context file changed | 0.0 KB | 1.8 KB | +1.8 KB | 0 → 0 | 0 → 0 | none, and the change is never delivered (stale context) → delta only |
| **Total** | **281.1 KB** | **64.1 KB** | **77% less** | 8 → 6 | | |

| Component | v0.4.0 | v0.4.1 |
| --- | ---: | ---: |
| Launch context | 77.9 KB | 29.4 KB |
| Project memory (rule + CLAUDE.md) | 16.3 KB | 21.3 KB |
| Check output | 180.0 KB | 2.9 KB |
| Codex plan and review text | 6.9 KB | 8.3 KB |
| Resume messages | 0.0 KB | 2.3 KB |

Counting v0.4.0's explicit rereads of the rule and `CLAUDE.md`, 297.3 KB → 64.1 KB (78% less). All 21 required-information checks pass, for example:

- the task verbatim;
- `AGENTS.md` and the Security section verbatim;
- the relevant architecture sections and decisions;
- the failing test's name and assertion;
- the full log on disk;
- the right review budget for each diff;
- a delta that carries the changed text and leaves unchanged sources out.

## Where the savings come from

- **Quiet checks** are the largest part. Without check output, the reduction is 39% (101.1 KB → 61.2 KB).
- **Context Capsule:** launch context is 62% smaller. The capsule keeps the task, the mandatory rules and 1 to 4 relevant sections, and indexes the rest.
- **Adaptive review:** 2 fewer Codex review rounds across A and B. Scenario C keeps both rounds.
- **The cost side:**
  - the v0.4.1 rule is 1.7 KB larger and is project memory in every session;
  - the wrapper adds footer lines to Codex output;
  - resumes send a message (0.4 KB unchanged, 1.8 KB with a delta) where v0.4.0 sent nothing. v0.4.0 also never delivered the changed context in scenario E, so its session kept working from stale text.

## What this is not

These are orchestration-layer bytes on one synthetic but realistic project. They are not provider-billed Claude or Codex tokens. Autopilot cannot see those: the providers add system prompts, tool schemas and conversation history, and cache and compact on their side.

Real savings depend on:

- the size of your context documents;
- how verbose your checks are;
- how often checks run;
- how your diffs are classified.

A small project with little context gains mostly from quiet checks. `dev-autopilot efficiency` reports the same kinds of numbers for your own runs.
