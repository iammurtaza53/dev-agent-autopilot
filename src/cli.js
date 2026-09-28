import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
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

const { version: VERSION } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const CONFIG_FILE = '.autopilot/config.json';
const RUNTIME_DIR = '.autopilot/runtime';
const LAST_SESSION_FILE = '.autopilot/runtime/last-session.json';
const CLAUDE_RULE_FILE = '.claude/rules/dev-autopilot.md';

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
  upgrade [path]                Refresh the Claude rule and add new config sections (e.g. planner)
  doctor [path]                 Verify Git, gh, Claude Code background agents and Codex CLI
  run [path]                    Start or resume the project's Claude background session
  status [path]                 Show Claude background sessions for the project
  agents [path]                 Open Claude's native agent view for the project
  attach <id> [path]            Attach to a Claude background session
  logs <id> [path]              Show recent output from a background session
  stop <id> [path]              Stop a background session
  resume <id> [path]            Respawn a stopped/failed background session
  install-reviewer              Verify the Codex CLI planner (codex exec) and reviewer (codex review)
  migrate-v1 [path]             Convert a v0.1 project config to the current format
  --version                     Print the version

Models are intentionally NOT pinned. Claude and Codex use your configured/default models.`);
}

function positional(args) {
  return args.filter((value, index) => !value.startsWith('--') && (index === 0 || !args[index - 1]?.startsWith('--')));
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
      maxRounds: 3,
      useFreshSessionEachRound: true,
      modelPolicy: 'default',
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

- Before finalizing, run a FRESH independent Codex review using the native Codex CLI, not MCP.
- Review the current task branch against the configured base branch with: \`codex review --base <baseBranch> < /dev/null\`.
- Do not add \`--model\`; Codex must use the user's configured/default model.
- Treat Codex as a reviewer only. Do not ask Codex to edit files.
- Fix actionable findings, rerun relevant deterministic checks, and run another fresh Codex review when appropriate. Stop after \`reviewer.maxRounds\` and report a blocker rather than looping forever.

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
  return `Read ${CLAUDE_RULE_FILE}, ${CONFIG_FILE}, ${config.project.taskFile}, and the configured project context files. Execute the current task end-to-end under the Autopilot workflow.${plan} Use the native Codex CLI reviewer (codex review) before finalizing, open/update the task PR, wait for CI, and stop before merge or any human gate.`;
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

async function init(root) {
  const configFile = path.join(root, CONFIG_FILE);
  if (await exists(configFile)) throw new Error(`${CONFIG_FILE} already exists. Use migrate-v1 for v0.1 projects.`);
  await writeJson(configFile, buildConfig(root, path.basename(root)));
  await ensureRule(root);
  await appendGitignore(root, [`${RUNTIME_DIR}/`]);
  console.log(`Created ${CONFIG_FILE}`);
  console.log(`Created ${CLAUDE_RULE_FILE}`);
  console.log('Next: add your test/lint/build commands to "checks" in the config, write your task in NEXT_TASK.md,');
  console.log('and commit the config/rule through your normal PR workflow before running.');
}

async function upgrade(root) {
  const config = await loadConfig(root);
  if (!config.planner) {
    config.planner = buildConfig(root).planner;
    await writeJson(path.join(root, CONFIG_FILE), config);
    console.log(`Added the Codex planner to ${CONFIG_FILE} (set planner.enabled to false to opt out).`);
  }
  await ensureRule(root);
  console.log(`Updated ${CLAUDE_RULE_FILE} to v${VERSION}.`);
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
  await appendGitignore(root, [`${RUNTIME_DIR}/`]);

  const oldState = path.join(root, '.autopilot/state.json');
  if (await exists(oldState)) {
    await fs.rename(oldState, path.join(backupDir, 'state-v1.backup.json')).catch(async () => {
      await fs.copyFile(oldState, path.join(backupDir, 'state-v1.backup.json'));
    });
  }

  console.log('Migrated .autopilot/config.json from v1 to v2.');
  console.log(`Created ${CLAUDE_RULE_FILE}.`);
  console.log('Old v1 config/state were backed up under .autopilot/runtime/ (gitignored).');
  console.log('Review and commit the v2 config/rule before running.');
}

async function installReviewer() {
  for (const subcommand of ['exec', 'review']) {
    const result = await codexAvailable(process.cwd(), subcommand);
    if (!result.ok) throw new Error(result.output || `Codex native ${subcommand} command is unavailable`);
    console.log(`Codex native ${subcommand === 'exec' ? 'planner' : 'reviewer'} is available: codex ${subcommand}`);
  }
  console.log('No MCP registration is required.');
  console.log('Models are not pinned; Codex uses your configured/default model.');
}

async function versionOf(command, args, root) {
  try {
    const result = await runProcess(command, args, { cwd: root, timeoutMs: 15000 });
    return result.code === 0 ? (result.stdout || result.stderr).trim().split(/\r?\n/)[0] : `ERROR: ${(result.stderr || result.stdout).trim()}`;
  } catch (error) {
    return `ERROR: ${error.message}`;
  }
}

async function listSessions(root, includeAll = true) {
  const args = ['agents', '--json'];
  if (includeAll) args.push('--all');
  args.push('--cwd', root);
  const result = await runProcess('claude', args, { cwd: root, timeoutMs: 30000 });
  if (result.code !== 0) return { ok: false, sessions: [], error: (result.stderr || result.stdout).trim() };
  try {
    const parsed = JSON.parse(result.stdout || '[]');
    const rootKey = normalizePathForCompare(root);
    const sessions = Array.isArray(parsed)
      ? parsed.filter((item) => !item.cwd || normalizePathForCompare(item.cwd).startsWith(rootKey))
      : [];
    return { ok: true, sessions, error: null };
  } catch (error) {
    return { ok: false, sessions: [], error: `Could not parse claude agents JSON: ${error.message}` };
  }
}

async function codexAvailable(root, subcommand) {
  const result = await runProcess('codex', [subcommand, '--help'], { cwd: root, timeoutMs: 15000 }).catch((error) => ({ code: 1, stderr: error.message }));
  return { ok: result.code === 0, output: (result.stdout || result.stderr).trim() };
}

async function doctor(root) {
  const config = await loadConfig(root);
  const checks = {
    git: await versionOf('git', ['--version'], root),
    gh: await versionOf('gh', ['--version'], root),
    claude: await versionOf('claude', ['--version'], root),
    codex: await versionOf('codex', ['--version'], root),
  };
  const claudeAuth = await runProcess('claude', ['auth', 'status'], { cwd: root, timeoutMs: 15000 }).catch((error) => ({ code: 1, stderr: error.message }));
  const ghAuth = await runProcess('gh', ['auth', 'status'], { cwd: root, timeoutMs: 15000 }).catch((error) => ({ code: 1, stderr: error.message }));
  const plannerEnabled = config.planner?.enabled === true;
  const planner = plannerEnabled ? await codexAvailable(root, 'exec') : null;
  const reviewer = await codexAvailable(root, 'review');
  const agents = await listSessions(root, false);

  const output = {
    root,
    configVersion: config.version,
    tools: checks,
    claudeAuthenticated: claudeAuth.code === 0,
    githubAuthenticated: ghAuth.code === 0,
    codexPlannerAvailable: plannerEnabled ? planner.ok : 'disabled',
    codexReviewAvailable: reviewer.ok,
    claudeAgentViewAvailable: agents.ok,
    activeSessions: agents.sessions.map(({ id, state, name, cwd, waitingFor }) => ({ id, state, name, cwd, waitingFor })),
    modelPolicy: 'No model pinning. Claude and Codex use your configured/default models.',
  };
  console.log(JSON.stringify(output, null, 2));

  const failedTools = Object.values(checks).some((value) => String(value).startsWith('ERROR:'));
  if (failedTools || claudeAuth.code !== 0 || ghAuth.code !== 0 || (planner && !planner.ok) || !reviewer.ok || !agents.ok) {
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

async function run(root) {
  const config = await loadConfig(root);
  const reviewer = await codexAvailable(root, 'review');
  if (!reviewer.ok) throw new Error('Codex native review command is unavailable. Run: dev-autopilot install-reviewer');
  if (config.planner?.enabled === true && !(await codexAvailable(root, 'exec')).ok) {
    throw new Error('Codex native exec command (planner) is unavailable. Run: dev-autopilot install-reviewer');
  }

  if (config.safety?.requireCleanStart !== false && (await isDirty(root))) {
    throw new Error('Working tree is dirty. Commit/stash/remove existing changes before starting a new Autopilot background task.');
  }

  const hash = await taskHash(root, config);
  const sessions = await listSessions(root, true);
  if (!sessions.ok) throw new Error(sessions.error);
  const record = await runtimeRecord(root);
  const sameSession = record?.taskHash === hash ? sessions.sessions.find((session) => session.id === record.id || session.sessionId === record.sessionId) : null;

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
      const result = await runProcess('claude', ['respawn', sameSession.id], { cwd: root, stream: true, timeoutMs: 30000 });
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Unable to respawn Claude session');
      return;
    }
    if (sameSession.state === 'done') {
      console.log(`The current task already has completed Autopilot session ${sameSession.id}.`);
      console.log('Merge/review its PR or update the task file before starting a new session.');
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
  const name = `${config.claude?.sessionNamePrefix || 'autopilot'}-${hash.slice(0, 6)}`.slice(0, 64);
  const prompt = launchPrompt(config);

  const runtimeSettings = {
    permissions: {
      defaultMode: 'dontAsk',
      allow: config.claude?.allowedTools || COMMON_ALLOWED_TOOLS,
      deny: config.claude?.disallowedTools || COMMON_DENIED_TOOLS,
    },
  };
  const settingsPath = path.join(root, RUNTIME_DIR, 'claude-settings.json');
  await writeJson(settingsPath, runtimeSettings);

  console.log(`Launching Claude background Autopilot from branch: ${branch}`);
  console.log('Model policy: use the user-configured/default Claude model; no --model flag is passed.');
  const result = await runProcess('claude', ['--bg', '--name', name, '--settings', settingsPath, prompt], {
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

async function status(root) {
  await loadConfig(root);
  const result = await listSessions(root, true);
  if (!result.ok) throw new Error(result.error);
  const record = await runtimeRecord(root);
  console.log(JSON.stringify({ root, lastAutopilotSession: record, sessions: result.sessions }, null, 2));
}

async function agents(root) {
  await loadConfig(root);
  const result = await runProcess('claude', ['agents', '--cwd', root], { cwd: root, stdin: 'inherit' });
  if (result.code !== 0) process.exitCode = result.code;
}

async function sessionCommand(command, id, root, interactive = false) {
  if (!id) throw new Error(`Missing session id for ${command}`);
  const args = [command, id];
  const result = await runProcess('claude', args, { cwd: root, stream: !interactive, stdin: interactive ? 'inherit' : 'pipe', timeoutMs: interactive ? 0 : 60000 });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || `claude ${command} failed`);
  if (!interactive && result.stdout.trim()) console.log(result.stdout.trim());
}

export async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '-h' || command === '--help') return usage();
  if (command === '-v' || command === '--version') return console.log(VERSION);

  if (command === 'install-reviewer') return installReviewer();

  if (command === 'attach' || command === 'logs' || command === 'stop' || command === 'resume') {
    const id = rest[0];
    const root = await rootFrom(rest[1]);
    const mapped = command === 'resume' ? 'respawn' : command;
    return sessionCommand(mapped, id, root, command === 'attach');
  }

  const root = await rootFrom(positional(rest)[0]);

  if (command === 'init') return init(root);
  if (command === 'upgrade') return upgrade(root);
  if (command === 'migrate-v1') return migrateV1(root);
  if (command === 'doctor') return doctor(root);
  if (command === 'run') return run(root);
  if (command === 'status') return status(root);
  if (command === 'agents') return agents(root);

  usage();
  process.exitCode = 2;
}

export { buildConfig, launchPrompt, ruleText, runtimeRecord, saveRuntimeRecord, upgrade, VERSION };
