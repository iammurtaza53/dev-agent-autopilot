import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PLUGIN_ID } from '../src/codex-plugin.js';
import { buildConfig, configProblems, installReviewer, launchPrompt, legacyLaunchPrompt, main, ruleText, sessionSettings, upgrade } from '../src/cli.js';
import { gitIn, readConfig, tempRoot, useFakeCli, v031Config, writeConfig } from './helpers.js';

const PLUGIN = { id: PLUGIN_ID, version: '1.0.6', scope: 'user', enabled: true };
const SESSION_ID = '7c5dcf5d-9f1e-4c1a-8f5e-0a1b2c3d4e5f';

const background = (id, state, extra = {}) => ({
  id,
  sessionId: `${id}-9f1e-4c1a-8f5e-0a1b2c3d4e5f`,
  kind: 'background',
  name: `autopilot-demo-${id.slice(0, 6)}`,
  state,
  ...extra,
});

// A committed Git project with an Autopilot config and a task, ready for `run`.
async function project(t, config) {
  const root = await tempRoot(t);
  await gitIn(root, ['init', '-q', '-b', 'main']);
  await fs.writeFile(path.join(root, '.gitignore'), '.autopilot/runtime/\n.claude/worktrees/\n', 'utf8');
  await fs.writeFile(path.join(root, 'NEXT_TASK.md'), '# Task\n\nAdd a feature.\n', 'utf8');
  await fs.mkdir(path.join(root, '.claude', 'rules'), { recursive: true });
  await fs.writeFile(path.join(root, '.claude', 'rules', 'dev-autopilot.md'), ruleText(), 'utf8');
  await writeConfig(root, config || { ...buildConfig(root, 'demo'), checks: ['npm test'] });
  await gitIn(root, ['add', '-A']);
  await gitIn(root, ['commit', '-q', '-m', 'init']);
  return root;
}

async function doctorOutput(fake) {
  return JSON.parse(fake.output.find((line) => line.trimStart().startsWith('{')));
}

async function settingsFile(root) {
  return JSON.parse(await fs.readFile(path.join(root, '.autopilot', 'runtime', 'claude-settings.json'), 'utf8'));
}

const bgLaunch = (fake) => fake.calls.find((call) => call.command === 'claude' && call.args[0] === '--bg');
const installCalls = (fake) => fake.calls.filter((call) => /plugin (install|marketplace add)/.test(call.line));

// ---------------------------------------------------------------- init, upgrade, compatibility

test('init writes a v2 config with the native reviewer and the plugin switched off in sessions', async (t) => {
  const root = await tempRoot(t);
  useFakeCli(t);
  await main(['init', root]);
  const config = await readConfig(root);
  assert.equal(config.version, 2);
  assert.equal(config.reviewer.transport, 'codex-cli');
  assert.equal(config.reviewer.maxRounds, 2, 'v0.4.1 lowers the default cap for new projects to 2');
  assert.deepEqual(config.reviewer.adaptive, { enabled: true });
  assert.deepEqual(config.leanloop, { enabled: true });
  assert.deepEqual(config.quota, { autoResume: false, graceMinutes: 2 });
  assert.deepEqual(config.codexPlugin, { loadInAutopilotSessions: false });
  assert.deepEqual(configProblems(config), []);
});

test('upgrade leaves a v0.3.1 config byte-for-byte unchanged and is idempotent', async (t) => {
  const root = await tempRoot(t);
  const fake = useFakeCli(t);
  const legacy = await v031Config();
  await writeConfig(root, legacy);
  await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n.autopilot/runtime/\n.claude/worktrees/\n', 'utf8');
  const before = await fs.readFile(path.join(root, '.autopilot', 'config.json'), 'utf8');

  await upgrade(root);
  const snapshot = async () => Promise.all(['.autopilot/config.json', '.claude/rules/dev-autopilot.md', '.gitignore'].map((file) => fs.readFile(path.join(root, file), 'utf8')));
  const first = await snapshot();
  await upgrade(root);
  const second = await snapshot();

  assert.equal(first[0], before, 'config must not be rewritten');
  assert.equal(first[1], ruleText());
  assert.deepEqual(second, first);
  assert.match(fake.text(), /switched off inside Autopilot sessions by default/);
  assert.deepEqual(configProblems(legacy), []);
});

test('upgrade migrates the reviewer transport removed in v0.2.1 and keeps everything else', async (t) => {
  const root = await tempRoot(t);
  useFakeCli(t);
  const config = await v031Config();
  config.reviewer.transport = 'codex-mcp';
  config.reviewer.maxRounds = 5;
  await writeConfig(root, config);

  await upgrade(root);

  const upgraded = await readConfig(root);
  assert.equal(upgraded.reviewer.transport, 'codex-cli');
  assert.deepEqual({ ...upgraded, reviewer: { ...upgraded.reviewer, transport: 'codex-mcp' } }, config);
});

test('upgrade keeps an explicit opt-in to loading the plugin in sessions', async (t) => {
  const root = await tempRoot(t);
  useFakeCli(t);
  await writeConfig(root, { ...(await v031Config()), codexPlugin: { loadInAutopilotSessions: true } });
  await upgrade(root);
  assert.equal((await readConfig(root)).codexPlugin.loadInAutopilotSessions, true);
});

// ---------------------------------------------------------------- configuration validation

test('configProblems rejects a plugin reviewer backend with the reason', () => {
  const config = buildConfig('/w/app', 'app');
  config.reviewer.transport = 'official-plugin';
  const [problem] = configProblems(config);
  assert.match(problem, /user-invoked only \(disable-model-invocation\)/);
  assert.match(problem, /Use "codex-cli"/);
});

test('configProblems rejects unknown transports, bad round limits and a non-boolean plugin setting', () => {
  const config = buildConfig('/w/app', 'app');
  config.reviewer.transport = 'auto';
  config.reviewer.maxRounds = 0;
  config.planner.transport = 'mcp';
  config.codexPlugin.loadInAutopilotSessions = 'yes';
  const problems = configProblems(config);
  assert.equal(problems.length, 4);
  assert.match(problems[0], /reviewer\.transport "auto" is not supported/);
  assert.match(problems[1], /reviewer\.maxRounds must be a whole number of at least 1 \(found 0\)/);
  assert.match(problems[2], /planner\.transport "mcp" is from Autopilot v0\.2/);
  assert.match(problems[3], /codexPlugin\.loadInAutopilotSessions must be true or false/);

  const clean = buildConfig('/w/app', 'app');
  for (const maxRounds of [2.5, '3', -1, 0, null]) {
    const found = configProblems({ ...clean, reviewer: { ...clean.reviewer, maxRounds } });
    assert.equal(found.length, 1, `maxRounds ${maxRounds}`);
    assert.match(found[0], /reviewer\.maxRounds must be a whole number/);
  }
  assert.deepEqual(configProblems({ version: 2, project: {} }), [], 'missing optional sections use defaults');
  assert.deepEqual(configProblems({ ...buildConfig('/w', 'a'), planner: { enabled: false, transport: 'other' } }), [], 'a disabled planner is not checked');
});

test('configProblems rejects explicit nulls instead of treating them as defaults', () => {
  const clean = buildConfig('/w/app', 'app');
  assert.match(configProblems({ ...clean, reviewer: { ...clean.reviewer, transport: null } })[0], /reviewer\.transport "null" is not supported/);
  assert.match(configProblems({ ...clean, planner: { ...clean.planner, transport: null } })[0], /planner\.transport "null" is not supported/);
  assert.match(configProblems({ ...clean, codexPlugin: { loadInAutopilotSessions: null } })[0], /must be true or false \(found null\)/);
  const { transport, maxRounds, ...withoutValues } = clean.reviewer;
  assert.deepEqual(configProblems({ ...clean, reviewer: withoutValues }), [], 'missing keys still take their defaults');
});

test('run refuses an invalid config before launching anything', async (t) => {
  const config = { ...buildConfig('/w', 'demo'), checks: ['npm test'] };
  config.reviewer.transport = 'official-plugin';
  const root = await project(t, config);
  const fake = useFakeCli(t);
  await assert.rejects(main(['run', root]), /Fix \.autopilot\/config\.json:\n- reviewer\.transport "official-plugin" is not supported/);
  assert.equal(bgLaunch(fake), undefined);
});

// ---------------------------------------------------------------- rule and launch prompt

test('the v0.4 launch prompt names the native reviewer, the base branch and the round limit', () => {
  const config = buildConfig('/w/app', 'app');
  config.reviewer.maxRounds = 3;
  assert.match(legacyLaunchPrompt(config), /native Codex CLI reviewer \(codex review --base main\), at most 3 rounds/);
  config.project.baseBranch = 'develop';
  config.reviewer.maxRounds = 2;
  const prompt = legacyLaunchPrompt(config);
  assert.match(prompt, /codex review --base develop\), at most 2 rounds/);
  assert.match(prompt, /if Codex fails, stop and report it instead of reviewing the work yourself/);
  assert.equal(launchPrompt(config), prompt, 'without a capsule the v0.4 prompt is used');
  assert.equal(launchPrompt({ ...config, leanloop: { enabled: false } }, { capsulePath: '/x/capsule.md' }), prompt, 'LeanLoop off keeps the v0.4 prompt');
});

test('the LeanLoop launch prompt points at the capsule and the quiet helpers instead of the context files', () => {
  const config = buildConfig('/w/app', 'app');
  config.project.baseBranch = 'develop';
  const prompt = launchPrompt(config, { capsulePath: '/w/app/.autopilot/runtime/context/capsule-abc.md' });
  assert.match(prompt, /Context Capsule at \/w\/app\/\.autopilot\/runtime\/context\/capsule-abc\.md/);
  assert.match(prompt, /replaces reading the configured context files/);
  assert.match(prompt, /dev-autopilot check/);
  assert.match(prompt, /dev-autopilot codex review \(native Codex CLI reviewer: codex review --base develop, adaptive budget from the diff, at most 2 rounds\)/);
  assert.match(prompt, /dev-autopilot codex plan/);
  assert.match(prompt, /if Codex fails or reports exhausted usage, stop and report it instead of reviewing the work yourself/);
  assert.doesNotMatch(prompt, /Read \.claude\/rules/, 'the rule is project memory, not an explicit reread');
  assert.match(launchPrompt({ ...config, planner: { enabled: false } }, { capsulePath: '/c.md' }), /do not ask Codex for a plan/);
});

test('the rule bounds the review loop, treats Codex failures as blockers and fences off the plugin', () => {
  const text = ruleText();
  assert.match(text, /Never run more than `reviewer\.maxRounds` rounds/);
  assert.match(text, /stop and report them as a blocker instead of looping/);
  assert.match(text, /## When Codex fails/);
  assert.match(text, /Never replace Codex's plan or review with your own/);
  assert.match(text, /Do not use `\/codex:rescue` or the `codex:codex-rescue` subagent/);
  assert.match(text, /Do not run `\/codex:setup` and do not change the plugin's review gate/);
  assert.doesNotMatch(text, /--enable-review-gate/);
});

// ---------------------------------------------------------------- run

test('run launches with the native Codex reviewer and the plugin switched off in the session', async (t) => {
  const root = await project(t);
  const fake = useFakeCli(t, { plugins: [PLUGIN] });

  await main(['run', root]);

  const launch = bgLaunch(fake);
  assert.ok(launch, 'claude --bg was called');
  const settingsPath = launch.args[launch.args.indexOf('--settings') + 1];
  assert.equal(settingsPath, path.join(root, '.autopilot', 'runtime', 'claude-settings.json'));
  assert.equal(launch.args.includes('--model'), false);
  assert.match(launch.args.at(-1), /codex review --base main, adaptive budget from the diff, at most 2 rounds/);
  assert.match(launch.args.at(-1), /Context Capsule at .*capsule-[0-9a-f]{12}\.md/);

  const settings = await settingsFile(root);
  const config = await readConfig(root);
  assert.deepEqual(settings.enabledPlugins, { [PLUGIN_ID]: false });
  assert.equal(settings.permissions.defaultMode, 'dontAsk');
  assert.deepEqual(settings.permissions.allow.slice(0, config.claude.allowedTools.length), config.claude.allowedTools);
  assert.deepEqual(settings.permissions.allow.slice(config.claude.allowedTools.length), [
    'Bash(dev-autopilot check*)',
    'Bash(dev-autopilot codex plan*)',
    'Bash(dev-autopilot codex review*)',
    'Bash(dev-autopilot review-budget*)',
    'Bash(dev-autopilot state*)',
  ]);
  assert.equal(settings.permissions.allow.some((rule) => /dev-autopilot (run|stop|cleanup|resume)/.test(rule)), false);
  for (const rule of [...config.claude.disallowedTools, 'Agent(codex:codex-rescue)', 'Skill(codex:rescue)', 'Skill(codex:setup)']) {
    assert.ok(settings.permissions.deny.includes(rule), rule);
  }
  assert.match(fake.text(), /Reviewer: native Codex CLI \(codex review --base main\), at most 2 rounds; the adaptive budget from the diff can lower that\./);
  assert.match(fake.text(), /switched off inside this Autopilot session/);
  const record = JSON.parse(await fs.readFile(path.join(root, '.autopilot', 'runtime', 'last-session.json'), 'utf8'));
  assert.equal(record.id, '7c5dcf5d');
});

test('run works for an unchanged v0.3.1 project and never needs the plugin', async (t) => {
  const root = await project(t, await v031Config());
  const fake = useFakeCli(t, { plugins: [] });
  const before = await fs.readFile(path.join(root, '.autopilot', 'config.json'), 'utf8');

  await main(['run', root]);

  assert.ok(bgLaunch(fake));
  assert.equal(fake.calls.some((call) => call.line.startsWith('claude plugin')), false, 'run does not depend on plugin detection');
  assert.deepEqual((await settingsFile(root)).enabledPlugins, { [PLUGIN_ID]: false });
  assert.equal(await fs.readFile(path.join(root, '.autopilot', 'config.json'), 'utf8'), before);
});

test('opting in loads the plugin in the session, keeps the deny rules and warns about the review gate', async (t) => {
  const config = { ...buildConfig('/w', 'demo'), checks: ['npm test'], codexPlugin: { loadInAutopilotSessions: true } };
  const root = await project(t, config);
  const fake = useFakeCli(t, { plugins: [PLUGIN] });

  await main(['run', root]);

  const settings = await settingsFile(root);
  assert.equal('enabledPlugins' in settings, false);
  assert.ok(settings.permissions.deny.includes('Skill(codex:setup)'));
  assert.match(fake.text(), /Warning: codexPlugin\.loadInAutopilotSessions is true/);
});

test('sessionSettings never enables the plugin or its review gate by default', () => {
  const settings = sessionSettings(buildConfig('/w', 'demo'));
  assert.deepEqual(settings.enabledPlugins, { [PLUGIN_ID]: false });
  assert.doesNotMatch(JSON.stringify(settings), /review-gate|stopReviewGate/);
});

test('run refuses to start when the Codex CLI is missing', async (t) => {
  const root = await project(t);
  const fake = useFakeCli(t, { missing: ['codex'] });
  await assert.rejects(main(['run', root]), /Codex native review command is unavailable/);
  assert.equal(bgLaunch(fake), undefined);
});

test('run warns but still launches when codex login status fails', async (t) => {
  const root = await project(t);
  const fake = useFakeCli(t, { results: { 'codex login status': { code: 1 } } });
  await main(['run', root]);
  assert.ok(bgLaunch(fake));
  assert.match(fake.text(), /Codex is not signed in/);
});

const bgNew = (fake) => fake.calls.find((call) => call.command === 'claude' && call.args[0] === '--bg' && call.args[1] !== '--resume');
const bgResume = (fake) => fake.calls.find((call) => call.command === 'claude' && call.args[0] === '--bg' && call.args[1] === '--resume');

test('run continues a stopped session of the unchanged task with a short message and refreshes its settings', async (t) => {
  const root = await project(t);
  useFakeCli(t);
  await main(['run', root]);
  await fs.rm(path.join(root, '.autopilot', 'runtime', 'claude-settings.json'));

  const fake = useFakeCli(t, { agents: [background('7c5dcf5d', 'stopped', { cwd: root })] });
  await main(['run', root]);

  assert.equal(bgNew(fake), undefined, 'no new session');
  const resume = bgResume(fake);
  assert.deepEqual(resume.args.slice(0, 3), ['--bg', '--resume', '7c5dcf5d-9f1e-4c1a-8f5e-0a1b2c3d4e5f']);
  assert.equal(resume.args.length, 4, 'no other flags, so Claude continues the same session instead of starting a copy');
  assert.match(resume.args[3], /unchanged since you read them/);
  assert.deepEqual((await settingsFile(root)).enabledPlugins, { [PLUGIN_ID]: false });
});

test('with LeanLoop off, run respawns a stopped session exactly as v0.4 did', async (t) => {
  const root = await project(t, { ...buildConfig('/w', 'demo'), checks: ['npm test'], leanloop: { enabled: false } });
  const first = useFakeCli(t);
  await main(['run', root]);
  assert.match(bgLaunch(first).args.at(-1), /^Read \.claude\/rules\/dev-autopilot\.md, \.autopilot\/config\.json, NEXT_TASK\.md/);
  assert.equal(await fs.stat(path.join(root, '.autopilot', 'runtime', 'context')).catch(() => null), null, 'no capsule is built');

  const fake = useFakeCli(t, { agents: [background('7c5dcf5d', 'stopped', { cwd: root })] });
  await main(['run', root]);
  assert.ok(fake.calls.some((call) => call.line === 'claude respawn 7c5dcf5d'));
  assert.equal(bgResume(fake), undefined);
  assert.equal((await settingsFile(root)).permissions.allow.some((rule) => rule.includes('dev-autopilot')), false);
});

// The session name `run` generated for the project's current task.
async function launchedName(t, root) {
  const fake = useFakeCli(t);
  await main(['run', root]);
  const launch = bgLaunch(fake);
  return launch.args[launch.args.indexOf('--name') + 1];
}

test('run finds the current task session by name when .autopilot/runtime/ was lost', async (t) => {
  const root = await project(t);
  const name = await launchedName(t, root);
  await fs.rm(path.join(root, '.autopilot', 'runtime'), { recursive: true, force: true });

  const fake = useFakeCli(t, { agents: [background('5e55e55e', 'stopped', { cwd: root, name })] });
  await main(['run', root]);

  assert.equal(bgNew(fake), undefined, 'no duplicate session is launched');
  const resume = bgResume(fake);
  assert.equal(resume.args[2], '5e55e55e-9f1e-4c1a-8f5e-0a1b2c3d4e5f');
  assert.match(resume.args[3], /no record of the context this session read, so read the Context Capsule at /, 'lost runtime state never reuses context blindly');
});

test('respawning with the plugin loaded in sessions warns about the review gate (run and resume)', async (t) => {
  const config = { ...buildConfig('/w', 'demo'), checks: ['npm test'], codexPlugin: { loadInAutopilotSessions: true } };
  const root = await project(t, config);
  const name = await launchedName(t, root);
  const agents = [background('5e55e55e', 'stopped', { cwd: root, name })];

  const viaRun = useFakeCli(t, { agents });
  await main(['run', root]);
  assert.equal(bgResume(viaRun).args[2], '5e55e55e-9f1e-4c1a-8f5e-0a1b2c3d4e5f');
  assert.match(viaRun.text(), /Warning: codexPlugin\.loadInAutopilotSessions is true/);

  const viaResume = useFakeCli(t, { agents });
  await main(['resume', '5e55e55e', root]);
  assert.equal(bgResume(viaResume).args[2], '5e55e55e-9f1e-4c1a-8f5e-0a1b2c3d4e5f');
  assert.match(viaResume.text(), /Warning: codexPlugin\.loadInAutopilotSessions is true/);
});

// ---------------------------------------------------------------- doctor

test('doctor passes without the plugin and reports the native reviewer', async (t) => {
  const root = await project(t);
  const fake = useFakeCli(t, { plugins: [] });
  await main(['doctor', root]);
  const report = await doctorOutput(fake);
  assert.notEqual(process.exitCode, 2);
  assert.equal(report.codexAuthenticated, true);
  assert.equal(report.reviewer.backend, 'codex-cli');
  assert.equal(report.reviewer.command, 'codex review --base main');
  assert.equal(report.reviewer.available, true);
  assert.match(report.reviewer.officialPluginBackend, /not supported/);
  assert.equal(report.officialCodexPlugin.installed, false);
  assert.equal(report.officialCodexPlugin.status, 'not installed');
  assert.equal(report.officialCodexPlugin.inAutopilotSessions, 'switched off');
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.configProblems, []);
});

test('doctor reports the plugin when both the plugin and the Codex CLI are present', async (t) => {
  const root = await project(t);
  const fake = useFakeCli(t, { plugins: [PLUGIN] });
  await main(['doctor', root]);
  const report = await doctorOutput(fake);
  assert.notEqual(process.exitCode, 2);
  assert.equal(report.officialCodexPlugin.status, 'installed v1.0.6, enabled');
  assert.equal(report.reviewer.backend, 'codex-cli', 'the plugin never replaces the automated reviewer');
  assert.match(report.officialCodexPlugin.reviewGate, /not readable through a supported command/);
});

test('doctor fails when the Codex CLI is absent', async (t) => {
  const root = await project(t);
  const fake = useFakeCli(t, { missing: ['codex'], plugins: [PLUGIN] });
  await main(['doctor', root]);
  const report = await doctorOutput(fake);
  assert.equal(process.exitCode, 2);
  assert.equal(report.codexReviewAvailable, false);
  assert.equal(report.codexAuthenticated, false);
  assert.match(report.tools.codex, /^ERROR:/);
});

test('doctor reports plugin detection as unavailable without failing', async (t) => {
  const root = await project(t);
  const fake = useFakeCli(t, { results: { 'claude plugin list': { code: 1, stderr: "error: unknown command 'plugin'" } } });
  await main(['doctor', root]);
  const report = await doctorOutput(fake);
  assert.notEqual(process.exitCode, 2);
  assert.equal(report.officialCodexPlugin.detection, 'unavailable');
  assert.match(report.officialCodexPlugin.status, /^detection unavailable/);
});

test('doctor fails on an invalid config and lists the problem', async (t) => {
  const config = { ...buildConfig('/w', 'demo'), checks: ['npm test'] };
  config.reviewer.transport = 'official-plugin';
  const root = await project(t, config);
  const fake = useFakeCli(t);
  await main(['doctor', root]);
  assert.equal(process.exitCode, 2);
  assert.equal((await doctorOutput(fake)).configProblems.length, 1);
});

test('doctor warns when the plugin loads in Autopilot sessions', async (t) => {
  const root = await project(t, { ...buildConfig('/w', 'demo'), codexPlugin: { loadInAutopilotSessions: true } });
  const fake = useFakeCli(t, { plugins: [PLUGIN] });
  await main(['doctor', root]);
  const report = await doctorOutput(fake);
  assert.equal(report.officialCodexPlugin.inAutopilotSessions, 'loaded (codexPlugin.loadInAutopilotSessions is true)');
  assert.match(report.warnings.join('\n'), /review gate/);
  assert.notEqual(process.exitCode, 2);
});

test('doctor still warns about the opt-in when plugin detection is unavailable', async (t) => {
  const root = await project(t, { ...buildConfig('/w', 'demo'), codexPlugin: { loadInAutopilotSessions: true } });
  const fake = useFakeCli(t, { results: { 'claude plugin list': { code: 1, stderr: 'boom' } } });
  await main(['doctor', root]);
  const report = await doctorOutput(fake);
  assert.equal(report.officialCodexPlugin.detection, 'unavailable');
  assert.match(report.warnings.join('\n'), /loadInAutopilotSessions is true/);
});

test('doctor never prints the output of authentication commands', async (t) => {
  const root = await project(t);
  const fake = useFakeCli(t, {
    results: {
      'codex login status': { stdout: 'Logged in using an API key - sk-proj-SECRETSECRET' },
      'gh auth status': { stderr: 'Token: gho_SECRETSECRET' },
      'claude auth status': { stdout: '{"email":"secret-owner@example.com"}' },
    },
  });
  await main(['doctor', root]);
  assert.doesNotMatch(fake.text(), /SECRET|secret-owner/);
});

// ---------------------------------------------------------------- install-reviewer

test('install-reviewer explains the optional plugin and changes nothing by default', async (t) => {
  const root = await tempRoot(t);
  const fake = useFakeCli(t, { plugins: [] });
  await installReviewer(root);
  assert.deepEqual(installCalls(fake), []);
  for (const step of ['/plugin marketplace add openai/codex-plugin-cc', '/plugin install codex@openai-codex', '/reload-plugins', '/codex:setup']) {
    assert.ok(fake.text().includes(step), step);
  }
  assert.match(fake.text(), /Autopilot does not need it/);
});

test('install-reviewer --install-plugin refuses outside an interactive terminal', async (t) => {
  const root = await tempRoot(t);
  const fake = useFakeCli(t, { plugins: [] });
  await assert.rejects(installReviewer(root, { installPlugin: true, interactive: false }), /only runs in an interactive terminal .*Nothing was installed/);
  assert.deepEqual(installCalls(fake), []);
});

test('install-reviewer --install-plugin through the CLI never installs from a non-interactive process', async (t) => {
  const fake = useFakeCli(t, { plugins: [] });
  if (process.stdin.isTTY && process.stdout.isTTY) return t.skip('running in an interactive terminal');
  await assert.rejects(main(['install-reviewer', '--install-plugin']), /interactive terminal/);
  assert.deepEqual(installCalls(fake), []);
});

test('install-reviewer --install-plugin does nothing when the user declines', async (t) => {
  const root = await tempRoot(t);
  const fake = useFakeCli(t, { plugins: [] });
  await installReviewer(root, { installPlugin: true, interactive: true, confirm: async () => false });
  assert.deepEqual(installCalls(fake), []);
  assert.match(fake.text(), /Nothing was installed/);
});

test('install-reviewer --install-plugin runs only the documented install commands after a yes', async (t) => {
  const root = await tempRoot(t);
  const fake = useFakeCli(t, { plugins: [] });
  let question = '';
  await installReviewer(root, {
    installPlugin: true,
    interactive: true,
    confirm: async (text) => {
      question = text;
      fake.state.plugins = [PLUGIN];
      return true;
    },
  });
  assert.match(question, /\[y\/N\]/);
  assert.deepEqual(installCalls(fake).map((call) => call.line), [
    'claude plugin marketplace add openai/codex-plugin-cc',
    'claude plugin install codex@openai-codex',
  ]);
  assert.equal(fake.calls.some((call) => /review-gate|codex:setup/.test(call.line)), false, 'never enables the review gate');
  assert.match(fake.text(), /Official Codex plugin: installed v1\.0\.6, enabled/);
  assert.match(fake.text(), /\/codex:setup/);
});

test('install-reviewer skips installing when the plugin is already there', async (t) => {
  const root = await tempRoot(t);
  const fake = useFakeCli(t, { plugins: [PLUGIN] });
  await installReviewer(root, { installPlugin: true, interactive: true, confirm: async () => assert.fail('must not ask') });
  assert.deepEqual(installCalls(fake), []);
  assert.match(fake.text(), /Already installed/);
});

test('install-reviewer fails clearly when the Codex CLI is missing', async (t) => {
  const root = await tempRoot(t);
  useFakeCli(t, { missing: ['codex'] });
  await assert.rejects(installReviewer(root), /ENOENT|unavailable/);
});

// ---------------------------------------------------------------- attach / logs / stop / resume

const sessionsOnMachine = () => [
  background('7c5dcf5d', 'blocked', { cwd: '/work/demo' }),
  background('abcdef12', 'done', { cwd: '/work/other' }),
  { sessionId: '00000000-aaaa-4bbb-8ccc-000000000002', kind: 'interactive', cwd: '/work/demo', status: 'busy' },
];

test('attach accepts the short id', async (t) => {
  const root = await tempRoot(t);
  const fake = useFakeCli(t, { agents: sessionsOnMachine() });
  await main(['attach', '7c5dcf5d', root]);
  const call = fake.calls.find((item) => item.args[0] === 'attach');
  assert.equal(call.line, 'claude attach 7c5dcf5d');
  assert.equal(call.options.stdin, 'inherit');
});

test('attach accepts the full sessionId and passes Claude the short id', async (t) => {
  const root = await tempRoot(t);
  const fake = useFakeCli(t, { agents: sessionsOnMachine() });
  await main(['attach', SESSION_ID, root]);
  assert.ok(fake.calls.some((call) => call.line === 'claude attach 7c5dcf5d'));
  assert.match(fake.text(), /Using background session id 7c5dcf5d/);
});

test('resume accepts both the short id and the full sessionId', async (t) => {
  const root = await tempRoot(t);
  const fake = useFakeCli(t, { agents: sessionsOnMachine() });
  await main(['resume', '7c5dcf5d', root]);
  await main(['resume', SESSION_ID, root]);
  assert.deepEqual(fake.calls.filter((call) => call.args[0] === 'respawn').map((call) => call.line), ['claude respawn 7c5dcf5d', 'claude respawn 7c5dcf5d']);
});

test('logs and stop resolve ids and session names too', async (t) => {
  const root = await tempRoot(t);
  const fake = useFakeCli(t, { agents: sessionsOnMachine() });
  await main(['logs', 'autopilot-demo-7c5dcf', root]);
  await main(['stop', SESSION_ID.toUpperCase(), root]);
  assert.ok(fake.calls.some((call) => call.line === 'claude logs 7c5dcf5d'));
  assert.ok(fake.calls.some((call) => call.line === 'claude stop 7c5dcf5d'));
});

test('an unknown or stale session id fails with an actionable message and runs nothing', async (t) => {
  const root = await tempRoot(t);
  const fake = useFakeCli(t, { agents: sessionsOnMachine() });
  await assert.rejects(main(['logs', '0badc0de-1234-4abc-8def-000000000001', root]), /Use the "id" value from dev-autopilot status/);
  await assert.rejects(main(['attach', '00000000-aaaa-4bbb-8ccc-000000000002', root]), /interactive Claude Code session/);
  await assert.rejects(main(['stop']), /Missing session id for stop/);
  assert.equal(fake.calls.some((call) => ['logs', 'attach', 'stop'].includes(call.args[0])), false);
});

test('session commands pass the id through unchanged when sessions cannot be listed', async (t) => {
  const root = await tempRoot(t);
  const fake = useFakeCli(t, { results: { 'claude agents': { code: 1, stderr: 'agent view unavailable' } } });
  await main(['logs', '7c5dcf5d', root]);
  assert.ok(fake.calls.some((call) => call.line === 'claude logs 7c5dcf5d'));
  assert.match(fake.text(), /passing "7c5dcf5d" to Claude unchanged/);
});

// ---------------------------------------------------------------- status and cleanup

async function projectWithHistory(t) {
  const root = await project(t);
  useFakeCli(t);
  await main(['run', root]); // records 7c5dcf5d as the current task's session
  const agents = [
    background('7c5dcf5d', 'done', { cwd: root }),
    background('aaaaaaaa', 'working', { cwd: root }),
    background('bbbbbbbb', 'done', { cwd: root }),
    background('cccccccc', 'failed', { cwd: root }),
    background('dddddddd', 'done', { cwd: root, name: 'my manual session' }),
    background('eeeeeeee', 'done', { cwd: `${root}-sibling` }),
    { sessionId: '00000000-aaaa-4bbb-8ccc-000000000002', kind: 'interactive', cwd: root, status: 'busy' },
  ];
  return { root, agents };
}

test('status labels current, active and stale sessions and says which id to use', async (t) => {
  const { root, agents } = await projectWithHistory(t);
  const fake = useFakeCli(t, { agents });
  await main(['status', root]);
  const report = JSON.parse(fake.output.find((line) => line.startsWith('{')));
  const lifecycle = Object.fromEntries(report.sessions.map((session) => [session.id, session.autopilot.lifecycle]));
  assert.deepEqual(lifecycle, { '7c5dcf5d': 'current', aaaaaaaa: 'active', bbbbbbbb: 'stale', cccccccc: 'stale', dddddddd: 'stale' });
  assert.equal(report.sessions.find((session) => session.id === 'dddddddd').autopilot.owned, false);
  assert.equal(report.sessions[0].autopilot.useId, '7c5dcf5d');
  assert.equal(report.interactiveSessions, 1);
  assert.equal(report.currentTask.file, 'NEXT_TASK.md');
  assert.match(report.help.join('\n'), /full "sessionId" works too/);
});

test('cleanup is a dry run by default and removes nothing', async (t) => {
  const { root, agents } = await projectWithHistory(t);
  const fake = useFakeCli(t, { agents });
  await main(['cleanup', root]);
  assert.equal(fake.calls.some((call) => call.args[0] === 'rm'), false);
  assert.match(fake.text(), /would remove\s+bbbbbbbb/);
  assert.match(fake.text(), /would remove\s+cccccccc/);
  assert.match(fake.text(), /keep\s+7c5dcf5d .*belongs to the current task/);
  assert.match(fake.text(), /keep\s+aaaaaaaa .*still working/);
  assert.match(fake.text(), /keep\s+dddddddd .*not started by Autopilot/);
  assert.match(fake.text(), /Dry run: nothing was removed/);
});

test('cleanup --apply removes only stale Autopilot sessions with a plain claude rm', async (t) => {
  const { root, agents } = await projectWithHistory(t);
  const fake = useFakeCli(t, { agents, results: { 'claude rm cccccccc': { code: 1, stderr: 'kept cccccccc: worktree has unpushed commits' } } });
  await main(['cleanup', '--apply', root]);
  const removals = fake.calls.filter((call) => call.args[0] === 'rm');
  assert.deepEqual(removals.map((call) => call.line), ['claude rm bbbbbbbb', 'claude rm cccccccc']);
  assert.equal(removals.some((call) => call.args.some((arg) => /discard|force/.test(arg))), false);
  assert.match(fake.text(), /Removed bbbbbbbb/);
  assert.match(fake.text(), /Claude kept cccccccc: kept cccccccc: worktree has unpushed commits/);
  assert.equal(process.exitCode, 1);
});

test('cleanup keeps the current task session even when .autopilot/runtime/ was lost', async (t) => {
  const root = await project(t);
  const name = await launchedName(t, root);
  await fs.rm(path.join(root, '.autopilot', 'runtime'), { recursive: true, force: true });

  const fake = useFakeCli(t, { agents: [background('5e55e55e', 'done', { cwd: root, name }), background('bbbbbbbb', 'done', { cwd: root })] });
  await main(['cleanup', '--apply', root]);

  assert.deepEqual(fake.calls.filter((call) => call.args[0] === 'rm').map((call) => call.line), ['claude rm bbbbbbbb']);
  assert.match(fake.text(), /keep\s+5e55e55e .*belongs to the current task/);
});

test('cleanup never removes a user session that only shares the name prefix', async (t) => {
  const root = await project(t);
  const fake = useFakeCli(t, { agents: [background('aaaaaaaa', 'done', { cwd: root, name: 'autopilot-demo-investigation' })] });
  await main(['cleanup', '--apply', root]);
  assert.equal(fake.calls.some((call) => call.args[0] === 'rm'), false);
  assert.match(fake.text(), /keep\s+aaaaaaaa .*not started by Autopilot/);
});

test('cleanup refuses to act when sessions cannot be listed', async (t) => {
  const root = await project(t);
  const fake = useFakeCli(t, { results: { 'claude agents': { code: 1, stderr: 'boom' } } });
  await assert.rejects(main(['cleanup', '--apply', root]), /nothing was removed: boom/);
  assert.equal(fake.calls.some((call) => call.args[0] === 'rm'), false);
});

test('unknown flags are rejected instead of being ignored', async (t) => {
  const root = await project(t);
  const fake = useFakeCli(t);
  await assert.rejects(main(['cleanup', '--aply', root]), /Unknown option '--aply'/);
  assert.equal(fake.calls.length, 0);
});
