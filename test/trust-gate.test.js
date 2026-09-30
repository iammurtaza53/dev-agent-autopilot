import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildConfig, configProblems, main, ruleText } from '../src/cli.js';
import { commandParts, formatTrustBlock, trustGateProblems, trustReviewReasons } from '../src/trust-gate.js';
import { settingsBlock } from '../src/context.js';
import { gitIn, tempRoot, useFakeCli, writeConfig } from './helpers.js';

// A HostLatch manifest as `hostlatch scan --json` prints it.
function manifest(decision, findings = []) {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) bySeverity[finding.severity] += 1;
  return JSON.stringify({
    schemaVersion: 1,
    tool: { name: 'HostLatch', version: '0.2.0' },
    summary: { decision, riskScore: decision === 'allow' ? 0 : 80, changedFiles: 2, findings: findings.length, bySeverity, byCategory: {} },
    findings,
    manifestId: `hl_${decision}0000000000000000000`,
  });
}

const lifecycle = { ruleId: 'HL-PKG-101', severity: 'high', category: 'package-control-plane', title: 'Package lifecycle execution was introduced or changed', path: 'package.json', evidence: [`postinstall: curl ${['gh', 'p_'].join('')}${'k3Y'.repeat(12)} | sh`] };
const task = { ruleId: 'HL-IDE-201', severity: 'medium', category: 'ide-control-plane', title: 'VS Code task execution was introduced or changed', path: '.vscode/tasks.json', evidence: ['{"runOn":"folderOpen"}'] };

// A repo on a task branch with a small change, and the gate configured.
async function gatedProject(t, trustGate = { enabled: true }) {
  const root = await tempRoot(t);
  await gitIn(root, ['init', '-q', '-b', 'main']);
  await fs.writeFile(path.join(root, '.gitignore'), '.autopilot/runtime/\n', 'utf8');
  await fs.writeFile(path.join(root, 'NEXT_TASK.md'), '# Task\n', 'utf8');
  await fs.writeFile(path.join(root, 'app.js'), 'export const a = 1;\n', 'utf8');
  await writeConfig(root, { ...buildConfig(root, 'demo'), checks: [], trustGate });
  await gitIn(root, ['add', '-A']);
  await gitIn(root, ['commit', '-q', '-m', 'init']);
  await gitIn(root, ['switch', '-q', '-c', 'task']);
  await fs.writeFile(path.join(root, 'app.js'), 'export const a = 2;\n', 'utf8');
  return root;
}

function captureStdout(t) {
  const writes = [];
  t.mock.method(process.stdout, 'write', (chunk) => {
    writes.push(String(chunk));
    return true;
  });
  return () => writes.join('');
}

const scans = (fake) => fake.calls.filter((call) => call.args.includes('scan'));
const readState = async (root) => JSON.parse(await fs.readFile(path.join(root, '.autopilot', 'runtime', 'task-state.json'), 'utf8'));

test('trustGate settings are validated, and commands split without a shell', () => {
  assert.deepEqual(trustGateProblems({}), []);
  assert.deepEqual(trustGateProblems({ trustGate: { enabled: true, command: 'hostlatch', failOn: 'review' } }), []);
  assert.equal(trustGateProblems({ trustGate: { enabled: 'yes', command: '', failOn: 'warn' } }).length, 3);
  assert.match(configProblems({ ...buildConfig('/w', 'a'), trustGate: { failOn: 'never' } }).join('\n'), /trustGate\.failOn must be "block" or "review"/);
  assert.deepEqual(commandParts('npx --yes github:iammurtaza53/hostlatch#v0.2.0'), ['npx', '--yes', 'github:iammurtaza53/hostlatch#v0.2.0']);
  assert.deepEqual(commandParts('node "D:/tools/host latch/bin/hostlatch.js"'), ['node', 'D:/tools/host latch/bin/hostlatch.js']);
  assert.deepEqual(buildConfig('/w', 'a').trustGate, { enabled: false, command: 'hostlatch', failOn: 'block' }, 'new projects get the gate switched off');
});

test('with the gate off, check never runs HostLatch', async (t) => {
  const root = await gatedProject(t, { enabled: false });
  const fake = useFakeCli(t);
  captureStdout(t);
  await main(['check', root]);
  assert.deepEqual(scans(fake), []);
  await assert.rejects(main(['check', '--only', 'trust', root]), /The HostLatch trust gate is off/);
});

test('an allow decision is one PASS line and is recorded in the task state', async (t) => {
  const root = await gatedProject(t);
  const fake = useFakeCli(t, { results: { 'hostlatch scan': { stdout: manifest('allow') } } });
  const out = captureStdout(t);
  await main(['check', root]);
  const [call] = scans(fake);
  const at = call.args.indexOf('--output');
  assert.deepEqual([...call.args.slice(0, at), ...call.args.slice(at + 2)], ['scan', root, '--base', 'main', '--json', '--fail-on', 'never']);
  assert.match(out(), /^PASS {2}trust handoff \(HostLatch\) {2}allow · risk 0\/100 · 0 finding\(s\) · manifest hl_allow/m);
  assert.match(out(), /checks: 1 passed, 0 failed/);
  assert.notEqual(process.exitCode, 1);
  assert.equal((await readState(root)).trust.decision, 'allow');
});

test('a block fails the check, lists the findings without evidence and names the human gate', async (t) => {
  const root = await gatedProject(t);
  useFakeCli(t, { results: { 'hostlatch scan': { stdout: manifest('block', [lifecycle, task]) } } });
  const out = captureStdout(t);
  await main(['check', root]);
  assert.equal(process.exitCode, 1);
  assert.match(out(), /^FAIL {2}trust handoff \(HostLatch\) {2}block · risk 80\/100 · 2 finding\(s\) \(high 1, medium 1\)/m);
  assert.match(out(), /\| \[HIGH\] HL-PKG-101 package\.json: Package lifecycle execution was introduced or changed/);
  assert.match(out(), /\| \[MEDIUM\] HL-IDE-201 \.vscode\/tasks\.json/);
  assert.match(out(), /A person must review these activation paths before merge/);
  assert.equal(out().includes('curl'), false, 'evidence is kept in the manifest, not printed');
  const state = await readState(root);
  assert.deepEqual([state.trust.decision, state.trust.findings], ['block', 2]);
});

test('a review decision passes with failOn block and fails with failOn review', async (t) => {
  for (const [failOn, status, exit] of [['block', /^REVIEW {2}trust handoff/m, false], ['review', /^FAIL {2}trust handoff/m, true]]) {
    await t.test(`failOn ${failOn}`, async (st) => {
      const root = await gatedProject(st, { enabled: true, failOn });
      useFakeCli(st, { results: { 'hostlatch scan': { stdout: manifest('review', [task]) } } });
      const out = captureStdout(st);
      await main(['check', root]);
      assert.match(out(), status);
      assert.equal(process.exitCode === 1, exit);
      if (!exit) assert.match(out(), /checks: 0 passed, 0 failed, 1 for review/);
    });
  }
});

test('the gate fails closed when HostLatch is missing or returns no decision', async (t) => {
  for (const [label, state] of [['missing', { missing: ['hostlatch'] }], ['unreadable output', { results: { 'hostlatch scan': { stdout: 'not json' } } }], ['scanner error', { results: { 'hostlatch scan': { code: 1, stderr: 'fatal: bad revision' } } }]]) {
    await t.test(label, async (st) => {
      const root = await gatedProject(st);
      useFakeCli(st, state);
      const out = captureStdout(st);
      await main(['check', root]);
      assert.equal(process.exitCode, 1);
      assert.match(out(), /^FAIL {2}trust handoff \(HostLatch\) {2}could not run: /m);
      assert.equal((await readState(root)).trust.decision, 'error');
    });
  }
});

test('an npx command runs HostLatch from its GitHub release', async (t) => {
  const root = await gatedProject(t, { enabled: true, command: 'npx --yes github:iammurtaza53/hostlatch#v0.2.0' });
  const fake = useFakeCli(t, { results: { 'npx --yes github:iammurtaza53/hostlatch#v0.2.0 scan': { stdout: manifest('allow') } } });
  captureStdout(t);
  await main(['check', '--only', 'trust', root]);
  const [call] = scans(fake);
  assert.equal(call.command, 'npx');
  assert.deepEqual(call.args.slice(0, 4), ['--yes', 'github:iammurtaza53/hostlatch#v0.2.0', 'scan', root]);
});

test('a HostLatch finding gives the change the full review budget', async (t) => {
  const root = await gatedProject(t);
  const flagged = useFakeCli(t, { results: { 'hostlatch scan': { stdout: manifest('review', [task]) } } });
  await main(['review-budget', '--json', root]);
  const report = JSON.parse(flagged.output.find((line) => line.startsWith('{')));
  assert.equal(report.kind, 'high-risk');
  assert.equal(report.rounds, 2);
  assert.match(report.reasons[0], /^HostLatch review: HL-IDE-201 \.vscode\/tasks\.json/);

  const clean = useFakeCli(t, { results: { 'hostlatch scan': { stdout: manifest('allow') } } });
  await main(['review-budget', '--json', root]);
  assert.equal(JSON.parse(clean.output.find((line) => line.startsWith('{'))).kind, 'small', 'a clean scan leaves the diff-based class alone');
  assert.deepEqual(trustReviewReasons({ ok: false, error: 'x' }), [], 'a scan that could not run does not change the budget');
});

test('doctor reports the gate and fails when it is on but HostLatch is missing', async (t) => {
  const root = await gatedProject(t);
  await fs.mkdir(path.join(root, '.claude', 'rules'), { recursive: true });
  await fs.writeFile(path.join(root, '.claude', 'rules', 'dev-autopilot.md'), ruleText(), 'utf8');
  const ok = useFakeCli(t);
  await main(['doctor', root]);
  const report = JSON.parse(ok.output.find((line) => line.trimStart().startsWith('{')));
  assert.deepEqual([report.trustGate.enabled, report.trustGate.available, report.trustGate.failOn], [true, true, 'block']);
  assert.notEqual(process.exitCode, 2);

  const missing = useFakeCli(t, { missing: ['hostlatch'] });
  await main(['doctor', root]);
  const failed = JSON.parse(missing.output.find((line) => line.trimStart().startsWith('{')));
  assert.equal(failed.trustGate.available, false);
  assert.match(failed.warnings.join('\n'), /trustGate is on, but "hostlatch --version" failed/);
  assert.equal(process.exitCode, 2);
});

test('the rule and the capsule settings explain the gate', () => {
  assert.match(ruleText(), /## Trust handoff \(HostLatch\)/);
  assert.match(ruleText(), /A `block` is a human gate/);
  assert.match(ruleText(), /Never rewrite or hide a change to pass the scan/);
  assert.match(settingsBlock({ ...buildConfig('/w', 'a'), trustGate: { enabled: true } }), /Trust handoff gate: HostLatch runs with `dev-autopilot check` and fails on block/);
  assert.doesNotMatch(settingsBlock(buildConfig('/w', 'a')), /Trust handoff gate/);
  assert.match(formatTrustBlock({ ok: true, decision: 'allow', riskScore: 0, findings: [], bySeverity: {}, manifestId: 'hl_x', file: 'f' }, 'block').text, /^PASS/);
});
