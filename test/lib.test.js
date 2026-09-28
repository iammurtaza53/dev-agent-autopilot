import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exists, parseBackgroundId, readJson, slugify } from '../src/lib.js';
import { buildConfig, launchPrompt, ruleText, runtimeRecord, saveRuntimeRecord, upgrade, VERSION } from '../src/cli.js';

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-autopilot-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
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
