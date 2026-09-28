import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendGitignore, exists, parseBackgroundId, readJson, runProcess, slugify } from '../src/lib.js';
import { buildConfig, launchPrompt, main, ruleText, runtimeRecord, saveRuntimeRecord, upgrade, VERSION } from '../src/cli.js';

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-autopilot-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function readGitignore(root) {
  return fs.readFile(path.join(root, '.gitignore'), 'utf8');
}

async function writeV2Config(root, config = buildConfig(root, 'Existing App')) {
  await fs.mkdir(path.join(root, '.autopilot'), { recursive: true });
  await fs.writeFile(path.join(root, '.autopilot', 'config.json'), JSON.stringify(config), 'utf8');
}

// Runs git in a throwaway repo, isolated from the developer's global excludes file and from GIT_* hook variables.
async function gitIn(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const excludes = `core.excludesFile=${path.join(root, '.git', 'no-global-excludes')}`;
  const result = await runProcess('git', ['-c', excludes, ...args], { cwd: root, env });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}

test('parseBackgroundId handles Claude background output', () => {
  assert.equal(parseBackgroundId('backgrounded · 7c5dcf5d · demo\n  claude attach 7c5dcf5d'), '7c5dcf5d');
});

test('default config has no model pinning and uses Codex to plan and review', () => {
  const cfg = buildConfig('/work/demo-todo-app', 'Demo Todo App');
  assert.equal(cfg.version, 2);
  assert.equal(cfg.project.name, 'Demo Todo App');
  assert.equal(cfg.claude.sessionNamePrefix, 'autopilot-demo-todo-app');
  assert.equal('model' in cfg.claude, false);
  assert.equal('model' in cfg.planner, false);
  assert.equal('model' in cfg.reviewer, false);
  assert.ok(cfg.claude.allowedTools.includes('Bash(codex *)'));
  assert.equal(cfg.planner.enabled, true);
  assert.equal(cfg.planner.command, 'codex exec --sandbox read-only');
  assert.equal(cfg.reviewer.transport, 'codex-cli');
  assert.ok(cfg.claude.disallowedTools.includes('Bash(gh pr merge*)'));
});

test('rule explicitly preserves default model selection', () => {
  const text = ruleText();
  assert.match(text, /Do not change model selection/);
  assert.match(text, /Do not add `--model`/);
});

test('rule makes Codex a read-only planner and reviewer', () => {
  const text = ruleText();
  assert.match(text, new RegExp(`Dev Agent Autopilot v${VERSION.replace(/\./g, '\\.')}`));
  assert.match(text, /codex exec --sandbox read-only/);
  assert.match(text, /codex review --base <baseBranch>/);
  assert.match(text, /Codex never edits files/);
});

test('launch prompt asks for a Codex plan only when the planner is enabled', () => {
  const cfg = buildConfig('/work/demo-todo-app', 'Demo Todo App');
  assert.match(launchPrompt(cfg), /plan from Codex \(codex exec --sandbox read-only\)/);

  const { planner, ...withoutPlanner } = cfg;
  assert.doesNotMatch(launchPrompt(withoutPlanner), /codex exec/);
  assert.match(launchPrompt(withoutPlanner), /codex review/);
});

test('upgrade adds the planner to an existing v2 config and refreshes the rule', async (t) => {
  const root = await tempRoot(t);
  const { planner, ...oldConfig } = buildConfig(root, 'Existing App');
  oldConfig.checks = ['npm test'];
  await fs.mkdir(path.join(root, '.autopilot'), { recursive: true });
  await fs.writeFile(path.join(root, '.autopilot', 'config.json'), JSON.stringify(oldConfig), 'utf8');

  await upgrade(root);

  const config = await readJson(path.join(root, '.autopilot', 'config.json'));
  assert.deepEqual(config.planner, planner);
  assert.deepEqual(config.checks, ['npm test']);
  assert.equal(await fs.readFile(path.join(root, '.claude', 'rules', 'dev-autopilot.md'), 'utf8'), ruleText());
});

test('upgrade keeps an existing planner opt-out', async (t) => {
  const root = await tempRoot(t);
  const config = buildConfig(root, 'Opted Out');
  config.planner.enabled = false;
  await fs.mkdir(path.join(root, '.autopilot'), { recursive: true });
  await fs.writeFile(path.join(root, '.autopilot', 'config.json'), JSON.stringify(config), 'utf8');

  await upgrade(root);

  assert.equal((await readJson(path.join(root, '.autopilot', 'config.json'))).planner.enabled, false);
});

test('init ignores Autopilot runtime state and Claude worktrees in a new project', async (t) => {
  const root = await tempRoot(t);

  await main(['init', root]);

  assert.equal(await readGitignore(root), '.autopilot/runtime/\n.claude/worktrees/\n');
});

test('init preserves an existing .gitignore', async (t) => {
  const root = await tempRoot(t);
  await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n# local secrets\n.env', 'utf8');

  await main(['init', root]);

  assert.equal(await readGitignore(root), 'node_modules/\n# local secrets\n.env\n.autopilot/runtime/\n.claude/worktrees/\n');
});

test('upgrade adds .claude/worktrees/ to an existing v0.3.0 project exactly once', async (t) => {
  const root = await tempRoot(t);
  await writeV2Config(root);
  await fs.writeFile(path.join(root, '.gitignore'), 'dist/\n.autopilot/runtime/\n', 'utf8');

  await upgrade(root);
  await upgrade(root);

  assert.equal(await readGitignore(root), 'dist/\n.autopilot/runtime/\n.claude/worktrees/\n');
});

test('migrate-v1 ignores Autopilot runtime state and Claude worktrees', async (t) => {
  const root = await tempRoot(t);
  await fs.mkdir(path.join(root, '.autopilot'), { recursive: true });
  const v1 = { version: 1, project: { name: 'Legacy App', baseBranch: 'main' }, checks: [{ command: 'npm test' }] };
  await fs.writeFile(path.join(root, '.autopilot', 'config.json'), JSON.stringify(v1), 'utf8');
  await fs.writeFile(path.join(root, '.gitignore'), 'coverage/\n', 'utf8');

  await main(['migrate-v1', root]);

  assert.equal((await readJson(path.join(root, '.autopilot', 'config.json'))).version, 2);
  assert.equal(await readGitignore(root), 'coverage/\n.autopilot/runtime/\n.claude/worktrees/\n');
});

test('appendGitignore does not duplicate entries or rewrite an up-to-date file', async (t) => {
  const root = await tempRoot(t);
  const entries = ['.autopilot/runtime/', '.claude/worktrees/'];

  assert.deepEqual(await appendGitignore(root, entries), entries);
  assert.deepEqual(await appendGitignore(root, entries), []);
  assert.equal(await readGitignore(root), '.autopilot/runtime/\n.claude/worktrees/\n');

  // Equivalent spellings (anchored, no trailing slash, CRLF line endings) already cover the entries.
  const crlf = 'build/\r\n/.claude/worktrees\r\n.autopilot/runtime/\r\n';
  await fs.writeFile(path.join(root, '.gitignore'), crlf, 'utf8');
  assert.deepEqual(await appendGitignore(root, entries), []);
  assert.equal(await readGitignore(root), crlf);
});

test('the committed Claude rule stays trackable while worktrees and runtime state are ignored', async (t) => {
  const root = await tempRoot(t);
  await gitIn(root, ['init', '-q']);
  await main(['init', root]);
  await upgrade(root);
  for (const file of ['.claude/worktrees/autopilot-demo/src/index.js', '.autopilot/runtime/last-session.json']) {
    await fs.mkdir(path.join(root, path.dirname(file)), { recursive: true });
    await fs.writeFile(path.join(root, file), '{}\n', 'utf8');
  }

  const untracked = (await gitIn(root, ['ls-files', '--others', '--exclude-standard'])).split(/\r?\n/).filter(Boolean);

  assert.deepEqual(untracked.sort(), ['.autopilot/config.json', '.claude/rules/dev-autopilot.md', '.gitignore']);
  assert.doesNotMatch(await readGitignore(root), /^\/?\.claude\/?$/m);
});

test('slugify makes stable session-safe names', () => {
  assert.equal(slugify('My App / Phase 3'), 'my-app-phase-3');
});

test('readJson throws ENOENT for a missing file when no fallback is given', async (t) => {
  const root = await tempRoot(t);
  await assert.rejects(readJson(path.join(root, 'missing.json')), { code: 'ENOENT' });
});

test('readJson returns an explicit null fallback for a missing file', async (t) => {
  const root = await tempRoot(t);
  assert.equal(await readJson(path.join(root, 'missing.json'), null), null);
});

test('readJson returns an explicit object fallback for a missing file', async (t) => {
  const root = await tempRoot(t);
  const fallback = { sessions: [] };
  assert.equal(await readJson(path.join(root, 'missing.json'), fallback), fallback);
});

test('first run without .autopilot/runtime/ initializes session state', async (t) => {
  const root = await tempRoot(t);
  assert.equal(await exists(path.join(root, '.autopilot')), false);

  assert.equal(await runtimeRecord(root), null);

  const record = { version: 2, id: 'abc1234', taskHash: 'deadbeef' };
  await saveRuntimeRecord(root, record);
  assert.deepEqual(await runtimeRecord(root), record);
});

test('saving session state creates the runtime directory automatically', async (t) => {
  const root = await tempRoot(t);
  const runtimeDir = path.join(root, '.autopilot', 'runtime');
  assert.equal(await exists(runtimeDir), false);

  await saveRuntimeRecord(root, { version: 2, id: null });

  assert.equal((await fs.stat(runtimeDir)).isDirectory(), true);
  assert.equal(await exists(path.join(runtimeDir, 'last-session.json')), true);
});

test('an existing valid last-session file still loads', async (t) => {
  const root = await tempRoot(t);
  const record = { version: 2, id: '7c5dcf5d', sessionName: 'autopilot-demo-abc123', taskHash: 'abc123' };
  const runtimeDir = path.join(root, '.autopilot', 'runtime');
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(path.join(runtimeDir, 'last-session.json'), JSON.stringify(record), 'utf8');

  assert.deepEqual(await runtimeRecord(root), record);
});
