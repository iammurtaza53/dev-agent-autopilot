import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import {
  appendGitignore,
  byteLength,
  currentBranch,
  exists,
  formatBytes,
  isDirty,
  normalizePathForCompare,
  parseBackgroundId,
  readJson,
  runProcess,
  sha256,
  slugify,
  stripAnsi,
  writeJson,
} from './lib.js';
import {
  describePlugin,
  detectPlugin,
  loadPluginInSessions,
  PLUGIN_ID,
  PLUGIN_INSTALL_COMMANDS,
  PLUGIN_SETUP_IN_CLAUDE,
  pluginSessionSettings,
} from './codex-plugin.js';
import { classifySession, findSession, isBackground, isCurrentTask, matchesRecord, planCleanup, sessionName } from './sessions.js';
import { CONFIG_FILE, RUNTIME_DIR, resolveRoots, runtimePath, sameFolder, samePath } from './runtime.js';
import { contextProblems, ensureCapsule, pruneCapsules, renderDelta, writeDelta } from './context.js';
import { checkProblems, latestLog, normalizeChecks, runChecks } from './checks.js';
import { adaptiveProblems, classifyChange, collectDiff, DEFAULT_MAX_ROUNDS, reviewBudget } from './review-policy.js';
import { assessFailure, quotaOptions, quotaProblems, resumeAtFor } from './quota.js';
import { acquireLock, closeTicket, isDue, isExpired, launchDetachedHelper, newTicket, processAlive, readTicket, writeTicket } from './tickets.js';
import { readTaskState, stateForTask, updateTaskState } from './task-state.js';
import { formatReport, readEvents, recordEvent, summarize } from './efficiency.js';
import { codexPlan, codexReview, parseCodexCommand } from './codex-run.js';

const { version: VERSION } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const LAST_SESSION_FILE = '.autopilot/runtime/last-session.json';
const CLAUDE_RULE_FILE = '.claude/rules/dev-autopilot.md';
const CLAUDE_WORKTREES_DIR = '.claude/worktrees';

// Every external command goes through this runner; tests swap in a fake with setProcessRunner().
let exec = runProcess;

export function setProcessRunner(runner) {
  exec = runner || runProcess;
}

// Time, waiting and the detached resume helper are injectable too, so tests never sleep or spawn helpers.
let clock = () => new Date();
let sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let launchHelper = launchDetachedHelper;

export function setClock(fn) {
  clock = fn || (() => new Date());
}

export function setSleep(fn) {
  sleep = fn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

export function setHelperLauncher(fn) {
  launchHelper = fn || launchDetachedHelper;
}

const runGit = (cwd, args, options = {}) => exec('git', args, { cwd, ...options });

function leanloopEnabled(config) {
  return config?.leanloop?.enabled !== false;
}

function recordMetric(root, event) {
  return recordEvent(root, event, clock());
}

// Local-only data: Autopilot runtime state and Claude Code background-session worktrees.
// Never ignore all of .claude/, because the committed rule under .claude/rules/ must stay tracked.
const GITIGNORE_ENTRIES = [`${RUNTIME_DIR}/`, `${CLAUDE_WORKTREES_DIR}/`];

const COMMON_ALLOWED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Agent',
  'Task',
  'Bash(codex *)',
  'Bash(git *)',
  'Bash(gh *)',
  'Bash(node *)',
  'Bash(npm *)',
  'Bash(npx *)',
  'Bash(pnpm *)',
  'Bash(yarn *)',
  'Bash(bun *)',
  'Bash(python *)',
  'Bash(pytest *)',
  'Bash(go *)',
  'Bash(cargo *)',
  'Bash(dotnet *)',
  'Bash(java *)',
  'Bash(mvn *)',
  'Bash(gradle *)',
  'Bash(ls*)',
  'Bash(cat*)',
  'Bash(find*)',
  'Bash(grep*)',
];

const COMMON_DENIED_TOOLS = [
  'Bash(git push --force*)',
  'Bash(git push -f*)',
  'Bash(git push * --force*)',
  'Bash(git push * -f*)',
  'Bash(git reset --hard*)',
  'Bash(git clean -f*)',
  'Bash(git clean -fd*)',
  'Bash(gh pr merge*)',
  'Bash(npm publish*)',
  'Bash(pnpm publish*)',
  'Bash(yarn publish*)',
  'Bash(bun publish*)',
  'Bash(cargo publish*)',
  'Bash(dotnet nuget push*)',
  'Bash(mvn deploy*)',
  'Bash(gradle publish*)',
  'Bash(eas submit*)',
  'Bash(eas update*)',
];

// The LeanLoop helpers a session may call. Nothing else of dev-autopilot (run, stop, cleanup…) is allowed there.
const LEANLOOP_ALLOWED_TOOLS = [
  'Bash(dev-autopilot check*)',
  'Bash(dev-autopilot codex plan*)',
  'Bash(dev-autopilot codex review*)',
  'Bash(dev-autopilot review-budget*)',
  'Bash(dev-autopilot state*)',
];

const HUMAN_GATES = [
  'Pull-request merge.',
  'Production deployment or app-store submission.',
  'Purchases, paid-service activation, billing, banking, tax, or legal acceptance.',
  'Identity verification, 2FA, signing credentials, production secrets, or account-owner actions.',
  'Destructive production data changes or DNS changes.',
  'Physical-device validation or other real-world tests that cannot be automated safely.',
];

function usage() {
  console.log(`dev-autopilot v${VERSION}
Codex plans. Claude Code builds. Codex reviews. You merge.

Commands:
  init [path]                   Onboard a project (writes .autopilot/config.json + Claude rule)
  upgrade [path]                Refresh the Claude rule and .gitignore; add new config sections (e.g. planner)
  doctor [path]                 Verify Git, gh, Claude Code, Codex CLI, logins and the official Codex plugin
  run [path]                    Start or resume the project's Claude background session
  status [path]                 Show the project's background sessions (current, active or stale)
  agents [path]                 Open Claude's native agent view for the project
  attach <id> [path]            Attach to a background session (short id or full sessionId)
  logs <id> [path]              Show recent output from a background session
  stop <id> [path]              Stop a background session
  resume <id> [path]            Respawn a stopped/failed background session
  cleanup [path] [--apply]      List finished Autopilot sessions of earlier tasks; --apply removes them (claude rm)
  install-reviewer [--install-plugin]
                                Verify the Codex CLI planner and reviewer; check or install the official Codex plugin
  migrate-v1 [path]             Convert a v0.1 project config to the current format
  --version                     Print the version

LeanLoop (send evidence, not history; used by Autopilot sessions, also runnable by hand):
  check [path] [--force] [--bail] [--only <check>]
                                Run the configured checks quietly: full logs on disk, PASS/FAIL lines on screen
  check --log <check> [path]    Print the full stored log of a check's latest run
  codex plan [path] [--force] [--note <text>]
                                Ask Codex for a read-only plan once per unchanged task (only if planner.enabled)
  codex review [path]           Run the native Codex review under the adaptive review budget
  review-budget [path] [--json] Show how many Codex review rounds the current diff gets, and why
  capsule [path] [--print]      Build or reuse the Context Capsule for the current task and show its size
  state [path] [--pr <n>] [--ci <state>] [--status <state>] [--blocker <text>|--clear-blocker]
                                Show or record the task's compact orchestration state
  efficiency [path] [--json] [--task]
                                Local context/output metrics (bytes; token figures are estimates)

Models are intentionally NOT pinned. Claude and Codex use your configured/default models.`);
}

const COMMAND_OPTIONS = {
  cleanup: { apply: { type: 'boolean' } },
  'install-reviewer': { 'install-plugin': { type: 'boolean' } },
  check: { force: { type: 'boolean' }, bail: { type: 'boolean' }, only: { type: 'string' }, log: { type: 'string' } },
  codex: { force: { type: 'boolean' }, note: { type: 'string' } },
  'review-budget': { json: { type: 'boolean' } },
  capsule: { print: { type: 'boolean' } },
  state: { pr: { type: 'string' }, ci: { type: 'string' }, status: { type: 'string' }, blocker: { type: 'string' }, 'clear-blocker': { type: 'boolean' }, json: { type: 'boolean' } },
  efficiency: { json: { type: 'boolean' }, task: { type: 'boolean' } },
};

function parseCommandArgs(command, args) {
  try {
    const { values, positionals } = parseArgs({ args, options: COMMAND_OPTIONS[command] || {}, allowPositionals: true, strict: true });
    return { flags: values, positionals };
  } catch (error) {
    throw new Error(`${error.message}. Run dev-autopilot --help for usage.`);
  }
}

function buildConfig(root, name = path.basename(root)) {
  return {
    version: 2,
    project: {
      name,
      baseBranch: 'main',
      taskFile: 'NEXT_TASK.md',
      contextFiles: ['CLAUDE.md', 'AGENTS.md', 'PROJECT_STATE.md', 'DECISIONS.md', 'ARCHITECTURE.md'],
    },
    claude: {
      background: true,
      sessionNamePrefix: `autopilot-${slugify(name, 32)}`,
      allowedTools: [...COMMON_ALLOWED_TOOLS],
      disallowedTools: [...COMMON_DENIED_TOOLS],
    },
    planner: {
      enabled: true,
      transport: 'codex-cli',
      command: 'codex exec --sandbox read-only',
      modelPolicy: 'default',
    },
    reviewer: {
      transport: 'codex-cli',
      command: 'codex review',
      scope: 'base',
      maxRounds: DEFAULT_MAX_ROUNDS,
      useFreshSessionEachRound: true,
      modelPolicy: 'default',
      adaptive: { enabled: true },
    },
    codexPlugin: {
      loadInAutopilotSessions: false,
    },
    leanloop: {
      enabled: true,
    },
    quota: {
      autoResume: false,
      graceMinutes: 2,
    },
    checks: [],
    safety: {
      requireCleanStart: true,
      humanGates: [...HUMAN_GATES],
      notes: ['Do not merge pull requests.'],
    },
  };
}

function ruleText() {
  return `# Dev Agent Autopilot v${VERSION}

This repository uses a two-agent workflow. The local \`dev-autopilot\` launcher starts Claude Code background sessions and provides a few small deterministic helpers; it has no agent loop of its own.

- **Codex CLI is the architect and reviewer.** It plans the task before code is written and reviews the branch before it is finalized. Codex never edits files.
- **Claude Code is the developer.** It owns implementation, tests, Git, the pull request and CI.

## LeanLoop: send evidence, not history

- **Context Capsule.** If the launch prompt names one, read it instead of the configured context files. It has the task verbatim, the Autopilot settings, the mandatory instructions and task-relevant excerpts, each with its source path, lines and sha256. Open an original source only when you need more, and read just those lines. Without a capsule, read \`.autopilot/config.json\`, the task file and the relevant context files.
- **Resume.** If a resume message says the task and context are unchanged, what you read before stays authoritative: don't reread it. If it names changed sources, reread only those.
- **Quiet checks.** Run the configured checks with \`dev-autopilot check\`: one PASS line per check, or for a failure the exit code, the log path and a bounded excerpt. Open a full log (\`dev-autopilot check --log <check>\`) only for a failing check. Don't rerun a passing check unless relevant files changed; it reuses a pass for an unchanged tree by itself (\`--force\` reruns).
- **Work directly.** Don't spawn subagents to read files, run checks, summarize documents or review work (Codex is the reviewer). Use them only for genuinely independent parallel work or an isolated specialist investigation, at most 2 at a time unless the task needs more.
- **Read and write narrowly.** Prefer grep/glob and line ranges to whole files, and don't reread unchanged large files. Don't paste passing logs or repeat what the task, PR or repository already records. Keep reports concise, and put durable state in Git, the PR or project docs.
- If \`dev-autopilot\` is not available in the session, run the checks and the native \`codex\` commands below directly.

## Start of every Autopilot task

1. Respect all existing repository instructions, especially \`CLAUDE.md\` and \`AGENTS.md\`.
2. Stay within the stated task/phase scope. Make reasonable engineering decisions that do not change product scope.
3. Do not change model selection. Do not invoke \`/model\`, do not request a Claude model override, and do not pass \`--model\` or model config overrides to Codex. Use the user's configured/default models.

## Plan with Codex (architect)

Only when \`planner.enabled\` is \`true\`. When it is \`false\`, never ask Codex for a plan: the task may contain one, or the project plans elsewhere.

- Before writing code, run \`dev-autopilot codex plan\`. It runs the native \`codex exec --sandbox read-only\` and saves the plan per task and context, so equivalent planning never runs twice. Without \`dev-autopilot\`: \`codex exec --sandbox read-only "<prompt>" < /dev/null\`, asking for the approach, files, interfaces, risks, a test plan and ordered steps, without editing files.
- Do not add \`--model\`; Codex must use the user's configured/default model.
- You own the final decisions: explain any deviation from the plan in the pull request, and add a short "Plan (Codex)" summary to it.

## Implementation loop (Claude)

Implement the current task end-to-end, run the checks listed in \`.autopilot/config.json\` with \`dev-autopilot check\`, and repair failures the task caused.

## Review with Codex (reviewer)

- Before finalizing, run \`dev-autopilot codex review\`: a FRESH, independent native \`codex review --base <baseBranch> < /dev/null\`, with the transcript saved and the review printed. Without \`dev-autopilot\`, run that command directly. Do not add \`--model\`, and never ask Codex to edit files.
- The budget comes from the git diff: documentation-only changes 0 rounds, small low-risk changes 1, other changes 2, and high-risk changes (security/auth, payments, migrations, secrets, release/deploy, dependencies, CI, build config, agent instructions, paths the project lists) \`reviewer.maxRounds\`. \`dev-autopilot review-budget\` explains it.
- Each review run is one round. If a round is clean, stop: never run another round just because budget remains. After fixing findings and rerunning the relevant checks, one verification round is allowed if budget remains. Never run more than \`reviewer.maxRounds\` rounds or the budget: if findings remain after the last round, stop and report them as a blocker instead of looping.
- Add a short "Review (Codex)" summary to the pull request: rounds run, what was fixed, and anything deliberately left unchanged and why.

## When Codex fails

If a Codex plan or review fails (for example: not signed in, network error), retry it once, then stop and report the error as a blocker. If \`dev-autopilot codex\` reports exhausted usage or quota, don't retry: stop and report it. Autopilot records a stated reset time and, with \`quota.autoResume\` on, resumes this session after it. Never replace Codex's plan or review with your own, and never describe work as reviewed by Codex when the review did not complete.

## Orchestration state

Record facts with \`dev-autopilot state\` instead of restating them in chat: \`--pr <number>\` after opening the PR, \`--ci pending|passing|failing\`, \`--blocker "<reason>"\`, and \`--status ready\` when the PR is ready for human review.

## Official Codex plugin (codex-plugin-cc)

OpenAI's Codex plugin for Claude Code may be installed for the human's own reviews; Autopilot normally switches it off in its sessions. In an Autopilot session:

- Do not use \`/codex:rescue\` or the \`codex:codex-rescue\` subagent. Codex must not write code here.
- Do not run \`/codex:setup\` and do not change the plugin's review gate.
- Do not run \`/codex:review\` or \`/codex:adversarial-review\` yourself; they are user-invoked. The native \`codex review\` is the automated reviewer.

## Git and GitHub

- Work on a non-base branch (background-session worktree isolation may manage it). You may commit and push the task branch and create/update a pull request.
- Never force-push protected/base branches. Never merge the pull request.
- After opening the PR, watch CI. If it fails for task-related reasons, fix it, rerun checks, push and re-check.
- Finish when the PR is ready for human review/merge or a genuine human gate is reached.

## Human gates

Stop and clearly report the gate instead of guessing when the work requires anything listed under \`safety.humanGates\` in \`.autopilot/config.json\`: production/store actions, purchases, identity/2FA, legal/financial actions, production secrets, destructive production changes, DNS changes and physical-device validation.
`;
}

// The v0.4 launch prompt, used unchanged when leanloop.enabled is false.
function legacyLaunchPrompt(config) {
  const plan = config.planner?.enabled === true
    ? ' Start by getting an architecture and implementation plan from Codex (codex exec --sandbox read-only), then implement it.'
    : '';
  const reviewer = reviewerSummary(config);
  return `Read ${CLAUDE_RULE_FILE}, ${CONFIG_FILE}, ${config.project.taskFile}, and the configured project context files. Execute the current task end-to-end under the Autopilot workflow.${plan} Before finalizing, review the branch with the native Codex CLI reviewer (${reviewer.command}), at most ${reviewer.maxRounds} rounds; if Codex fails, stop and report it instead of reviewing the work yourself. Open/update the task PR, wait for CI, and stop before merge or any human gate.`;
}

function launchPrompt(config, { capsulePath = null } = {}) {
  if (!leanloopEnabled(config) || !capsulePath) return legacyLaunchPrompt(config);
  const plan = config.planner?.enabled === true
    ? ' Then get an architecture and implementation plan with dev-autopilot codex plan (native Codex, read-only sandbox) and implement it.'
    : ' Codex planning is off for this project: do not ask Codex for a plan.';
  const reviewer = reviewerSummary(config);
  return `Execute the task in ${config.project.taskFile} end-to-end under the Autopilot workflow in ${CLAUDE_RULE_FILE} (Claude Code loads it as project memory; read it only if it is missing from your context). Start with the Context Capsule at ${capsulePath}: it holds the task verbatim, the Autopilot settings, the mandatory instructions and the task-relevant excerpts of the configured context files, each with its source path, lines and sha256. It replaces reading the configured context files; open an original source only when you need more than it shows.${plan} Run the configured checks with dev-autopilot check. Before finalizing, run dev-autopilot codex review (native Codex CLI reviewer: ${reviewer.command}, adaptive budget from the diff, at most ${reviewer.maxRounds} rounds); if Codex fails or reports exhausted usage, stop and report it instead of reviewing the work yourself. Open/update the task PR, record it with dev-autopilot state --pr <number>, wait for CI, and stop before merge or any human gate.`;
}

function short(hash) {
  return hash ? hash.slice(0, 12) : 'none';
}

// The message that continues an existing session. It says what changed and what didn't, instead of asking for
// the whole context again.
function resumePrompt({ kind, reason, config, taskHash, fingerprint, capsulePath, deltaPath, changed, waiting }) {
  const taskFile = config.project?.taskFile || 'NEXT_TASK.md';
  const parts = [];
  if (reason === 'quota') {
    const who = waiting?.provider === 'claude' ? 'Claude' : 'Codex';
    const when = waiting?.resetAt ? `stated a reset time of ${waiting.resetAt}, which has passed` : 'may have reset';
    parts.push(`Autopilot resume: the ${who} usage limit that stopped this task ${when}. Rerun the step that failed${waiting?.step ? ` (${waiting.step})` : ''} and continue.`);
  } else {
    parts.push('Autopilot resume for the same task.');
  }
  if (kind === 'unchanged') {
    parts.push(`The task (${taskFile}, sha256:${short(taskHash)}) and its context (fingerprint ${short(fingerprint)}) are unchanged since you read them. What you read before remains authoritative: do not reread the task, the rule or the context files.`);
  } else if (kind === 'delta') {
    parts.push(`The task (${taskFile}, sha256:${short(taskHash)}) is unchanged, but these context sources changed since you read them: ${changed.join(', ')}. Read the delta at ${deltaPath} and reread only what it points to; everything else you read before remains authoritative.`);
  } else {
    parts.push(`Autopilot has no record of the context this session read, so read the Context Capsule at ${capsulePath} before continuing. It replaces reading the configured context files.`);
  }
  parts.push(`Continue from the current git and session state (check git status and the PR/CI state first) under ${CLAUDE_RULE_FILE}. Stop before merge or any human gate.`);
  return parts.join(' ');
}

// Autopilot has one automated reviewer backend: the native Codex CLI. The official Codex plugin's review
// commands are user-invoked only, so they are a manual companion rather than a backend (docs/codex-plugin.md).
function reviewerSummary(config) {
  return {
    backend: 'codex-cli',
    command: `codex review --base ${config.project?.baseBranch || 'main'}`,
    maxRounds: config.reviewer?.maxRounds ?? DEFAULT_MAX_ROUNDS,
  };
}

function transportProblem(field, transport) {
  if (/mcp/i.test(transport)) {
    return `${field} "${transport}" is from Autopilot v0.2, whose MCP bridge was removed in v0.2.1. Run dev-autopilot upgrade to switch to "codex-cli".`;
  }
  if (/plugin/i.test(transport)) {
    return `${field} "${transport}" is not supported: the official Codex plugin's review commands are user-invoked only (disable-model-invocation), so an unattended session can't run them. Use "codex-cli", and run /codex:review or /codex:adversarial-review yourself in Claude Code. See docs/codex-plugin.md.`;
  }
  return `${field} "${transport}" is not supported. The only supported value is "codex-cli".`;
}

// A missing setting takes its default; an explicit value, including null, must be valid.
function setting(value, fallback) {
  return value === undefined ? fallback : value;
}

// Returns human-readable problems with the parts of the config that `run` relies on.
function configProblems(config) {
  const problems = [];
  const reviewerTransport = setting(config.reviewer?.transport, 'codex-cli');
  if (reviewerTransport !== 'codex-cli') problems.push(transportProblem('reviewer.transport', reviewerTransport));
  const maxRounds = setting(config.reviewer?.maxRounds, DEFAULT_MAX_ROUNDS);
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    problems.push(`reviewer.maxRounds must be a whole number of at least 1 (found ${JSON.stringify(maxRounds)}).`);
  }
  const plannerTransport = setting(config.planner?.transport, 'codex-cli');
  if (config.planner?.enabled === true && plannerTransport !== 'codex-cli') problems.push(transportProblem('planner.transport', plannerTransport));
  const loadPlugin = config.codexPlugin?.loadInAutopilotSessions;
  if (loadPlugin !== undefined && typeof loadPlugin !== 'boolean') {
    problems.push(`codexPlugin.loadInAutopilotSessions must be true or false (found ${JSON.stringify(loadPlugin)}).`);
  }
  // LeanLoop settings are all optional, so a v0.4 config without them is valid as it is.
  const leanloop = config.leanloop;
  if (leanloop !== undefined && (!leanloop || typeof leanloop !== 'object' || Array.isArray(leanloop))) problems.push('leanloop must be an object.');
  else if (leanloop?.enabled !== undefined && typeof leanloop.enabled !== 'boolean') problems.push(`leanloop.enabled must be true or false (found ${JSON.stringify(leanloop.enabled)}).`);
  problems.push(...contextProblems(config), ...checkProblems(config), ...adaptiveProblems(config), ...quotaProblems(config));
  for (const [kind, section] of [['plan', 'planner'], ['review', 'reviewer']]) {
    const command = config[section]?.command;
    if (command === undefined || (kind === 'plan' && config.planner?.enabled !== true)) continue;
    try {
      parseCodexCommand(command, kind);
    } catch (error) {
      problems.push(error.message);
    }
  }
  return problems;
}

function assertValidConfig(config) {
  const problems = configProblems(config);
  if (problems.length) throw new Error(`Fix ${CONFIG_FILE}:\n- ${problems.join('\n- ')}`);
}

const PLUGIN_GATE_WARNING = `codexPlugin.loadInAutopilotSessions is true, so the official Codex plugin loads inside Autopilot sessions. If you enabled its review gate (/codex:setup --enable-review-gate), it reviews every stop in addition to Autopilot's reviewer.maxRounds loop and can use a lot of Codex usage. Keep the gate off, or set loadInAutopilotSessions to false.`;

// The --settings passed to Claude Code for an Autopilot background session.
function sessionSettings(config) {
  const plugin = pluginSessionSettings(config);
  const allow = config.claude?.allowedTools || COMMON_ALLOWED_TOOLS;
  const settings = {
    permissions: {
      defaultMode: 'dontAsk',
      allow: leanloopEnabled(config) ? [...new Set([...allow, ...LEANLOOP_ALLOWED_TOOLS])] : allow,
      deny: [...new Set([...(config.claude?.disallowedTools || COMMON_DENIED_TOOLS), ...plugin.deny])],
    },
  };
  if (plugin.enabledPlugins) settings.enabledPlugins = plugin.enabledPlugins;
  return settings;
}

async function writeSessionSettings(root, config) {
  const file = path.join(root, RUNTIME_DIR, 'claude-settings.json');
  await writeJson(file, sessionSettings(config));
  return file;
}

async function rootFrom(value) {
  return path.resolve(value || process.cwd());
}

async function loadConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  if (!(await exists(file))) throw new Error(`Missing ${CONFIG_FILE}. Run dev-autopilot init first.`);
  const config = await readJson(file);
  if (config.version !== 2) throw new Error(`Project config is version ${config.version}; run dev-autopilot migrate-v1.`);
  return config;
}

async function ensureRule(root) {
  const file = path.join(root, CLAUDE_RULE_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, ruleText(), 'utf8');
}

async function ensureGitignore(root) {
  const added = await appendGitignore(root, GITIGNORE_ENTRIES);
  if (added.length) console.log(`Added to .gitignore: ${added.join(', ')}`);
}

async function init(root) {
  const configFile = path.join(root, CONFIG_FILE);
  if (await exists(configFile)) throw new Error(`${CONFIG_FILE} already exists. Use migrate-v1 for v0.1 projects.`);
  await writeJson(configFile, buildConfig(root, path.basename(root)));
  await ensureRule(root);
  console.log(`Created ${CONFIG_FILE}`);
  console.log(`Created ${CLAUDE_RULE_FILE}`);
  await ensureGitignore(root);
  console.log('Next: add your test/lint/build commands to "checks" in the config, write your task in NEXT_TASK.md,');
  console.log('and commit the config, rule and .gitignore through your normal PR workflow before running.');
}

async function upgrade(root) {
  const config = await loadConfig(root);
  let changed = false;
  if (!config.planner) {
    config.planner = buildConfig(root).planner;
    changed = true;
    console.log(`Added the Codex planner to ${CONFIG_FILE} (set planner.enabled to false to opt out).`);
  }
  // v0.2.0 reviewed through a Codex MCP bridge that v0.2.1 removed; the native CLI replaced it.
  if (config.reviewer && /mcp/i.test(config.reviewer.transport || '')) {
    config.reviewer.transport = 'codex-cli';
    changed = true;
    console.log('Switched reviewer.transport to "codex-cli" (the Codex MCP bridge was removed in v0.2.1).');
  }
  if (changed) await writeJson(path.join(root, CONFIG_FILE), config);
  if (config.codexPlugin === undefined) {
    console.log(`The official Codex plugin (${PLUGIN_ID}) stays switched off inside Autopilot sessions by default; see "codexPlugin" in the README.`);
  }
  // LeanLoop needs no config change: every new setting is optional and has a default.
  if (config.leanloop === undefined) {
    console.log(`LeanLoop is on with its defaults (Context Capsule, Delta Resume, quiet checks, adaptive review up to reviewer.maxRounds = ${config.reviewer?.maxRounds ?? DEFAULT_MAX_ROUNDS}). Set "leanloop": { "enabled": false } to keep the v0.4 behaviour.`);
  }
  if (config.quota === undefined) console.log('Quota auto-resume stays off. Opt in with "quota": { "autoResume": true, "graceMinutes": 2 }.');
  await ensureRule(root);
  console.log(`Updated ${CLAUDE_RULE_FILE} to v${VERSION}.`);
  await ensureGitignore(root);
  console.log('Review and commit the changes through your normal PR workflow before running.');
}

async function migrateV1(root) {
  const file = path.join(root, CONFIG_FILE);
  if (!(await exists(file))) throw new Error(`Missing ${CONFIG_FILE}`);
  const old = await readJson(file);
  if (old.version === 2) {
    console.log('Project already uses the v2 config format. Run dev-autopilot upgrade to refresh the rule.');
    return;
  }
  if (old.version !== 1) throw new Error(`Unsupported old config version: ${old.version}`);

  const backupDir = path.join(root, RUNTIME_DIR);
  await fs.mkdir(backupDir, { recursive: true });
  await writeJson(path.join(backupDir, 'config-v1.backup.json'), old);

  const config = buildConfig(root, old.project?.name || path.basename(root));
  config.project.baseBranch = old.project?.baseBranch || config.project.baseBranch;
  config.project.taskFile = old.project?.taskFile || config.project.taskFile;
  if (Array.isArray(old.project?.contextFiles)) config.project.contextFiles = old.project.contextFiles;
  if (Array.isArray(old.checks) && old.checks.length) {
    config.checks = old.checks.map((entry) => (typeof entry === 'string' ? entry : entry.command)).filter(Boolean);
  }
  if (Array.isArray(old.agents?.implementer?.allowedTools) && old.agents.implementer.allowedTools.length) {
    config.claude.allowedTools = [...new Set([...old.agents.implementer.allowedTools, 'Bash(codex *)'])];
  }
  if (Array.isArray(old.safety?.disallowedTools) && old.safety.disallowedTools.length) {
    config.claude.disallowedTools = [...new Set([...COMMON_DENIED_TOOLS, ...old.safety.disallowedTools])];
  }

  await writeJson(file, config);
  await ensureRule(root);
  await ensureGitignore(root);

  const oldState = path.join(root, '.autopilot/state.json');
  if (await exists(oldState)) {
    await fs.rename(oldState, path.join(backupDir, 'state-v1.backup.json')).catch(async () => {
      await fs.copyFile(oldState, path.join(backupDir, 'state-v1.backup.json'));
    });
  }

  console.log('Migrated .autopilot/config.json from v1 to v2.');
  console.log(`Created ${CLAUDE_RULE_FILE}.`);
  console.log('Old v1 config/state were backed up under .autopilot/runtime/ (gitignored).');
  console.log('Review and commit the v2 config, rule and .gitignore before running.');
}

function isInteractiveTerminal() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function askYesNo(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

function printPluginSetupSteps() {
  console.log('  In Claude Code:');
  for (const step of PLUGIN_SETUP_IN_CLAUDE) console.log(`    ${step}`);
  console.log('  Or from this terminal (asks before changing anything): dev-autopilot install-reviewer --install-plugin');
}

// Verifies the native Codex CLI that Autopilot automates, then checks for the official Codex plugin.
// The plugin is only installed with --install-plugin, in an interactive terminal, after a yes.
async function installReviewer(root, { installPlugin = false, interactive = isInteractiveTerminal(), confirm = askYesNo } = {}) {
  for (const subcommand of ['exec', 'review']) {
    const result = await codexAvailable(root, subcommand);
    if (!result.ok) throw new Error(result.output || `Codex native ${subcommand} command is unavailable`);
    console.log(`Codex native ${subcommand === 'exec' ? 'planner' : 'reviewer'} is available: codex ${subcommand}`);
  }
  console.log((await codexSignedIn(root))
    ? 'Codex CLI is signed in (codex login status).'
    : 'Codex CLI is not signed in. Run: codex login');
  console.log('Autopilot plans and reviews with the native Codex CLI. No MCP registration is required.');
  console.log('Models are not pinned; Codex uses your configured/default model.');

  let plugin = await detectPlugin(exec, root);
  console.log(`\nOfficial Codex plugin for Claude Code (${PLUGIN_ID}): ${describePlugin(plugin)}`);
  if (plugin.detection === 'ok' && plugin.installed) {
    console.log('Use it for your own reviews in Claude Code: /codex:review --base main, /codex:adversarial-review --base main.');
    console.log('Autopilot switches it off inside its background sessions. Leave its review gate off for Autopilot projects.');
    if (installPlugin) console.log('Already installed: nothing to do.');
    return;
  }
  if (!installPlugin) {
    console.log('Optional. It adds /codex:review and /codex:adversarial-review for reviews you start yourself in Claude Code.');
    console.log('Autopilot does not need it: its automated review loop uses the native Codex CLI. To install it:');
    printPluginSetupSteps();
    return;
  }
  if (!interactive) {
    throw new Error('--install-plugin changes your Claude Code user settings, so it only runs in an interactive terminal after you confirm. Nothing was installed.');
  }
  const commands = PLUGIN_INSTALL_COMMANDS.map((args) => `claude ${args.join(' ')}`);
  const approved = await confirm(`\nThis adds the plugin to your Claude Code user settings by running:\n  ${commands.join('\n  ')}\nInstall it now? [y/N] `);
  if (!approved) {
    console.log('Nothing was installed.');
    return;
  }
  const [marketplaceArgs, installArgs] = PLUGIN_INSTALL_COMMANDS;
  // Adding a marketplace you already have can fail harmlessly, so only the install step decides the outcome.
  const added = await exec('claude', marketplaceArgs, { cwd: root, stdin: 'inherit' }).catch((error) => ({ code: 1, stderr: error.message }));
  if (added.code !== 0) console.log(`"claude ${marketplaceArgs.join(' ')}" did not succeed; trying the install anyway.`);
  const installed = await exec('claude', installArgs, { cwd: root, stdin: 'inherit' }).catch((error) => ({ code: 1, stderr: error.message }));
  if (installed.code !== 0) throw new Error(`"claude ${installArgs.join(' ')}" failed. Install the plugin from Claude Code instead.`);

  plugin = await detectPlugin(exec, root);
  console.log(`Official Codex plugin: ${describePlugin(plugin)}`);
  console.log('Next, in Claude Code: /reload-plugins in any open session, then /codex:setup to check Codex.');
  console.log('Leave the review gate off for Autopilot projects: Autopilot already runs a bounded review loop.');
}

async function versionOf(command, args, root) {
  try {
    const result = await exec(command, args, { cwd: root, timeoutMs: 15000 });
    return result.code === 0 ? (result.stdout || result.stderr).trim().split(/\r?\n/)[0] : `ERROR: ${(result.stderr || result.stdout).trim()}`;
  } catch (error) {
    return `ERROR: ${error.message}`;
  }
}

// Lists sessions from `claude agents --json`: the project's sessions by default, or every session on
// this machine with { global: true }.
async function listSessions(root, includeAll = true, { global = false } = {}) {
  const args = ['agents', '--json'];
  if (includeAll) args.push('--all');
  if (!global) args.push('--cwd', root);
  const result = await exec('claude', args, { cwd: root, timeoutMs: 30000 }).catch((error) => ({ code: 1, stdout: '', stderr: error.message }));
  if (result.code !== 0) return { ok: false, sessions: [], error: (result.stderr || result.stdout).trim() };
  try {
    const parsed = JSON.parse(result.stdout || '[]');
    const rootKey = normalizePathForCompare(root);
    const underRoot = (cwd) => {
      const key = normalizePathForCompare(cwd);
      return key === rootKey || key.startsWith(rootKey.endsWith('/') ? rootKey : `${rootKey}/`);
    };
    const sessions = Array.isArray(parsed) ? parsed.filter((item) => global || !item.cwd || underRoot(item.cwd)) : [];
    return { ok: true, sessions, error: null };
  } catch (error) {
    return { ok: false, sessions: [], error: `Could not parse claude agents JSON: ${error.message}` };
  }
}

async function codexAvailable(root, subcommand) {
  const result = await exec('codex', [subcommand, '--help'], { cwd: root, timeoutMs: 15000 }).catch((error) => ({ code: 1, stderr: error.message }));
  return { ok: result.code === 0, output: (result.stdout || result.stderr || '').trim() };
}

// Only the exit code is used. The output can describe the stored credential, so it is never printed.
async function codexSignedIn(root) {
  const result = await exec('codex', ['login', 'status'], { cwd: root, timeoutMs: 15000 }).catch(() => ({ code: 1 }));
  return result.code === 0;
}

async function doctor(root) {
  const config = await loadConfig(root);
  const checks = {
    git: await versionOf('git', ['--version'], root),
    gh: await versionOf('gh', ['--version'], root),
    claude: await versionOf('claude', ['--version'], root),
    codex: await versionOf('codex', ['--version'], root),
  };
  // Authentication checks use exit codes only; their output is never printed.
  const claudeAuth = await exec('claude', ['auth', 'status'], { cwd: root, timeoutMs: 15000 }).catch((error) => ({ code: 1, stderr: error.message }));
  const ghAuth = await exec('gh', ['auth', 'status'], { cwd: root, timeoutMs: 15000 }).catch((error) => ({ code: 1, stderr: error.message }));
  const codexAuthenticated = await codexSignedIn(root);
  const plannerEnabled = config.planner?.enabled === true;
  const planner = plannerEnabled ? await codexAvailable(root, 'exec') : null;
  const reviewer = await codexAvailable(root, 'review');
  const agents = await listSessions(root, false);
  const plugin = await detectPlugin(exec, root);
  const problems = configProblems(config);
  const loadPlugin = loadPluginInSessions(config);

  await maintainTicket(root);
  const lean = leanloopEnabled(config);
  // Sessions call the LeanLoop helpers by name, so the command must resolve on PATH.
  const onPath = lean ? await versionOf('dev-autopilot', ['--version'], root) : null;
  const rule = await fs.readFile(path.join(root, CLAUDE_RULE_FILE), 'utf8').catch(() => null);
  const quota = quotaOptions(config);
  const ticket = await readTicket(root);

  const warnings = [];
  if (!codexAuthenticated) warnings.push('Codex CLI is not signed in. Run: codex login');
  // Warn on the opt-in itself: detection can fail, and the gate state can't be read either way.
  if (loadPlugin) warnings.push(PLUGIN_GATE_WARNING);
  if (lean && String(onPath).startsWith('ERROR:')) {
    warnings.push('dev-autopilot is not on PATH, so Autopilot sessions fall back to plain checks and codex commands (no quiet checks or review budget). Install it with npm link.');
  }
  if (!rule) warnings.push(`${CLAUDE_RULE_FILE} is missing. Run dev-autopilot upgrade and commit it.`);
  else if (!rule.startsWith(`# Dev Agent Autopilot v${VERSION}\n`)) warnings.push(`${CLAUDE_RULE_FILE} is from another Autopilot version. Run dev-autopilot upgrade and commit it.`);

  const output = {
    root,
    configVersion: config.version,
    tools: checks,
    claudeAuthenticated: claudeAuth.code === 0,
    githubAuthenticated: ghAuth.code === 0,
    codexAuthenticated,
    codexPlannerAvailable: plannerEnabled ? planner.ok : 'disabled',
    codexReviewAvailable: reviewer.ok,
    reviewer: {
      ...reviewerSummary(config),
      available: reviewer.ok,
      officialPluginBackend: 'not supported: its review commands are user-invoked only (see docs/codex-plugin.md)',
    },
    officialCodexPlugin: {
      id: PLUGIN_ID,
      status: describePlugin(plugin),
      ...plugin,
      role: 'optional companion for your own reviews in Claude Code: /codex:review, /codex:adversarial-review',
      inAutopilotSessions: loadPlugin ? 'loaded (codexPlugin.loadInAutopilotSessions is true)' : 'switched off',
      reviewGate: 'not readable through a supported command; check it with /codex:setup in Claude Code',
    },
    leanloop: lean
      ? {
          enabled: true,
          devAutopilotOnPath: !String(onPath).startsWith('ERROR:'),
          contextFiles: (config.project?.contextFiles || []).length,
          checks: normalizeChecks(config).length,
          adaptiveReview: config.reviewer?.adaptive === false || config.reviewer?.adaptive?.enabled === false ? 'off' : 'on',
          quota: { autoResume: quota.autoResume, graceMinutes: quota.graceMinutes },
          pendingResume: ticket?.status === 'pending' ? { resumeAt: ticket.resumeAt, provider: ticket.provider, session: ticket.session?.id || null } : null,
        }
      : { enabled: false },
    claudeAgentViewAvailable: agents.ok,
    activeSessions: agents.sessions.filter(isBackground).map(({ id, state, name, cwd, waitingFor }) => ({ id, state, name, cwd, waitingFor })),
    configProblems: problems,
    warnings,
    modelPolicy: 'No model pinning. Claude and Codex use your configured/default models.',
  };
  console.log(JSON.stringify(output, null, 2));

  // The plugin is optional, so its absence or a failed detection never fails doctor.
  const failedTools = Object.values(checks).some((value) => String(value).startsWith('ERROR:'));
  if (failedTools || claudeAuth.code !== 0 || ghAuth.code !== 0 || !codexAuthenticated || (planner && !planner.ok) || !reviewer.ok || !agents.ok || problems.length) {
    process.exitCode = 2;
  }
}

async function runtimeRecord(root) {
  return readJson(path.join(root, LAST_SESSION_FILE), null);
}

async function saveRuntimeRecord(root, value) {
  await writeJson(path.join(root, LAST_SESSION_FILE), value);
}

async function taskHash(root, config) {
  const taskPath = path.join(root, config.project.taskFile);
  if (!(await exists(taskPath))) throw new Error(`Task file not found: ${config.project.taskFile}`);
  return sha256(await fs.readFile(taskPath, 'utf8'));
}

async function currentTaskHash(root, config) {
  return taskHash(root, config).catch(() => null);
}

function describeReviewSetup(config) {
  const reviewer = reviewerSummary(config);
  const adaptive = leanloopEnabled(config) && config.reviewer?.adaptive !== false && config.reviewer?.adaptive?.enabled !== false;
  console.log(`Reviewer: native Codex CLI (${reviewer.command}), at most ${reviewer.maxRounds} rounds${adaptive ? '; the adaptive budget from the diff can lower that' : ''}.`);
  console.log(loadPluginInSessions(config)
    ? `Warning: ${PLUGIN_GATE_WARNING}`
    : `Official Codex plugin (${PLUGIN_ID}): switched off inside this Autopilot session; your own Claude Code sessions are unaffected.`);
}

async function run(root) {
  const config = await loadConfig(root);
  assertValidConfig(config);
  const reviewer = await codexAvailable(root, 'review');
  if (!reviewer.ok) throw new Error('Codex native review command is unavailable. Run: dev-autopilot install-reviewer');
  if (config.planner?.enabled === true && !(await codexAvailable(root, 'exec')).ok) {
    throw new Error('Codex native exec command (planner) is unavailable. Run: dev-autopilot install-reviewer');
  }
  if (!(await codexSignedIn(root))) {
    console.log('Warning: codex login status reports that Codex is not signed in. Codex planning and review will fail until you run codex login.');
  }

  if (config.safety?.requireCleanStart !== false && (await isDirty(root))) {
    throw new Error('Working tree is dirty. Commit/stash/remove existing changes before starting a new Autopilot background task.');
  }

  const hash = await taskHash(root, config);
  const sessions = await listSessions(root, true);
  if (!sessions.ok) throw new Error(sessions.error);
  const record = await runtimeRecord(root);
  const prefix = config.claude?.sessionNamePrefix || 'autopilot';
  const lean = leanloopEnabled(config);
  const state = lean ? await stateForTask(root, hash) : null;
  if (lean && (await handleQuotaWait(root, config, hash, state))) return;
  const sameSession = sessions.sessions.find((session) => isBackground(session) && isCurrentTask(session, { prefix, record, taskHash: hash }));

  if (sameSession) {
    if (sameSession.state === 'working') {
      console.log(`Autopilot session ${sameSession.id} is already working.`);
      console.log(`View:   dev-autopilot agents "${root}"`);
      console.log(`Logs:   dev-autopilot logs ${sameSession.id} "${root}"`);
      console.log(`Attach: dev-autopilot attach ${sameSession.id} "${root}"`);
      if (lean) await recordMetric(root, { type: 'duplicate-start-avoided', task: hash, session: sameSession.id });
      return;
    }
    if (sameSession.state === 'blocked') {
      console.log(`Autopilot session ${sameSession.id} needs input (${sameSession.waitingFor || 'blocked'}).`);
      console.log(`Attach: dev-autopilot attach ${sameSession.id} "${root}"`);
      if (lean) await recordMetric(root, { type: 'duplicate-start-avoided', task: hash, session: sameSession.id });
      return;
    }
    if (sameSession.state === 'failed' || sameSession.state === 'stopped') {
      if (lean) {
        if (sameSession.state === 'failed' && (await quotaFromSessionLog(root, config, sameSession, hash))) return;
        console.log(`Continuing Autopilot session ${sameSession.id} for the unchanged task...`);
        describeReviewSetup(config);
        await continueSession(root, config, sameSession, { hash, state, reason: state?.waiting?.reason === 'quota' ? 'quota' : 'resume' });
        return;
      }
      console.log(`Respawning existing Autopilot session ${sameSession.id} for the unchanged task...`);
      describeReviewSetup(config);
      await writeSessionSettings(root, config);
      const result = await exec('claude', ['respawn', sameSession.id], { cwd: root, stream: true, timeoutMs: 30000 });
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Unable to respawn Claude session');
      return;
    }
    if (sameSession.state === 'done') {
      // A session that stopped at a quota blocker finished its turn; once the limit has reset it continues.
      if (lean && state?.waiting?.reason === 'quota') {
        console.log(`Continuing Autopilot session ${sameSession.id}, which stopped at a usage limit...`);
        await continueSession(root, config, sameSession, { hash, state, reason: 'quota' });
        return;
      }
      console.log(`The current task already has completed Autopilot session ${sameSession.id}.`);
      console.log('Merge/review its PR or update the task file before starting a new session.');
      console.log('Optional second opinion: in Claude Code on the PR branch, run /codex:adversarial-review --base <base> (official Codex plugin).');
      if (lean) await recordMetric(root, { type: 'duplicate-start-avoided', task: hash, session: sameSession.id });
      return;
    }
  }

  const live = sessions.sessions.find((session) => session.state === 'working' || session.state === 'blocked');
  if (live) {
    console.log(`A Claude background session is already active for this project: ${live.id} (${live.state}).`);
    console.log(`Attach: dev-autopilot attach ${live.id} "${root}"`);
    if (lean) await recordMetric(root, { type: 'duplicate-start-avoided', task: hash, session: live.id });
    return;
  }

  const branch = await currentBranch(root);
  const name = sessionName(prefix, hash);
  const capsule = lean ? await ensureCapsule(root, config, { runGit, version: VERSION }) : null;
  if (capsule) await pruneCapsules(root, hash);
  const prompt = launchPrompt(config, { capsulePath: capsule?.markdown });
  const settingsPath = await writeSessionSettings(root, config);

  console.log(`Launching Claude background Autopilot from branch: ${branch}`);
  console.log('Model policy: use the user-configured/default Claude model; no --model flag is passed.');
  describeReviewSetup(config);
  if (capsule) {
    const { rawBytes, capsuleBytes } = capsule.manifest;
    console.log(`Context Capsule (${capsule.reused ? 'reused, sources unchanged' : 'built'}): ${formatBytes(capsuleBytes)} in place of ${formatBytes(rawBytes)} of task, config and context files. ${capsule.markdown}`);
  }
  const result = await exec('claude', ['--bg', '--name', name, '--settings', settingsPath, prompt], {
    cwd: root,
    stream: true,
    timeoutMs: 60000,
  });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Claude background launch failed');

  const id = parseBackgroundId(`${result.stdout}\n${result.stderr}`);
  const launchedAt = clock().toISOString();
  await saveRuntimeRecord(root, {
    version: 2,
    id,
    sessionName: name,
    taskHash: hash,
    taskFile: config.project.taskFile,
    branchAtLaunch: branch,
    launchedAt,
  });
  if (capsule) {
    const context = await persistSessionContext(root, hash, capsule);
    // A new session starts the task afresh, so earlier check and review state doesn't carry over.
    await updateTaskState(root, hash, (previous) => ({
      version: previous.version,
      taskHash: hash,
      createdAt: previous.createdAt,
      taskFile: config.project.taskFile,
      status: 'working',
      session: { id, sessionId: null, name },
      branch,
      base: config.project.baseBranch || 'main',
      launchedAt,
      context,
    }), clock());
    await recordMetric(root, { type: 'capsule', task: hash, rawBytes: capsule.manifest.rawBytes, capsuleBytes: capsule.manifest.capsuleBytes, reused: capsule.reused });
  }

  console.log(id ? `Autopilot is running in Claude background session ${id}.` : 'Autopilot background session launched.');
  console.log(`Monitor: dev-autopilot status "${root}"`);
  console.log(`Agent UI: claude agents --cwd "${root}"`);
}

// Remembers exactly what context this session was given, so a later resume can send only what changed.
async function persistSessionContext(root, hash, capsule) {
  const manifest = runtimePath(root, 'context', `session-${taskKeyOf(hash)}.json`);
  await writeJson(manifest, capsule.manifest);
  return {
    fingerprint: capsule.manifest.fingerprint,
    capsule: capsule.markdown,
    manifest,
    capsuleBytes: capsule.manifest.capsuleBytes,
    rawBytes: capsule.manifest.rawBytes,
  };
}

function taskKeyOf(hash) {
  return hash ? hash.slice(0, 12) : 'no-task';
}

function unchangedRawBytes(manifest, changedPaths) {
  return Object.entries(manifest.sources || {})
    .filter(([file, source]) => source.status === 'ok' && ['task', 'config', 'context', 'instruction'].includes(source.role) && !changedPaths.includes(file))
    .reduce((total, [, source]) => total + (source.bytes || 0), 0);
}

// Continues an existing session of the current task with a short message instead of a full context reread:
// "unchanged" when every source hash matches what the session was given, "delta" with only the changed
// material when some changed, and "full" (read the capsule) when Autopilot has no record of what it read.
// Claude Code continues a stopped session under the same id when `--bg --resume <sessionId>` gets no other
// flags; a session that finished its turn is still running idle, so it is stopped first.
async function continueSession(root, config, session, { hash, state, reason = 'resume' }) {
  await writeSessionSettings(root, config);
  const capsule = await ensureCapsule(root, config, { runGit, version: VERSION });
  const previous = state?.context?.fingerprint && state.session && matchesRecord(session, state.session) ? state.context : null;
  let kind = !previous ? 'full' : previous.fingerprint === capsule.manifest.fingerprint ? 'unchanged' : 'delta';
  let deltaPath = null;
  let deltaBytes = 0;
  let changed = [];
  if (kind === 'delta') {
    const previousManifest = await readJson(previous.manifest, null).catch(() => null);
    if (!previousManifest) kind = 'full';
    else {
      const delta = renderDelta(previousManifest, capsule, config);
      // A new Autopilot version changes the fingerprint without changing any source; nothing needs rereading.
      if (!delta.changes.length) kind = 'unchanged';
      else {
        deltaPath = await writeDelta(root, hash, capsule.manifest.fingerprint, delta.markdown);
        deltaBytes = delta.bytes;
        changed = delta.changedPaths;
      }
    }
  }
  const prompt = resumePrompt({ kind, reason, config, taskHash: hash, fingerprint: capsule.manifest.fingerprint, capsulePath: capsule.markdown, deltaPath, changed, waiting: state?.waiting });

  // Without `--bg --resume` the session is respawned with no message. It is running again, so a quota wait is
  // over, but it was not given the delta: its recorded context stays as it was, and the next resume sends it.
  const respawnInstead = async (why) => {
    console.log(`${why} Respawning ${session.id} instead (the v0.4 behaviour).`);
    if (kind !== 'unchanged') console.log(`The context changed since the session read it: attach and ask it to read ${deltaPath || capsule.markdown}.`);
    const result = await exec('claude', ['respawn', session.id], { cwd: root, stream: true, timeoutMs: 30000 });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Unable to respawn Claude session');
    await updateTaskState(root, hash, (current) => ({
      ...current,
      status: 'working',
      lastResume: { at: clock().toISOString(), kind: 'respawn', reason },
      waiting: undefined,
      blocker: undefined,
    }), clock());
    await recordMetric(root, { type: 'resume', task: hash, kind: 'respawn', reason, promptBytes: 0, deltaBytes: 0, reusedBytes: 0 });
    return { id: session.id, kind: 'respawn' };
  };
  if (!session.sessionId) return respawnInstead('Claude Code did not report the full sessionId needed to send a resume message.');
  if (session.state === 'done') {
    const stopped = await exec('claude', ['stop', session.id], { cwd: root, timeoutMs: 30000 }).catch((error) => ({ code: 1, stderr: error.message }));
    if (stopped.code !== 0) throw new Error(`Could not stop the idle session ${session.id} before resuming it: ${(stopped.stderr || stopped.stdout || '').trim()}`);
  }
  const result = await exec('claude', ['--bg', '--resume', session.sessionId, prompt], { cwd: root, stream: true, timeoutMs: 60000 });
  if (result.code !== 0) {
    if (assessFailure(`${result.stdout}\n${result.stderr}`).kind === 'usage-error') return respawnInstead('This Claude Code version does not accept --bg --resume.');
    throw new Error(result.stderr || result.stdout || 'Unable to resume the Claude session');
  }
  const id = parseBackgroundId(`${result.stdout}\n${result.stderr}`) || session.id;
  if (id !== session.id) console.log(`Claude Code continued the conversation in a new background session ${id}.`);
  const previousRecord = await runtimeRecord(root);
  await saveRuntimeRecord(root, {
    ...(previousRecord?.taskHash === hash ? previousRecord : {}),
    version: 2,
    id,
    sessionName: id === session.id ? session.name || previousRecord?.sessionName : null,
    taskHash: hash,
    taskFile: config.project.taskFile,
    resumedAt: clock().toISOString(),
  });
  const context = await persistSessionContext(root, hash, capsule);
  await updateTaskState(root, hash, (current) => ({
    ...current,
    taskFile: config.project.taskFile,
    status: 'working',
    session: { id, sessionId: id === session.id ? session.sessionId : null, name: session.name || null },
    context,
    lastResume: { at: clock().toISOString(), kind, reason },
    waiting: undefined,
    blocker: undefined,
  }), clock());
  const reusedBytes = kind === 'full' ? 0 : unchangedRawBytes(capsule.manifest, changed);
  await recordMetric(root, { type: 'resume', task: hash, kind, reason, promptBytes: byteLength(prompt), deltaBytes, reusedBytes });
  const what = kind === 'unchanged'
    ? 'task and context unchanged, so only a short continuation message was sent'
    : kind === 'delta'
      ? `context changed (${changed.join(', ')}), so only the delta was sent (${formatBytes(deltaBytes)})`
      : 'no record of what it read, so it was pointed at the Context Capsule';
  console.log(`Resumed ${id}: ${what}.`);
  return { id, kind };
}

function when(iso) {
  if (!iso) return 'unknown';
  const date = new Date(iso);
  const local = new Intl.DateTimeFormat('en-CA', { dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }).format(date);
  return `${iso.slice(0, 16).replace('T', ' ')} UTC (${local} local)`;
}

// Records that the task stopped on an exhausted usage limit. With quota.autoResume on and a stated reset time,
// it also writes a resume ticket and starts the detached helper. Returns the lines to show.
async function recordQuotaWait(root, config, { hash, provider, verdict, step, session = null }) {
  const options = quotaOptions(config);
  const now = clock();
  const state = await stateForTask(root, hash);
  const who = provider === 'claude' ? 'Claude' : 'Codex';
  const future = verdict.resetAt && !verdict.inPast;
  const resumeAt = future ? resumeAtFor(verdict.resetAt, options.graceMinutes) : null;
  const target = session ? { id: session.id, sessionId: session.sessionId, name: session.name } : state?.session || null;
  const lines = [`QUOTA EXHAUSTED (${who}): ${verdict.evidence}`];
  let ticket = null;
  if (!verdict.resetAt) {
    lines.push(`quota exhausted; reset time unavailable for automatic scheduling (${verdict.reason}).`);
  } else {
    lines.push(`Stated reset: ${when(verdict.resetAt.toISOString())} (${verdict.source}).`);
    if (options.autoResume && future && target?.id) {
      ticket = newTicket({ root, taskHash: hash, taskFile: config.project?.taskFile, session: target, provider, reason: `${who} usage limit`, resetAt: verdict.resetAt, resumeAt, evidence: verdict.evidence, now });
      await writeTicket(root, ticket);
      ticket = await armHelper(root, ticket);
      lines.push(`waiting-quota — resume scheduled ${when(ticket.resumeAt)} (reset + ${options.graceMinutes} min). Cancel with dev-autopilot stop ${target.id}.`);
    } else if (options.autoResume && future) {
      lines.push('Automatic resume needs the session identity, which Autopilot has no record of; run dev-autopilot run after the reset.');
    } else if (future) {
      lines.push(`Automatic resume is off (quota.autoResume). Run dev-autopilot run after ${when(resumeAt.toISOString())}.`);
    }
  }
  lines.push('Stop here and report the quota blocker; do not retry.');
  await patchTaskState(root, hash, (current) => ({
    ...current,
    waiting: {
      reason: 'quota',
      provider,
      step,
      since: now.toISOString(),
      resetAt: verdict.resetAt ? verdict.resetAt.toISOString() : null,
      resumeAt: resumeAt ? resumeAt.toISOString() : null,
      ticketId: ticket?.id || null,
      detail: verdict.source || verdict.reason || null,
    },
  }));
  await recordMetric(root, { type: 'quota', task: hash, provider, resetKnown: Boolean(verdict.resetAt), scheduled: Boolean(ticket) });
  return lines;
}

async function armHelper(root, ticket) {
  const pid = launchHelper(root, ticket);
  const armed = { ...ticket, helper: { pid: pid || null, startedAt: clock().toISOString() } };
  await writeTicket(root, armed);
  return armed;
}

// A failed session may have stopped at the Claude usage limit. Its own recent output is the only reliable source
// for that, so the last lines of `claude logs` are classified; nothing is guessed. Returns true when the task
// should wait for a stated reset time instead of being resumed now.
async function quotaFromSessionLog(root, config, session, hash) {
  const logs = await exec('claude', ['logs', session.id], { cwd: root, timeoutMs: 30000 }).catch(() => null);
  if (!logs || logs.code !== 0) return false;
  const recent = stripAnsi(`${logs.stdout || ''}\n${logs.stderr || ''}`).split('\n').filter((line) => line.trim()).slice(-20).join('\n');
  const verdict = assessFailure(recent, { now: clock() });
  if (verdict.kind !== 'quota') return false;
  if (!verdict.resetAt || verdict.inPast) {
    if (!verdict.resetAt) console.log(`Session ${session.id} reports an exhausted Claude usage limit, and ${verdict.reason}. Resuming because you ran dev-autopilot run; it stops again if the limit is still exhausted.`);
    return false;
  }
  for (const line of await recordQuotaWait(root, config, { hash, provider: 'claude', verdict, step: 'the interrupted work', session })) console.log(line);
  console.log(`To resume now anyway: dev-autopilot resume ${session.id} "${root}"`);
  return true;
}

// Returns true when the current task is waiting for a usage-limit reset (after saying so), or was resumed from
// a due ticket. A ticket of an earlier task is cancelled.
async function handleQuotaWait(root, config, hash, state) {
  const ticket = await readTicket(root);
  if (ticket?.status === 'pending') {
    if (ticket.taskHash !== hash) {
      await closeTicket(root, ticket, 'cancelled', 'the task file changed', clock());
      console.log('Cancelled a scheduled quota auto-resume that belonged to an earlier task.');
    } else if (!isDue(ticket, clock())) {
      await ensureHelper(root, ticket);
      console.log(`waiting-quota — resume scheduled ${when(ticket.resumeAt)}. The ${ticket.provider} limit resets ${when(ticket.resetAt)}.`);
      console.log(`Cancel: dev-autopilot stop ${ticket.session?.id || '<id>'} "${root}"   Resume now: dev-autopilot resume ${ticket.session?.id || '<id>'} "${root}"`);
      return true;
    } else {
      const result = await resumeFromTicket(root, { ticketId: ticket.id, source: 'run' });
      console.log(result.message);
      return result.status === 'resumed' || result.status === 'busy';
    }
  }
  const waiting = state?.waiting;
  if (waiting?.reason === 'quota' && waiting.resumeAt && new Date(waiting.resumeAt) > clock()) {
    console.log(`waiting-quota — the ${waiting.provider} usage limit resets ${when(waiting.resetAt)}; automatic resume is off (quota.autoResume). Run dev-autopilot run again after ${when(waiting.resumeAt)}.`);
    const id = state.session?.id;
    if (id) console.log(`To resume now anyway: dev-autopilot resume ${id} "${root}"`);
    return true;
  }
  return false;
}

// Keeps a pending ticket's helper alive: after a reboot or a killed helper, the next command starts it again
// (it resumes at once when the ticket is already due).
async function ensureHelper(root, ticket) {
  if (processAlive(ticket.helper?.pid)) return ticket;
  return armHelper(root, ticket);
}

// The checked resume path for a quota ticket, shared by the detached helper and `run`. It resumes only if the
// ticket still describes the project's current task and that task is still waiting on this reset.
export async function resumeFromTicket(root, { ticketId = null, source = 'helper' } = {}) {
  const release = await acquireLock(root, clock());
  if (!release) return { status: 'busy', message: 'Another quota resume for this project is in progress.' };
  let ticket = null;
  const cancel = async (why, status = 'cancelled') => {
    await closeTicket(root, ticket, status, why, clock());
    const config = await loadConfig(root).catch(() => null);
    if (config) {
      const hash = await currentTaskHash(root, config);
      const state = await stateForTask(root, hash);
      if (state?.waiting?.ticketId === ticket.id) await updateTaskState(root, hash, (current) => ({ ...current, waiting: undefined }), clock());
    }
    return { status, message: `Quota auto-resume ${status}: ${why}.` };
  };
  try {
    ticket = await readTicket(root);
    if (!ticket || ticket.status !== 'pending' || (ticketId && ticket.id !== ticketId)) return { status: 'none', message: 'No pending quota resume.' };
    if (!(await sameFolder(ticket.projectRoot, root))) return await cancel('the ticket belongs to another project folder');
    const now = clock();
    if (!isDue(ticket, now)) return { status: 'not-due', message: `Not due until ${when(ticket.resumeAt)}.` };
    if (isExpired(ticket, now)) return await cancel('it is more than 3 days past its resume time', 'expired');
    const config = await loadConfig(root).catch(() => null);
    if (!config) return await cancel(`${CONFIG_FILE} is missing or unreadable`);
    if (!leanloopEnabled(config) || !quotaOptions(config).autoResume) return await cancel('quota.autoResume is off');
    const hash = await currentTaskHash(root, config);
    if (hash !== ticket.taskHash) return await cancel('the task file changed, so a different task is current');
    const state = await stateForTask(root, hash);
    if (!state || state.waiting?.ticketId !== ticket.id) return await cancel('the task is no longer waiting for this reset');
    if (['ready', 'complete', 'stopped'].includes(state.status)) return await cancel(`the task is ${state.status}`);
    const sessions = await listSessions(root, true);
    if (!sessions.ok) return { status: 'retry', message: `Could not list Claude sessions (${sessions.error}); the ticket stays pending and the next dev-autopilot command retries.` };
    const session = sessions.sessions.find((item) => isBackground(item) && matchesRecord(item, ticket.session));
    if (!session) return await cancel(`session ${ticket.session?.id} no longer exists`);
    const prefix = config.claude?.sessionNamePrefix || 'autopilot';
    if (!isCurrentTask(session, { prefix, record: await runtimeRecord(root), taskHash: hash }) && !matchesRecord(session, state.session || {})) {
      return await cancel(`session ${session.id} belongs to another task`);
    }
    if (session.state === 'working' || session.state === 'blocked') return await cancel(`session ${session.id} is already ${session.state}`);
    const other = sessions.sessions.find((item) => item !== session && (item.state === 'working' || item.state === 'blocked'));
    if (other) return await cancel(`another session (${other.id}) is active in this project`);
    const resumed = await continueSession(root, config, session, { hash, state, reason: 'quota' });
    await closeTicket(root, ticket, 'done', `resumed by ${source}`, clock());
    return { status: 'resumed', message: `Quota auto-resume: continued session ${resumed?.id || session.id}.` };
  } catch (error) {
    if (ticket) await closeTicket(root, ticket, 'failed', error.message, clock()).catch(() => {});
    return { status: 'failed', message: `Quota auto-resume failed: ${error.message}` };
  } finally {
    await release();
  }
}

// Runs at the start of other commands: re-arms a pending ticket's helper, and cancels a ticket whose task has
// changed or whose auto-resume was switched off. Its notices go to stderr, so JSON output such as status stays clean.
async function maintainTicket(root) {
  const ticket = await readTicket(root);
  if (!ticket || ticket.status !== 'pending') return;
  const config = await loadConfig(root).catch(() => null);
  if (!config) return;
  const hash = await currentTaskHash(root, config);
  if (hash !== ticket.taskHash) {
    await closeTicket(root, ticket, 'cancelled', 'the task file changed', clock());
    console.error('Cancelled a scheduled quota auto-resume: the task file changed.');
    return;
  }
  if (!leanloopEnabled(config) || !quotaOptions(config).autoResume) {
    await closeTicket(root, ticket, 'cancelled', 'quota.autoResume is off', clock());
    console.error('Cancelled a scheduled quota auto-resume: quota.autoResume is off.');
    return;
  }
  if (isExpired(ticket, clock())) {
    await closeTicket(root, ticket, 'expired', 'more than 3 days past its resume time', clock());
    return;
  }
  if (!processAlive(ticket.helper?.pid)) {
    await armHelper(root, ticket);
    console.error(isDue(ticket, clock())
      ? 'A scheduled quota auto-resume is due; its helper was not running, so it was restarted and resumes now.'
      : `Restarted the quota auto-resume helper (resume scheduled ${when(ticket.resumeAt)}).`);
  }
}

async function sessionContext(root, config) {
  return {
    prefix: config.claude?.sessionNamePrefix || 'autopilot',
    record: await runtimeRecord(root),
    taskHash: await currentTaskHash(root, config),
  };
}

// The task's compact orchestration state as status shows it.
function describeTask(state, ticket) {
  if (!state) return null;
  let phase = state.status || (state.session ? 'working' : 'no Autopilot session launched yet');
  const waiting = state.waiting;
  if (ticket?.status === 'pending' && ticket.taskHash === state.taskHash) phase = `waiting-quota — resume scheduled ${when(ticket.resumeAt)}`;
  else if (waiting?.reason === 'quota') {
    phase = waiting.resetAt
      ? `waiting-quota — ${waiting.provider} limit resets ${when(waiting.resetAt)}; auto-resume off`
      : 'waiting-quota — quota exhausted; reset time unavailable for automatic scheduling';
  } else if (state.blocker) phase = `blocked — ${state.blocker}`;
  const checks = state.checks;
  const review = state.review;
  return {
    state: phase,
    session: state.session?.id || null,
    context: state.context ? `fingerprint ${short(state.context.fingerprint)}, capsule ${formatBytes(state.context.capsuleBytes || 0)} for ${formatBytes(state.context.rawBytes || 0)}` : null,
    checks: checks ? `${checks.status}: ${checks.passed}/${checks.total} passed at ${checks.at}` : null,
    review: review ? `${review.kind}: ${review.rounds || 0} of ${review.budget} round(s) used (max ${review.maxRounds})` : null,
    pr: state.pr ?? null,
    ci: state.ci ?? null,
  };
}

async function status(root) {
  const config = await loadConfig(root);
  await maintainTicket(root);
  const result = await listSessions(root, true);
  if (!result.ok) throw new Error(result.error);
  const context = await sessionContext(root, config);
  const sessions = result.sessions.filter(isBackground).map((session) => ({ ...session, autopilot: classifySession(session, context) }));
  const task = leanloopEnabled(config) ? describeTask(await stateForTask(root, context.taskHash), await readTicket(root)) : null;
  console.log(JSON.stringify({
    root,
    currentTask: { file: config.project.taskFile, hash: context.taskHash ? context.taskHash.slice(0, 12) : null },
    ...(task ? { task } : {}),
    lastAutopilotSession: context.record,
    sessions,
    interactiveSessions: result.sessions.length - sessions.length,
    help: [
      'Pass a session\'s "id" to attach, logs, stop or resume; its full "sessionId" works too.',
      'autopilot.lifecycle: "active" is working or waiting for you, "current" finished the task in the task file, "stale" finished an earlier task.',
      'Finished sessions stay listed in Claude\'s agent view until removed. dev-autopilot cleanup shows which ones can go.',
    ],
  }, null, 2));
}

async function agents(root) {
  await loadConfig(root);
  await maintainTicket(root);
  const result = await exec('claude', ['agents', '--cwd', root], { cwd: root, stdin: 'inherit' });
  if (result.code !== 0) process.exitCode = result.code;
}

// Accepts a short id, a full sessionId or a session name, and passes Claude the short id it expects.
async function resolveSessionId(ident, root) {
  const listing = await listSessions(root, true, { global: true });
  if (!listing.ok) {
    console.log(`Could not list Claude sessions (${listing.error}); passing "${ident}" to Claude unchanged.`);
    return { id: ident, session: null };
  }
  const found = findSession(listing.sessions, ident);
  if (found.error) throw new Error(found.error);
  if (found.session.id !== ident) console.log(`Using background session id ${found.session.id} for "${ident}".`);
  return { id: found.session.id, session: found.session };
}

// `stop` and a manual `resume` both supersede a scheduled quota resume of the same task or session.
async function cancelTicketFor(root, ident, session, why) {
  const ticket = await readTicket(root);
  if (!ticket || ticket.status !== 'pending') return false;
  const wanted = String(ident || '').toLowerCase();
  let matches = [ticket.session?.id, ticket.session?.sessionId, ticket.session?.name].filter(Boolean).some((value) => value.toLowerCase() === wanted);
  if (!matches && session) matches = matchesRecord(session, ticket.session);
  if (!matches && session) {
    const config = await loadConfig(root).catch(() => null);
    if (config) matches = isCurrentTask(session, { prefix: config.claude?.sessionNamePrefix || 'autopilot', record: await runtimeRecord(root), taskHash: ticket.taskHash });
  }
  if (!matches) return false;
  await closeTicket(root, ticket, 'cancelled', why, clock());
  await patchTaskState(root, ticket.taskHash, (current) => ({ ...current, waiting: undefined }));
  console.log(`Cancelled the scheduled quota auto-resume for this task (${why}).`);
  return true;
}

async function sessionCommand(command, ident, root, interactive = false) {
  if (!ident) throw new Error(`Missing session id for ${command}. Use the "id" value from dev-autopilot status.`);
  if (command === 'stop' && (await cancelTicketFor(root, ident, null, 'stopped with dev-autopilot stop'))) {
    const listing = await listSessions(root, true, { global: true });
    if (listing.ok && findSession(listing.sessions, ident).error) return; // the session itself is already gone
  }
  if (command !== 'stop' && command !== 'respawn') await maintainTicket(root);
  const { id, session } = await resolveSessionId(ident, root);
  const config = session ? await loadConfig(root).catch(() => null) : null;
  const context = config ? await sessionContext(root, config) : null;
  const info = context ? classifySession(session, context) : null;
  if (command === 'stop' && session) {
    await cancelTicketFor(root, ident, session, 'stopped with dev-autopilot stop');
    if (info?.owned && info.current && leanloopEnabled(config)) await patchTaskState(root, context.taskHash, (current) => ({ ...current, status: 'stopped', waiting: undefined }));
  }
  if (command === 'respawn' && session) {
    await cancelTicketFor(root, ident, session, 'resumed by hand');
    if (info?.owned) {
      describeReviewSetup(config);
      // An Autopilot session of the current task continues with a LeanLoop resume message.
      if (leanloopEnabled(config) && info.current && ['stopped', 'failed', 'done'].includes(session.state)) {
        const state = await stateForTask(root, context.taskHash);
        await continueSession(root, config, session, { hash: context.taskHash, state, reason: state?.waiting?.reason === 'quota' ? 'quota' : 'resume' });
        return;
      }
      // Refresh the session's Autopilot settings so a respawned session gets this version's permissions.
      await writeSessionSettings(root, config);
    }
  }
  // Claude's output is streamed straight to the terminal, so it isn't printed again here.
  const result = await exec('claude', [command, id], { cwd: root, stream: !interactive, stdin: interactive ? 'inherit' : 'pipe', timeoutMs: interactive ? 0 : 60000 });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || `claude ${command} failed`);
}

// Removes finished Autopilot sessions of earlier tasks with `claude rm <id>`, which keeps the transcript and
// refuses to delete a worktree holding uncommitted changes or unpushed commits. Nothing is removed without --apply.
async function cleanup(root, { apply = false } = {}) {
  const config = await loadConfig(root);
  await maintainTicket(root);
  const listing = await listSessions(root, true);
  if (!listing.ok) throw new Error(`Could not list Claude sessions, so nothing was removed: ${listing.error}`);
  const { remove, keep } = planCleanup(listing.sessions, await sessionContext(root, config));

  for (const { session, reason } of keep) console.log(`keep          ${session.id}  ${session.name || ''}  (${reason})`);
  for (const { session, reason } of remove) console.log(`${apply ? 'remove      ' : 'would remove'}  ${session.id}  ${session.name || ''}  (${reason})`);
  if (!remove.length) {
    console.log('Nothing to clean up.');
    return;
  }
  if (!apply) {
    console.log('\nDry run: nothing was removed. Run dev-autopilot cleanup --apply to remove these sessions with claude rm.');
    console.log('Claude keeps each transcript (claude --resume), and keeps any worktree with uncommitted changes or unpushed commits.');
    return;
  }

  let kept = 0;
  for (const { session } of remove) {
    const result = await exec('claude', ['rm', session.id], { cwd: root, timeoutMs: 60000 }).catch((error) => ({ code: 1, stderr: error.message }));
    const message = (result.stdout || result.stderr || '').trim();
    if (result.code === 0) {
      console.log(message || `Removed ${session.id}.`);
    } else {
      kept += 1;
      console.log(`Claude kept ${session.id}: ${message || `claude rm exited with ${result.code}`}`);
    }
  }
  if (kept) process.exitCode = 1;
}

// ---------------------------------------------------------------- LeanLoop commands

// Updates this task's record, but never replaces another task's record: a worktree can hold a different task file.
async function patchTaskState(root, hash, patch) {
  if (!hash) return null;
  const existing = await readTaskState(root);
  if (existing && existing.taskHash !== hash) return null;
  return updateTaskState(root, hash, patch, clock());
}

// Where a LeanLoop helper runs (the checkout, possibly a Claude worktree), where state is kept, and the task.
async function leanContext(start) {
  const { workRoot, stateRoot } = await resolveRoots(start, runGit);
  let config;
  try {
    config = await loadConfig(workRoot);
  } catch (error) {
    if (samePath(workRoot, stateRoot)) throw error;
    config = await loadConfig(stateRoot);
  }
  return { workRoot, stateRoot, config, hash: await currentTaskHash(workRoot, config) };
}

async function check(start, flags) {
  const { workRoot, stateRoot, config, hash } = await leanContext(start);
  const problems = checkProblems(config);
  if (problems.length) throw new Error(`Fix ${CONFIG_FILE}:\n- ${problems.join('\n- ')}`);
  if (flags.log) {
    const log = await latestLog({ stateRoot, config, taskHash: hash, check: flags.log });
    process.stdout.write(`--- ${log.name}: ${log.status}, ${log.file} ---\n${stripAnsi(log.text).trimEnd()}\n`);
    return;
  }
  const outcome = await runChecks({ workRoot, stateRoot, config, taskHash: hash, only: flags.only, bail: flags.bail === true, force: flags.force === true, now: clock, runGit });
  process.stdout.write(outcome.output);
  if (!outcome.checksConfigured) return;
  for (const result of outcome.results) {
    await recordMetric(stateRoot, { type: 'check', task: hash, name: result.name, status: result.status, logBytes: result.logBytes || 0, compactBytes: result.compactBytes || 0 });
  }
  const passed = outcome.results.filter((result) => result.status === 'pass' || result.status === 'reused').length;
  await patchTaskState(stateRoot, hash, (current) => ({
    ...current,
    checks: { status: outcome.status, passed, total: outcome.results.length, runId: outcome.runId, at: `${clock().toISOString().slice(0, 19).replace('T', ' ')} UTC` },
  }));
  if (outcome.status === 'fail') process.exitCode = 1;
}

async function budgetFor(workRoot, stateRoot, config, hash) {
  const base = config.project?.baseBranch || 'main';
  const diff = await collectDiff(workRoot, base, runGit);
  const classification = classifyChange(diff.files, config);
  const state = await stateForTask(stateRoot, hash);
  const previous = state?.review?.kind ? { kind: state.review.kind, rounds: state.review.budget } : null;
  return { base, diff, budget: reviewBudget(classification, config, previous), used: state?.review?.rounds || 0 };
}

async function codexCommand(sub, start, flags) {
  if (sub !== 'plan' && sub !== 'review') throw new Error('Usage: dev-autopilot codex plan|review [path]. Run dev-autopilot --help for details.');
  const { workRoot, stateRoot, config, hash } = await leanContext(start);
  assertValidConfig(config);
  const deps = {
    exec,
    now: clock,
    sleep,
    assess: assessFailure,
    record: (event) => recordMetric(stateRoot, { task: hash, ...event }),
    onQuota: (verdict, step) => recordQuotaWait(stateRoot, config, { hash, provider: 'codex', verdict, step }),
  };
  let outcome;
  if (sub === 'plan') {
    const state = await stateForTask(stateRoot, hash);
    let capsule = { path: null, fingerprint: null };
    if (state?.context?.capsule) capsule = { path: state.context.capsule, fingerprint: state.context.fingerprint };
    else if (leanloopEnabled(config)) {
      const built = await ensureCapsule(workRoot, config, { runGit, version: VERSION });
      capsule = { path: built.markdown, fingerprint: built.manifest.fingerprint };
    }
    outcome = await codexPlan(deps, { workRoot, stateRoot, config, taskHash: hash, fingerprint: capsule.fingerprint, capsulePath: capsule.path, note: flags.note, force: flags.force === true });
  } else {
    const { base, budget, used } = await budgetFor(workRoot, stateRoot, config, hash);
    await patchTaskState(stateRoot, hash, (current) => ({
      ...current,
      review: { ...(current.review || {}), kind: budget.kind, budget: budget.rounds, maxRounds: budget.maxRounds, rounds: current.review?.rounds || 0 },
    }));
    const saveRound = (round) => patchTaskState(stateRoot, hash, (current) => ({ ...current, review: { ...(current.review || {}), rounds: round, lastRoundAt: clock().toISOString() } }));
    outcome = await codexReview({ ...deps, saveRound }, { workRoot, stateRoot, config, taskHash: hash, base, budget, used });
  }
  process.stdout.write(outcome.output);
  if (outcome.code) process.exitCode = outcome.code;
}

async function reviewBudgetCommand(start, flags) {
  const { workRoot, stateRoot, config, hash } = await leanContext(start);
  const { diff, budget, used } = await budgetFor(workRoot, stateRoot, config, hash);
  const report = {
    base: diff.base,
    mergeBase: diff.mergeBase.slice(0, 12),
    kind: budget.kind,
    rounds: budget.rounds,
    used,
    maxRounds: budget.maxRounds,
    adaptive: budget.adaptive,
    files: budget.files,
    changedLines: budget.lines,
    reasons: budget.reasons,
    ...(budget.keptFrom ? { keptFrom: budget.keptFrom } : {}),
  };
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Review budget: ${budget.rounds} round(s) for a ${budget.kind} change (${used} used, max ${budget.maxRounds}${budget.adaptive ? '' : '; adaptive review is off'}).`);
  console.log(`${budget.files} file(s), ${budget.lines} changed line(s) against ${diff.base}.${budget.keptFrom ? ` Kept at the earlier ${budget.keptFrom} budget: a budget never shrinks within a task.` : ''}`);
  for (const reason of budget.reasons.slice(0, 8)) console.log(`- ${reason}`);
  if (budget.reasons.length > 8) console.log(`- …and ${budget.reasons.length - 8} more`);
}

async function capsuleCommand(root, flags) {
  const config = await loadConfig(root);
  const capsule = await ensureCapsule(root, config, { runGit, version: VERSION });
  if (flags.print) {
    process.stdout.write(await fs.readFile(capsule.markdown, 'utf8'));
    return;
  }
  const { rawBytes, capsuleBytes, fingerprint } = capsule.manifest;
  console.log(`Context Capsule (${capsule.reused ? 'reused: every source hash unchanged' : 'built'}): ${formatBytes(capsuleBytes)} in place of ${formatBytes(rawBytes)} of task, config and context files. Fingerprint ${short(fingerprint)}.`);
  console.log(capsule.markdown);
}

const STATE_VALUES = { ci: ['pending', 'passing', 'failing', 'none'], status: ['working', 'ready', 'blocked', 'complete'] };

async function stateCommand(start, flags) {
  const { stateRoot, config, hash } = await leanContext(start);
  if (!hash) throw new Error(`Task file not found: ${config.project.taskFile}`);
  const patch = {};
  if (flags.pr !== undefined) {
    if (!/^\d+$/.test(flags.pr)) throw new Error('--pr takes a pull-request number.');
    patch.pr = Number(flags.pr);
  }
  for (const key of ['ci', 'status']) {
    if (flags[key] === undefined) continue;
    if (!STATE_VALUES[key].includes(flags[key])) throw new Error(`--${key} must be one of: ${STATE_VALUES[key].join(', ')}.`);
    patch[key] = flags[key] === 'none' ? undefined : flags[key];
  }
  if (flags.blocker !== undefined) patch.blocker = String(flags.blocker).replace(/\s+/g, ' ').trim().slice(0, 300) || undefined;
  if (flags['clear-blocker']) patch.blocker = undefined;
  if (Object.keys(patch).length) {
    const updated = await patchTaskState(stateRoot, hash, (current) => ({ ...current, ...patch }));
    if (!updated) throw new Error('The recorded task state belongs to a different task file, so nothing was recorded.');
    console.log(`Recorded ${Object.entries(patch).map(([key, value]) => `${key}=${value ?? '(cleared)'}`).join(', ')}.`);
    return;
  }
  const state = await stateForTask(stateRoot, hash);
  const view = describeTask(state, await readTicket(stateRoot)) || { state: 'no Autopilot record for this task yet' };
  console.log(JSON.stringify({ task: short(hash), ...view, ...(state?.blocker ? { blocker: state.blocker } : {}) }, null, 2));
}

async function efficiencyCommand(root, flags) {
  const config = await loadConfig(root);
  await maintainTicket(root);
  const hash = flags.task ? await currentTaskHash(root, config) : null;
  const summary = summarize(await readEvents(root), { taskHash: hash });
  console.log(flags.json ? JSON.stringify(summary, null, 2) : formatReport(summary));
}

export async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '-h' || command === '--help') return usage();
  if (command === '-v' || command === '--version') return console.log(VERSION);

  const { flags, positionals } = parseCommandArgs(command, rest);

  if (command === 'install-reviewer') return installReviewer(process.cwd(), { installPlugin: flags['install-plugin'] === true });

  if (command === 'attach' || command === 'logs' || command === 'stop' || command === 'resume') {
    const root = await rootFrom(positionals[1]);
    const mapped = command === 'resume' ? 'respawn' : command;
    return sessionCommand(mapped, positionals[0], root, command === 'attach');
  }

  if (command === 'codex') return codexCommand(positionals[0], await rootFrom(positionals[1]), flags);

  const root = await rootFrom(positionals[0]);

  if (command === 'init') return init(root);
  if (command === 'upgrade') return upgrade(root);
  if (command === 'migrate-v1') return migrateV1(root);
  if (command === 'doctor') return doctor(root);
  if (command === 'run') return run(root);
  if (command === 'status') return status(root);
  if (command === 'agents') return agents(root);
  if (command === 'cleanup') return cleanup(root, { apply: flags.apply === true });
  if (command === 'check') return check(root, flags);
  if (command === 'review-budget') return reviewBudgetCommand(root, flags);
  if (command === 'capsule') return capsuleCommand(root, flags);
  if (command === 'state') return stateCommand(root, flags);
  if (command === 'efficiency') return efficiencyCommand(root, flags);

  usage();
  process.exitCode = 2;
}

export {
  buildConfig,
  configProblems,
  installReviewer,
  launchPrompt,
  legacyLaunchPrompt,
  resumePrompt,
  ruleText,
  runtimeRecord,
  saveRuntimeRecord,
  sessionSettings,
  upgrade,
  VERSION,
};
