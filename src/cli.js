import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import {
  appendGitignore,
  currentBranch,
  exists,
  isDirty,
  normalizePathForCompare,
  parseBackgroundId,
  readJson,
  runProcess,
  sha256,
  slugify,
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
import { classifySession, findSession, isBackground, isCurrentTask, planCleanup, sessionName } from './sessions.js';

const { version: VERSION } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const CONFIG_FILE = '.autopilot/config.json';
const RUNTIME_DIR = '.autopilot/runtime';
const LAST_SESSION_FILE = '.autopilot/runtime/last-session.json';
const CLAUDE_RULE_FILE = '.claude/rules/dev-autopilot.md';
const CLAUDE_WORKTREES_DIR = '.claude/worktrees';
const DEFAULT_MAX_ROUNDS = 3;

// Every external command goes through this runner; tests swap in a fake with setProcessRunner().
let exec = runProcess;

export function setProcessRunner(runner) {
  exec = runner || runProcess;
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

Models are intentionally NOT pinned. Claude and Codex use your configured/default models.`);
}

const COMMAND_OPTIONS = {
  cleanup: { apply: { type: 'boolean' } },
  'install-reviewer': { 'install-plugin': { type: 'boolean' } },
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
    },
    codexPlugin: {
      loadInAutopilotSessions: false,
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

This repository uses a two-agent workflow. The thin local \`dev-autopilot\` launcher only starts Claude Code background sessions; it does not implement its own agent loop.

- **Codex CLI is the architect and reviewer.** It plans the task before code is written and reviews the branch before it is finalized. Codex never edits files.
- **Claude Code is the developer.** It owns implementation, tests, Git, the pull request and CI.

## Start of every Autopilot task

1. Read \`.autopilot/config.json\`.
2. Read the configured task file and relevant context files.
3. Respect all existing repository instructions, especially \`CLAUDE.md\` and \`AGENTS.md\`.
4. Stay within the stated task/phase scope. Make reasonable engineering decisions that do not change product scope.
5. Do not change model selection. Do not invoke \`/model\`, do not request a Claude model override, and do not pass \`--model\` or model config overrides to Codex. Use the user's configured/default models.

## Plan with Codex (architect)

Do this step only when \`planner.enabled\` is \`true\` in \`.autopilot/config.json\`.

- Before writing code, ask Codex for an architecture and implementation plan using the native Codex CLI in a read-only sandbox: \`codex exec --sandbox read-only "<planning prompt>" < /dev/null\`.
- The planning prompt must tell Codex to read the task file and the configured context files, inspect the relevant code, and return a concise plan: approach, files/modules to change, interfaces and data shapes, risks and edge cases, a test plan, and ordered implementation steps. Tell Codex not to write code or edit files.
- Do not add \`--model\`; Codex must use the user's configured/default model.
- Check the plan against the task and the repository rules, then implement it. You own the final decisions: if you deviate from the plan, say why in the pull request.
- Add a short "Plan (Codex)" summary to the pull-request description.

## Implementation loop (Claude)

- Implement the current task end-to-end.
- Run the deterministic checks listed in \`.autopilot/config.json\`.
- Repair check failures when they are caused by the task.

## Review with Codex (reviewer)

- Before finalizing, run a FRESH independent Codex review with the native Codex CLI. This is Autopilot's automated reviewer.
- Review the current task branch against the configured base branch with: \`codex review --base <baseBranch> < /dev/null\`.
- Do not add \`--model\`; Codex must use the user's configured/default model.
- Treat Codex as a reviewer only. Do not ask Codex to edit files.
- Each \`codex review\` run is one round. Fix actionable findings, rerun the relevant deterministic checks, and start a new round when needed. Never run more than \`reviewer.maxRounds\` rounds: if findings remain after the last round, stop and report them as a blocker instead of looping.
- Add a short "Review (Codex)" summary to the pull-request description: rounds run, what was fixed, and anything you deliberately left unchanged and why.

## When Codex fails

If a \`codex exec\` or \`codex review\` command fails (for example: not signed in, usage limit or credits exhausted, network error), retry it once. If it fails again, stop and report the Codex error as a blocker. Never replace Codex's plan or review with your own, and never describe work as reviewed by Codex when the review did not complete.

## Official Codex plugin (codex-plugin-cc)

OpenAI's Codex plugin for Claude Code may be installed on this machine. It is for the human's own, manual reviews, and Autopilot normally switches it off inside its background sessions. In an Autopilot session:

- Do not use \`/codex:rescue\` or the \`codex:codex-rescue\` subagent. Codex must not write code here.
- Do not run \`/codex:setup\` and do not change the plugin's review gate.
- Do not try to run \`/codex:review\` or \`/codex:adversarial-review\` yourself. They are user-invoked commands; the native \`codex review\` above is the automated reviewer.

## Git and GitHub

- Work on a non-base branch. Claude Code background-session worktree isolation may create/manage that branch automatically.
- You may commit and push the task branch and create/update a pull request.
- Never force-push protected/base branches.
- Never merge the pull request.
- After opening the PR, watch CI. If CI fails for task-related reasons, fix it, rerun checks, push, and re-check CI.
- Finish when the PR is ready for human review/merge or a genuine human gate is reached.

## Human gates

Stop and clearly report the gate instead of guessing when the work requires any item listed under \`safety.humanGates\` in \`.autopilot/config.json\`. This includes production/store actions, purchases, identity/2FA, legal/financial actions, production secrets, destructive production changes, DNS changes, and physical-device validation.

## Agent boundaries

Codex plans and reviews; it is not the writer. Use \`codex exec --sandbox read-only\` for planning and \`codex review\` for review. Claude owns implementation and decides how to act on Codex's plan and findings while respecting repository policy and the task.
`;
}

function launchPrompt(config) {
  const plan = config.planner?.enabled === true
    ? ' Start by getting an architecture and implementation plan from Codex (codex exec --sandbox read-only), then implement it.'
    : '';
  const reviewer = reviewerSummary(config);
  return `Read ${CLAUDE_RULE_FILE}, ${CONFIG_FILE}, ${config.project.taskFile}, and the configured project context files. Execute the current task end-to-end under the Autopilot workflow.${plan} Before finalizing, review the branch with the native Codex CLI reviewer (${reviewer.command}), at most ${reviewer.maxRounds} rounds; if Codex fails, stop and report it instead of reviewing the work yourself. Open/update the task PR, wait for CI, and stop before merge or any human gate.`;
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
  const settings = {
    permissions: {
      defaultMode: 'dontAsk',
      allow: config.claude?.allowedTools || COMMON_ALLOWED_TOOLS,
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

  const warnings = [];
  if (!codexAuthenticated) warnings.push('Codex CLI is not signed in. Run: codex login');
  // Warn on the opt-in itself: detection can fail, and the gate state can't be read either way.
  if (loadPlugin) warnings.push(PLUGIN_GATE_WARNING);

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
  console.log(`Reviewer: native Codex CLI (${reviewer.command}), at most ${reviewer.maxRounds} rounds.`);
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
  const sameSession = sessions.sessions.find((session) => isBackground(session) && isCurrentTask(session, { prefix, record, taskHash: hash }));

  if (sameSession) {
    if (sameSession.state === 'working') {
      console.log(`Autopilot session ${sameSession.id} is already working.`);
      console.log(`View:   dev-autopilot agents "${root}"`);
      console.log(`Logs:   dev-autopilot logs ${sameSession.id} "${root}"`);
      console.log(`Attach: dev-autopilot attach ${sameSession.id} "${root}"`);
      return;
    }
    if (sameSession.state === 'blocked') {
      console.log(`Autopilot session ${sameSession.id} needs input (${sameSession.waitingFor || 'blocked'}).`);
      console.log(`Attach: dev-autopilot attach ${sameSession.id} "${root}"`);
      return;
    }
    if (sameSession.state === 'failed' || sameSession.state === 'stopped') {
      console.log(`Respawning existing Autopilot session ${sameSession.id} for the unchanged task...`);
      describeReviewSetup(config);
      await writeSessionSettings(root, config);
      const result = await exec('claude', ['respawn', sameSession.id], { cwd: root, stream: true, timeoutMs: 30000 });
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Unable to respawn Claude session');
      return;
    }
    if (sameSession.state === 'done') {
      console.log(`The current task already has completed Autopilot session ${sameSession.id}.`);
      console.log('Merge/review its PR or update the task file before starting a new session.');
      console.log('Optional second opinion: in Claude Code on the PR branch, run /codex:adversarial-review --base <base> (official Codex plugin).');
      return;
    }
  }

  const live = sessions.sessions.find((session) => session.state === 'working' || session.state === 'blocked');
  if (live) {
    console.log(`A Claude background session is already active for this project: ${live.id} (${live.state}).`);
    console.log(`Attach: dev-autopilot attach ${live.id} "${root}"`);
    return;
  }

  const branch = await currentBranch(root);
  const name = sessionName(prefix, hash);
  const prompt = launchPrompt(config);
  const settingsPath = await writeSessionSettings(root, config);

  console.log(`Launching Claude background Autopilot from branch: ${branch}`);
  console.log('Model policy: use the user-configured/default Claude model; no --model flag is passed.');
  describeReviewSetup(config);
  const result = await exec('claude', ['--bg', '--name', name, '--settings', settingsPath, prompt], {
    cwd: root,
    stream: true,
    timeoutMs: 60000,
  });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Claude background launch failed');

  const id = parseBackgroundId(`${result.stdout}\n${result.stderr}`);
  await saveRuntimeRecord(root, {
    version: 2,
    id,
    sessionName: name,
    taskHash: hash,
    taskFile: config.project.taskFile,
    branchAtLaunch: branch,
    launchedAt: new Date().toISOString(),
  });

  console.log(id ? `Autopilot is running in Claude background session ${id}.` : 'Autopilot background session launched.');
  console.log(`Monitor: dev-autopilot status "${root}"`);
  console.log(`Agent UI: claude agents --cwd "${root}"`);
}

async function sessionContext(root, config) {
  return {
    prefix: config.claude?.sessionNamePrefix || 'autopilot',
    record: await runtimeRecord(root),
    taskHash: await currentTaskHash(root, config),
  };
}

async function status(root) {
  const config = await loadConfig(root);
  const result = await listSessions(root, true);
  if (!result.ok) throw new Error(result.error);
  const context = await sessionContext(root, config);
  const sessions = result.sessions.filter(isBackground).map((session) => ({ ...session, autopilot: classifySession(session, context) }));
  console.log(JSON.stringify({
    root,
    currentTask: { file: config.project.taskFile, hash: context.taskHash ? context.taskHash.slice(0, 12) : null },
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

async function sessionCommand(command, ident, root, interactive = false) {
  if (!ident) throw new Error(`Missing session id for ${command}. Use the "id" value from dev-autopilot status.`);
  const { id, session } = await resolveSessionId(ident, root);
  if (command === 'respawn' && session) {
    // Refresh the session's Autopilot settings so a respawned session gets this version's permissions.
    const config = await loadConfig(root).catch(() => null);
    if (config && classifySession(session, await sessionContext(root, config)).owned) {
      describeReviewSetup(config);
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

  const root = await rootFrom(positionals[0]);

  if (command === 'init') return init(root);
  if (command === 'upgrade') return upgrade(root);
  if (command === 'migrate-v1') return migrateV1(root);
  if (command === 'doctor') return doctor(root);
  if (command === 'run') return run(root);
  if (command === 'status') return status(root);
  if (command === 'agents') return agents(root);
  if (command === 'cleanup') return cleanup(root, { apply: flags.apply === true });

  usage();
  process.exitCode = 2;
}

export {
  buildConfig,
  configProblems,
  installReviewer,
  launchPrompt,
  ruleText,
  runtimeRecord,
  saveRuntimeRecord,
  sessionSettings,
  upgrade,
  VERSION,
};
