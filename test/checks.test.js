import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { failureExcerpt, normalizeChecks, passSummary, runChecks, runLogged, treeFingerprint } from '../src/checks.js';
import { buildConfig, main } from '../src/cli.js';
import { resolveRoots } from '../src/runtime.js';
import { gitIn, tempRoot, useFakeCli, writeConfig } from './helpers.js';

const ESC = '\u001b';

// A script that prints `lines` passing lines with colour codes, then optionally fails.
const VERBOSE = `const [lines, fail] = process.argv.slice(2).map(Number);
for (let i = 1; i <= lines; i += 1) console.log('${ESC}[32m✓${ESC}[39m suite > passes case ' + i);
if (fail) {
  console.error('${ESC}[31m×${ESC}[39m suite > breaks case ' + fail);
  console.error("AssertionError: expected 'held' to be 'released'");
  console.error('token ' + ['gh', 'p_', 'Z9y8'.repeat(9)].join(''));
  console.log('Tests  1 failed | ' + (lines - 1) + ' passed (' + lines + ')');
  process.exit(3);
}
console.log('Tests  ' + lines + ' passed (' + lines + ')');
`;

async function checkProject(t, checks) {
  const root = await tempRoot(t);
  await gitIn(root, ['init', '-q', '-b', 'main']);
  await fs.writeFile(path.join(root, '.gitignore'), '.autopilot/runtime/\n', 'utf8');
  await fs.writeFile(path.join(root, 'verbose.js'), VERBOSE, 'utf8');
  await fs.writeFile(path.join(root, 'NEXT_TASK.md'), '# Task\n', 'utf8');
  const config = { ...buildConfig(root, 'demo'), checks };
  await writeConfig(root, config);
  await gitIn(root, ['add', '-A']);
  await gitIn(root, ['commit', '-q', '-m', 'init']);
  return { root, config };
}

const at = (iso) => () => new Date(iso);

test('a passing check prints one line and keeps the complete output on disk', async (t) => {
  const { root, config } = await checkProject(t, ['node verbose.js 500']);
  const outcome = await runChecks({ workRoot: root, stateRoot: root, config, taskHash: 'a'.repeat(64), now: at('2026-09-29T10:00:00Z') });
  assert.equal(outcome.status, 'pass');
  assert.match(outcome.output, /^PASS {2}node verbose\.js 500 {2}\(\d+(ms|\.\ds)\) · 500 passed \(500\)\nchecks: 1 passed, 0 failed\n$/);
  const [result] = outcome.results;
  const log = await fs.readFile(result.logFile, 'utf8');
  assert.equal((log.match(/passes case/g) || []).length, 500, 'every line is kept');
  assert.ok(log.includes(`${ESC}[32m`), 'the log is the raw output');
  assert.equal(result.logBytes, Buffer.byteLength(log));
  assert.ok(result.compactBytes < 120);
  assert.equal(path.dirname(path.dirname(result.logFile)), path.join(root, '.autopilot', 'runtime', 'checks', 'aaaaaaaaaaaa'));
});

test('a failing check shows the exit code, the log path and a bounded, redacted excerpt; nothing is hidden', async (t) => {
  const { root, config } = await checkProject(t, ['node verbose.js 400 217']);
  const outcome = await runChecks({ workRoot: root, stateRoot: root, config, taskHash: null, now: at('2026-09-29T10:00:00Z') });
  assert.equal(outcome.status, 'fail');
  const [result] = outcome.results;
  assert.equal(result.exitCode, 3);
  assert.match(outcome.output, /^FAIL {2}node verbose\.js 400 217 {2}exit 3 /);
  assert.ok(outcome.output.includes(`log: ${result.logFile}`));
  assert.ok(outcome.output.includes('breaks case 217'));
  assert.ok(outcome.output.includes("AssertionError: expected 'held' to be 'released'"));
  assert.ok(outcome.output.includes('Tests  1 failed | 399 passed (400)'), 'the runner summary at the end is kept');
  assert.equal(outcome.output.includes(ESC), false, 'no ANSI codes in the compact output');
  assert.match(outcome.output, /\[REDACTED GitHub token\]/);
  assert.ok(outcome.output.split('\n').length < 75, 'bounded');
  const log = await fs.readFile(result.logFile, 'utf8');
  assert.equal((log.match(/passes case/g) || []).length, 400, 'the full log keeps every line');
  assert.ok(log.includes(['gh', 'p_'].join('')), 'the full local log is not redacted');
  assert.match(outcome.output, /checks: 0 passed, 1 failed · full log: dev-autopilot check --log <name>/);
});

test('an unchanged tree reuses a pass; any change, --force or an earlier failure reruns', async (t) => {
  const { root, config } = await checkProject(t, ['node verbose.js 20', { name: 'unit', command: 'node verbose.js 5' }]);
  const run = (options = {}) => runChecks({ workRoot: root, stateRoot: root, config, taskHash: null, now: at('2026-09-29T10:00:00Z'), ...options });
  const first = await run();
  assert.deepEqual(first.results.map((result) => result.status), ['pass', 'pass']);
  const second = await run({ now: at('2026-09-29T10:05:00Z') });
  assert.deepEqual(second.results.map((result) => result.status), ['reused', 'reused']);
  assert.match(second.output, /PASS {2}unit {2}\(reused: tree unchanged since 2026-09-29 10:00:00 UTC; --force reruns\)/);

  await fs.writeFile(path.join(root, 'verbose.js'), `${VERBOSE}// edited\n`);
  assert.deepEqual((await run({ now: at('2026-09-29T10:10:00Z') })).results.map((result) => result.status), ['pass', 'pass'], 'a tracked change');
  await fs.writeFile(path.join(root, 'new-file.txt'), 'x');
  assert.deepEqual((await run({ now: at('2026-09-29T10:15:00Z') })).results.map((result) => result.status), ['pass', 'pass'], 'an untracked file');
  assert.deepEqual((await run({ now: at('2026-09-29T10:20:00Z'), force: true })).results.map((result) => result.status), ['pass', 'pass'], '--force');

  const failing = { ...config, checks: ['node verbose.js 3 2'] };
  await runChecks({ workRoot: root, stateRoot: root, config: failing, taskHash: null, now: at('2026-09-29T10:25:00Z') });
  const again = await runChecks({ workRoot: root, stateRoot: root, config: failing, taskHash: null, now: at('2026-09-29T10:30:00Z') });
  assert.equal(again.results[0].status, 'fail', 'a failure is never reused');
});

test('treeFingerprint changes with staged, unstaged and untracked content', async (t) => {
  const { root } = await checkProject(t, []);
  const base = await treeFingerprint(root);
  assert.equal(await treeFingerprint(root), base);
  await fs.writeFile(path.join(root, 'NEXT_TASK.md'), '# Task\n\nchanged\n');
  const unstaged = await treeFingerprint(root);
  assert.notEqual(unstaged, base);
  await fs.writeFile(path.join(root, 'extra.txt'), 'x');
  assert.notEqual(await treeFingerprint(root), unstaged);
});

test('--bail skips the checks after a failure, and --only picks checks by name or position', async (t) => {
  const { root, config } = await checkProject(t, ['node verbose.js 2 1', 'node verbose.js 2']);
  const bailed = await runChecks({ workRoot: root, stateRoot: root, config, taskHash: null, bail: true, now: at('2026-09-29T10:00:00Z') });
  assert.deepEqual(bailed.results.map((result) => result.status), ['fail', 'skipped']);
  assert.match(bailed.output, /SKIP {2}node verbose\.js 2 {2}\(after an earlier failure; --bail\)/);
  const only = await runChecks({ workRoot: root, stateRoot: root, config, taskHash: null, only: '2', now: at('2026-09-29T10:01:00Z') });
  assert.deepEqual(only.results.map((result) => result.name), ['node verbose.js 2']);
  await assert.rejects(runChecks({ workRoot: root, stateRoot: root, config, taskHash: null, only: 'lint' }), /No configured check matches "lint"\. Configured: 1\. node verbose\.js 2 1, 2\. node verbose\.js 2/);
});

test('normalizeChecks accepts v0.4 command strings and { name, command } objects', () => {
  assert.deepEqual(normalizeChecks({ checks: ['npm test', { name: 'lint', command: 'npm run lint' }, 'npm test', { command: '' }] }), [
    { name: 'npm test', command: 'npm test' },
    { name: 'lint', command: 'npm run lint' },
    { name: 'npm test #2', command: 'npm test' },
  ]);
});

test('runLogged stops a check that exceeds its timeout and records why', async (t) => {
  const root = await tempRoot(t);
  const logFile = path.join(root, 'slow.log');
  const result = await runLogged('node -e "console.log(\'started\'); setTimeout(() => {}, 20000)"', { cwd: root, logFile, timeoutMs: 400 });
  assert.equal(result.timedOut, true);
  assert.equal(result.code, 124);
  const log = await fs.readFile(logFile, 'utf8');
  assert.match(log, /started/);
  assert.match(log, /timed out after 0s/);
});

test('failureExcerpt anchors on failures, not on passing lines that mention errors, and marks gaps', () => {
  const lines = [];
  for (let i = 1; i <= 300; i += 1) lines.push(i === 50 ? '✔ handles error paths' : `✔ case ${i}`);
  lines.splice(200, 0, '✖ case broke', "AssertionError: expected 1 to equal 2", '    at test.js:10:5');
  lines.push('ℹ fail 1');
  const { text, shownLines, totalLines } = failureExcerpt(lines.join('\n'), { maxLines: 20, maxBytes: 4000 });
  assert.equal(totalLines, 304);
  assert.ok(shownLines <= 25);
  assert.ok(text.includes('AssertionError: expected 1 to equal 2'));
  assert.equal(text.includes('handles error paths'), false);
  assert.match(text, /^… \(\d+ earlier lines\)/);
  assert.ok(text.trimEnd().endsWith('ℹ fail 1'));
  const capped = failureExcerpt('x'.repeat(10000), { maxLines: 20, maxBytes: 1000 });
  assert.ok(Buffer.byteLength(capped.text) <= 1100);
});

test('passSummary reads the common test-runner summaries and stays empty otherwise', () => {
  assert.equal(passSummary('ℹ tests 93\nℹ suites 0\nℹ pass 93\nℹ fail 0\nℹ skipped 2'), '93 passed, 2 skipped');
  assert.equal(passSummary('Tests:       41 passed, 41 total\nTime: 2s'), '41 passed, 41 total');
  assert.equal(passSummary('====== 12 passed, 1 skipped in 0.52s ======'), '12 passed, 1 skipped');
  assert.equal(passSummary('test result: ok. 7 passed; 0 failed; 0 ignored'), '7 passed');
  assert.equal(passSummary('  15 passing (30ms)'), '15 passed');
  assert.equal(passSummary('ok  \texample.com/a\t0.1s\nok  \texample.com/b\t0.2s'), '2 packages ok');
  assert.equal(passSummary('Linting done.'), '');
});

// ---------------------------------------------------------------- the check command

test('dev-autopilot check prints quiet results, records task state and metrics, and exits 1 on failure', async (t) => {
  const { root } = await checkProject(t, ['node verbose.js 50', 'node verbose.js 4 3']);
  const fake = useFakeCli(t);
  const writes = [];
  t.mock.method(process.stdout, 'write', (chunk) => {
    writes.push(String(chunk));
    return true;
  });
  await main(['check', root]);
  const printed = writes.join('');
  assert.match(printed, /PASS {2}node verbose\.js 50/);
  assert.match(printed, /FAIL {2}node verbose\.js 4 3 {2}exit 3/);
  assert.equal(process.exitCode, 1);
  const state = JSON.parse(await fs.readFile(path.join(root, '.autopilot', 'runtime', 'task-state.json'), 'utf8'));
  assert.equal(state.checks.status, 'fail');
  assert.equal(state.checks.passed, 1);
  assert.equal(state.checks.total, 2);
  const ledger = (await fs.readFile(path.join(root, '.autopilot', 'runtime', 'efficiency.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(ledger.map((event) => [event.type, event.status]), [['check', 'pass'], ['check', 'fail']]);
  assert.ok(ledger[0].logBytes > ledger[0].compactBytes);

  writes.length = 0;
  await main(['check', '--log', '2', root]);
  assert.match(writes.join(''), /--- node verbose\.js 4 3: fail, .*02-node-verbose-js-4-3\.log ---\n[\s\S]*breaks case 3/);
  assert.equal(fake.calls.filter((call) => call.command !== 'git').length, 0, 'no claude or codex calls');
});

test('dev-autopilot check says so when no checks are configured', async (t) => {
  const { root } = await checkProject(t, []);
  useFakeCli(t);
  const writes = [];
  t.mock.method(process.stdout, 'write', (chunk) => {
    writes.push(String(chunk));
    return true;
  });
  await main(['check', root]);
  assert.match(writes.join(''), /No checks are configured in "checks"/);
  assert.notEqual(process.exitCode, 1);
});

test('inside a linked worktree, checks run in the worktree and their state lands in the main checkout', async (t) => {
  const { root } = await checkProject(t, ['node verbose.js 3']);
  const worktree = path.join(root, '.claude', 'worktrees', 'task-1');
  await gitIn(root, ['worktree', 'add', '-q', '-b', 'task-1', worktree]);
  t.after(() => gitIn(root, ['worktree', 'remove', '--force', worktree]).catch(() => {}));
  const roots = await resolveRoots(path.join(worktree, 'src-does-not-exist', '..'));
  assert.equal(path.resolve(roots.workRoot).toLowerCase(), path.resolve(await fs.realpath(worktree)).toLowerCase());
  assert.equal(path.resolve(roots.stateRoot).toLowerCase(), path.resolve(await fs.realpath(root)).toLowerCase());

  useFakeCli(t);
  t.mock.method(process.stdout, 'write', () => true);
  await main(['check', worktree]);
  const state = JSON.parse(await fs.readFile(path.join(root, '.autopilot', 'runtime', 'task-state.json'), 'utf8'));
  assert.equal(state.checks.status, 'pass');
  assert.equal(await fs.stat(path.join(worktree, '.autopilot', 'runtime', 'task-state.json')).catch(() => null), null);
});
