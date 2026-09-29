#!/usr/bin/env node
// LeanLoop benchmark: the bytes that v0.4.0-style orchestration puts in front of the agents, compared with
// LeanLoop, on deterministic fixtures. It runs the real v0.4.1 code (`run` with the Context Capsule, quiet checks
// on real processes, the adaptive review policy on a real git diff, Delta Resume) in a temporary repository built
// from bench/fixtures/. The v0.4.0 side uses v0.4.0's exact launch prompt and rule (test/fixtures/benchmark/v0.4.0/).
//
// Measured in UTF-8 bytes of text an agent is given or told to read:
// - context: the launch prompt plus the files it tells the agent to read at the start
// - project memory: the Autopilot rule and CLAUDE.md, which Claude Code loads into every session in both versions
// - checks: what the agent sees from each check run. v0.4.0: the raw output with ANSI codes removed, capped at
//   30,000 characters (Claude Code's default Bash output limit). v0.4.1: the output of dev-autopilot check.
// - codex: plan and review text the agent reads. v0.4.0 is credited with the final text only, with none of Codex's
//   progress output, which favours v0.4.0.
// - resume: messages Autopilot sends when a stopped session continues.
// These are orchestration-layer bytes, not provider-billed tokens.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { byteLength, runProcess, stripAnsi } from '../src/lib.js';
import { buildConfig, main, ruleText, setClock, setProcessRunner } from '../src/cli.js';
import { runChecks } from '../src/checks.js';
import { classifyChange, collectDiff, reviewBudget } from '../src/review-policy.js';
import { codexPlan, codexReview } from '../src/codex-run.js';
import { sessionName } from '../src/sessions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const V040 = path.join(HERE, '..', 'test', 'fixtures', 'benchmark', 'v0.4.0');
const BASH_OUTPUT_LIMIT = 30000;
const CONTEXT_FILES = ['CLAUDE.md', 'AGENTS.md', 'PROJECT_STATE.md', 'DECISIONS.md', 'ARCHITECTURE.md'];
const GIT_CONFIG = ['-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];
const NOW = new Date('2026-09-29T10:00:00Z');

async function read(file) {
  return fs.readFile(file, 'utf8');
}

async function write(root, rel, text) {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
}

async function git(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const result = await runProcess('git', [...GIT_CONFIG, '-c', `core.excludesFile=${path.join(root, '.git', 'none')}`, ...args], { cwd: root, env });
  if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

// A stand-in for the claude and codex CLIs; git runs for real.
function fakeRunner(state) {
  const calls = [];
  const runner = async (command, args = [], options = {}) => {
    calls.push({ command, args: [...args] });
    if (command === 'git') return runProcess(command, args, options);
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false });
    if (command === 'claude' && args[0] === 'agents') return ok(JSON.stringify(state.agents || []));
    if (command === 'claude' && args[0] === '--bg' && args[1] === '--resume') return ok(`backgrounded · ${String(args[2]).slice(0, 8)} · resumed\n`);
    if (command === 'claude' && args[0] === '--bg') return ok('backgrounded · 7c5dcf5d · autopilot\n');
    if (command === 'codex' && state.codexOutput) return ok(state.codexOutput());
    return ok('');
  };
  return { runner, calls };
}

async function quietly(fn) {
  const log = console.log;
  const exitCode = process.exitCode;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    process.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------- the fixture project

const SOURCES = {
  'package.json': '{\n  "name": "acme-orders",\n  "version": "0.4.2",\n  "private": true,\n  "type": "module"\n}\n',
  'src/orders/format.ts': `export function formatOrderNumber(year: number, sequence: number): string {
  return \`AC-\${year}-\${String(sequence).padStart(6, '0')}\`;
}

export function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amountMinor / 100);
}
`,
  'src/api/routes/orders.ts': `import type { Deps } from '../deps.js';

export function register(app, deps: Deps) {
  app.get('/orders/:id', async (request) => {
    const order = await deps.orders.get(request.params.id);
    return { ...order, number: 'AC' + order.year + order.sequence };
  });
  app.get('/orders', async (request) => {
    const page = await deps.orders.list(request.query);
    return { ...page, items: page.items.map((order) => ({ ...order, number: 'AC' + order.year + order.sequence })) };
  });
}
`,
  'test/api/orders.test.ts': `import { describe, expect, it } from 'vitest';
import { buildApp } from '../helpers/app.js';

describe('orders routes', () => {
  it('returns one order', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/orders/1' });
    expect(response.statusCode).toBe(200);
  });
});
`,
  'src/inventory/reservations.ts': `import { query } from '../db/query.js';
import { withTransaction } from '../db/tx.js';

export async function reserve(orderId: string, lines) {
  return withTransaction(async (tx) => {
    for (const line of lines) await query(tx, 'insert into inventory_reservations (order_id, sku, quantity, status, expires_at) values ($1, $2, $3, $4, $5)', [orderId, line.sku, line.quantity, 'held', line.expiresAt]);
  });
}

export async function commit(orderId: string) {
  return withTransaction((tx) => query(tx, "update inventory_reservations set status = 'committed' where order_id = $1 and status = 'held'", [orderId]));
}

export async function release(orderId: string, reason: string) {
  return withTransaction((tx) => query(tx, "update inventory_reservations set status = 'released', release_reason = $2 where order_id = $1 and status = 'held'", [orderId, reason]));
}
`,
  'src/jobs/index.ts': `import outboxProcessor from './outbox-processor.js';
import reportingExport from './reporting-export.js';

export const jobs = [outboxProcessor, reportingExport];
`,
  'docs/operations.md': `# Operations runbook

## Releasing stuck stock

When a customer reports an item as out of stock but the warehouse has it, find reservations that are stuck and
free them. Use the admin console, search the order, and choose "free stock".

Dashboards: https://grafana.example.invalid/d/old-stock

## Reconciliation mismatches

Finance on-call receives the page. Compare the payout report with the payment events table.
`,
};

async function createProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leanloop-bench-'));
  await git(root, ['init', '-q', '-b', 'main']);
  for (const file of CONTEXT_FILES) await write(root, file, await read(path.join(FIXTURES, 'acme-orders', file)));
  for (const [file, text] of Object.entries(SOURCES)) await write(root, file, text);
  await write(root, 'bench/verbose-tests.js', await read(path.join(FIXTURES, 'verbose-tests.js')));
  await write(root, 'bench/quiet-check.js', await read(path.join(FIXTURES, 'quiet-check.js')));
  await write(root, '.gitignore', 'node_modules/\n.autopilot/runtime/\n.claude/worktrees/\n');
  const config = buildConfig(root, 'acme-orders');
  config.project.contextFiles = [...CONTEXT_FILES];
  await write(root, '.autopilot/config.json', `${JSON.stringify(config, null, 2)}\n`);
  await write(root, '.claude/rules/dev-autopilot.md', ruleText());
  await write(root, 'NEXT_TASK.md', '# No task yet\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-q', '-m', 'acme-orders fixture']);
  return { root, config };
}

// The config as v0.4.0's `init` wrote it: no LeanLoop, adaptive or quota sections, and three review rounds.
function v040Config(config) {
  const { leanloop, quota, ...rest } = config;
  const { adaptive, ...reviewer } = rest.reviewer;
  return { ...rest, reviewer: { ...reviewer, maxRounds: 3 } };
}

function checkCommands(tests) {
  return [
    { name: 'npm run lint', command: 'node bench/quiet-check.js lint' },
    { name: 'npm run typecheck', command: 'node bench/quiet-check.js typecheck' },
    { name: 'npm test', command: `node bench/verbose-tests.js ${tests}` },
  ];
}

// ---------------------------------------------------------------- scenario steps

async function launch(root, config, taskText) {
  await write(root, 'NEXT_TASK.md', taskText);
  await write(root, '.autopilot/config.json', `${JSON.stringify(config, null, 2)}\n`);
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-q', '-m', 'task']);
  const fake = fakeRunner({ agents: [] });
  setProcessRunner(fake.runner);
  await quietly(() => main(['run', root]));
  setProcessRunner(null);
  const bg = fake.calls.find((call) => call.command === 'claude' && call.args[0] === '--bg');
  const prompt = bg.args.at(-1);
  const capsulePath = /Context Capsule at (.+?\.md)/.exec(prompt)[1];
  const capsule = await read(capsulePath);
  return { prompt, capsule, capsulePath };
}

// v0.4.0's launch: its exact prompt, then the config, the task and every configured context file.
async function v040Launch(root, config, taskText) {
  const prompt = await read(path.join(V040, 'launch-prompt.txt'));
  const configText = `${JSON.stringify(v040Config(config), null, 2)}\n`;
  const files = {};
  for (const file of CONTEXT_FILES) files[file] = await read(path.join(root, file));
  return { prompt, configText, taskText, files };
}

let runClock = NOW.getTime();

async function checkRuns(root, config, runs) {
  const results = [];
  for (const { tests, failAt, change } of runs) {
    if (change) await change();
    const runConfig = { ...config, checks: checkCommands(`${tests}${failAt ? ` ${failAt}` : ''}`) };
    runClock += 60000;
    const startedAt = new Date(runClock);
    const outcome = await runChecks({ workRoot: root, stateRoot: root, config: runConfig, taskHash: null, now: () => startedAt });
    let v040 = 0;
    for (const result of outcome.results) {
      const raw = stripAnsi(await read(result.logFile));
      v040 += byteLength(raw.slice(0, BASH_OUTPUT_LIMIT));
    }
    results.push({ v040, v041: byteLength(outcome.output), output: outcome.output, outcome });
  }
  return results;
}

async function codexText(root, config, taskHash, { rounds, budget }) {
  const plan = await read(path.join(FIXTURES, 'codex', 'plan.txt'));
  const findings = await read(path.join(FIXTURES, 'codex', 'review-findings.txt'));
  const clean = await read(path.join(FIXTURES, 'codex', 'review-clean.txt'));
  const reviews = rounds === 1 ? [clean] : [findings, clean];
  let current = plan;
  const deps = {
    exec: async () => ({ code: 0, stdout: current, stderr: 'OpenAI Codex (progress output kept in the transcript)\n', timedOut: false }),
    now: () => NOW,
    sleep: async () => {},
    assess: () => ({ kind: 'other' }),
    record: async () => {},
    onQuota: async () => [],
    saveRound: async () => {},
  };
  const planned = await codexPlan(deps, { workRoot: root, stateRoot: root, config, taskHash, fingerprint: 'bench', capsulePath: null, force: true });
  let v041 = byteLength(planned.output);
  let v040 = byteLength(plan);
  for (const review of reviews) v040 += byteLength(review);
  // LeanLoop runs the rounds v0.4.0 would have run, up to the budget. A budget of 0 is one call that says SKIP.
  let v041Rounds = 0;
  const allowed = Math.min(reviews.length, budget.rounds);
  for (let index = 0; index < Math.max(1, allowed); index += 1) {
    current = reviews[index];
    const outcome = await codexReview(deps, { workRoot: root, stateRoot: root, config, taskHash, base: 'main', budget, used: index });
    if (outcome.code === 0 && !outcome.output.startsWith('SKIP')) v041Rounds += 1;
    v041 += byteLength(outcome.output);
  }
  return { v040, v041, v040Calls: 1 + reviews.length, v041Calls: 1 + v041Rounds, v040Rounds: reviews.length, v041Rounds };
}

async function budgetOf(root, config) {
  const diff = await collectDiff(root, 'main');
  return reviewBudget(classifyChange(diff.files, config), config);
}

// ---------------------------------------------------------------- the benchmark

export async function runBenchmark() {
  setClock(() => NOW);
  const { root, config } = await createProject();
  const checks = [];
  const scenarios = [];
  const memoryV040 = byteLength(await read(path.join(V040, 'rule.md'))) + byteLength(await read(path.join(root, 'CLAUDE.md')));
  const memoryV041 = byteLength(ruleText()) + byteLength(await read(path.join(root, 'CLAUDE.md')));
  const claudeMd = byteLength(await read(path.join(root, 'CLAUDE.md')));
  const ruleV040 = byteLength(await read(path.join(V040, 'rule.md')));
  const ok = (label, condition) => checks.push({ label, ok: Boolean(condition) });

  const codeScenario = async ({ id, label, taskFile, edit, runs, v040Rounds }) => {
    await git(root, ['switch', '-q', 'main']);
    const taskText = await read(path.join(FIXTURES, 'tasks', taskFile));
    const lean = await launch(root, config, taskText);
    const old = await v040Launch(root, config, taskText);
    const taskHash = /sha256:([0-9a-f]{12})/.exec(lean.capsule)[1];
    await git(root, ['switch', '-q', '-c', `bench-${id}`]);
    await edit();
    const budget = await budgetOf(root, config);
    const checkResults = await checkRuns(root, config, runs);
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-q', '-m', `${id} change`]);
    const codex = await codexText(root, config, taskHash, { rounds: v040Rounds, budget });
    const contextV040Instructed = byteLength(old.prompt) + byteLength(old.configText) + byteLength(old.taskText)
      + Object.values(old.files).reduce((sum, text) => sum + byteLength(text), 0) + ruleV040;
    const contextV040 = contextV040Instructed - ruleV040 - claudeMd; // rereads of auto-loaded project memory not counted
    const contextV041 = byteLength(lean.prompt) + byteLength(lean.capsule);
    const checksV040 = checkResults.reduce((sum, run) => sum + run.v040, 0);
    const checksV041 = checkResults.reduce((sum, run) => sum + run.v041, 0);
    scenarios.push({
      id,
      label,
      v040: { context: contextV040, contextAsInstructed: contextV040Instructed, memory: memoryV040, checks: checksV040, codex: codex.v040, resume: 0 },
      v041: { context: contextV041, memory: memoryV041, checks: checksV041, codex: codex.v041, resume: 0 },
      rereads: { v040: `${CONTEXT_FILES.length} context files`, v041: 'capsule' },
      codexCalls: { v040: codex.v040Calls, v041: codex.v041Calls },
      reviewRounds: { v040: codex.v040Rounds, v041: codex.v041Rounds },
      budget: budget.kind,
      diff: { files: budget.files, lines: budget.lines },
    });
    return { lean, taskText, budget, checkResults, taskHash };
  };

  // A: documentation-only change.
  const a = await codeScenario({
    id: 'A',
    label: 'docs-only change',
    taskFile: 'A-docs-only.md',
    edit: async () => write(root, 'docs/operations.md', (await read(path.join(root, 'docs/operations.md')))
      .replace('find reservations that are stuck and\nfree them. Use the admin console, search the order, and choose "free stock".', 'find held reservations past their `expires_at` and\nrelease them. Use the admin console, search the order, and choose "release reservations".')
      .replace('https://grafana.example.invalid/d/old-stock', 'https://grafana.example.invalid/dashboards/f/inventory')),
    runs: [{ tests: 600 }],
    v040Rounds: 1,
  });
  ok('A: the capsule carries the task verbatim', a.lean.capsule.includes(a.taskText.trim()));
  ok('A: AGENTS.md is included verbatim (mandatory instruction file)', a.lean.capsule.includes((await read(path.join(root, 'AGENTS.md'))).trim()));
  ok('A: the DECISIONS.md "Security" section is included verbatim (safety heading)', a.lean.capsule.includes('Webhooks must verify the provider signature before any processing.'));
  ok('A: CLAUDE.md and the Autopilot rule are referenced as already-loaded project memory', /Already in your context[\s\S]*`\.claude\/rules\/dev-autopilot\.md`[\s\S]*`CLAUDE\.md`/.test(a.lean.capsule));
  ok('A: human gates are included verbatim', a.lean.capsule.includes('Production deployment or app-store submission.'));
  ok('A: the review budget is 0 for a docs-only diff', a.budget.kind === 'docs-only' && a.budget.rounds === 0);

  // B: small code change.
  const b = await codeScenario({
    id: 'B',
    label: 'small code change',
    taskFile: 'B-small-code.md',
    edit: async () => {
      await write(root, 'src/api/routes/orders.ts', SOURCES['src/api/routes/orders.ts']
        .replace("import type { Deps } from '../deps.js';", "import type { Deps } from '../deps.js';\nimport { formatOrderNumber } from '../../orders/format.js';")
        .replace("number: 'AC' + order.year + order.sequence };", 'number: formatOrderNumber(order.year, order.sequence) };')
        .replace("number: 'AC' + order.year + order.sequence })) };", 'number: formatOrderNumber(order.year, order.sequence) })) };'));
      await write(root, 'test/api/orders.test.ts', SOURCES['test/api/orders.test.ts'].replace('    expect(response.statusCode).toBe(200);\n', "    expect(response.statusCode).toBe(200);\n    expect(response.json().number).toBe('AC-2026-000001');\n"));
    },
    runs: [{ tests: 600 }, { tests: 600, change: () => write(root, 'test/api/orders.test.ts', `${SOURCES['test/api/orders.test.ts']}// list endpoint covered\n`) }],
    v040Rounds: 2,
  });
  ok('B: the ARCHITECTURE.md "Orders routes" section is included (path and helper named in the task)', b.lean.capsule.includes('`src/api/routes/orders.ts` exposes `POST /orders`'));
  ok('B: decision D13 is included (formatOrderNumber)', b.lean.capsule.includes('## D13: consistent customer-facing order numbers'));
  ok('B: the review budget is 1 round for a small low-risk diff', b.budget.kind === 'small' && b.budget.rounds === 1);

  // C: normal code change with verbose passing tests and one failing run.
  const c = await codeScenario({
    id: 'C',
    label: 'normal code change, verbose tests',
    taskFile: 'C-normal-code.md',
    edit: async () => {
      const job = ['import { findExpiredReservations, release } from \'../inventory/reservations.js\';', 'import { logger } from \'../observability/logger.js\';', '',
        'export default {', "  name: 'reservation-expiry',", '  intervalSeconds: 60,', '  async run(deps) {', '    const started = Date.now();', '    let processed = 0;', '    for (;;) {',
        '      const rows = await findExpiredReservations(deps.now(), 500);', '      if (!rows.length) break;', '      const orders = [...new Set(rows.map((row) => row.order_id))];',
        "      for (const orderId of orders) await release(orderId, 'expired');", '      processed += rows.length;', '      if (rows.length < 500) break;', '    }',
        "    logger.info(`job=reservation-expiry processed=${processed} duration_ms=${Date.now() - started}`);", "    deps.metrics.observe('jobs_run_duration_seconds', (Date.now() - started) / 1000);", '    return { processed };', '  },', '};', ''];
      for (let i = 0; i < 20; i += 1) job.push(`// batch note ${i + 1}: rows are processed oldest first so a long backlog drains in order.`);
      await write(root, 'src/jobs/reservation-expiry.ts', `${job.join('\n')}\n`);
      await write(root, 'src/inventory/reservations.ts', `${SOURCES['src/inventory/reservations.ts']}
export async function findExpiredReservations(now: Date, limit: number) {
  return query(null, "select id, order_id, expires_at from inventory_reservations where status = 'held' and expires_at < $1 order by expires_at asc limit $2", [now, limit]);
}
`);
      await write(root, 'src/jobs/index.ts', SOURCES['src/jobs/index.ts'].replace("import reportingExport from './reporting-export.js';", "import reportingExport from './reporting-export.js';\nimport reservationExpiry from './reservation-expiry.js';").replace('[outboxProcessor, reportingExport]', '[outboxProcessor, reportingExport, reservationExpiry]'));
      const tests = ["import { describe, expect, it } from 'vitest';", "import job from '../../../src/jobs/reservation-expiry.js';", '', "describe('reservation-expiry job', () => {"];
      for (let i = 0; i < 12; i += 1) tests.push(`  it('releases expired holds, case ${i + 1}', async () => {`, '    const deps = await testDeps();', '    await job.run(deps);', '    const second = await job.run(deps);', '    expect(second.processed).toBe(0);', '  });');
      tests.push('});', '');
      await write(root, 'test/integration/jobs/reservation-expiry.test.ts', tests.join('\n'));
      await write(root, 'docs/operations.md', `${SOURCES['docs/operations.md']}\nThe reservation-expiry job now releases expired holds every minute; use this runbook only if it is failing.\n`);
    },
    runs: [
      { tests: 1200, failAt: 734 },
      { tests: 1200, change: async () => write(root, 'src/jobs/reservation-expiry.ts', `${await read(path.join(root, 'src/jobs/reservation-expiry.ts'))}// fix: release once per order\n`) },
      { tests: 1200, change: () => write(root, 'src/inventory/reservations.ts', `${SOURCES['src/inventory/reservations.ts']}// review fix: summary key\n`) },
    ],
    v040Rounds: 2,
  });
  ok('C: the ARCHITECTURE.md "Reservations" section is included', c.lean.capsule.includes('Reservations live in the `inventory_reservations` table'));
  ok('C: decision D12 is included', c.lean.capsule.includes('## D12: automatic release of expired reservations'));
  ok('C: the "Jobs runner" section is included', c.lean.capsule.includes('`src/jobs/runner.ts` is a small scheduler'));
  const failed = c.checkResults[0];
  ok('C: the failing run names the failing test', /FAIL\s+npm test\s+exit 1/.test(failed.output) && failed.output.includes('releases on cancel (case 734)'));
  ok('C: the failing run shows the assertion', failed.output.includes("AssertionError: expected 'held' to be 'released'"));
  const failedLog = failed.outcome.results.find((result) => result.status === 'fail');
  const fullLog = await read(failedLog.logFile);
  ok('C: the full log is kept on disk with every test line', (fullLog.match(/test\/[\w/]+\.test\.ts >/g) || []).length >= 1200);
  ok('C: passing runs are one line per check', c.checkResults.slice(1).every((run) => run.output.trim().split('\n').length === 4));
  ok('C: the review budget is 2 rounds for a normal diff', c.budget.kind === 'normal' && c.budget.rounds === 2);

  // D: the session of task C stopped; the task and context are unchanged when it resumes.
  await git(root, ['switch', '-q', 'main']);
  const agents = [{ id: 'c0ffee01', sessionId: 'c0ffee01-0000-4000-8000-000000000001', kind: 'background', cwd: root, name: sessionName(config.claude.sessionNamePrefix, c.lean.capsulePath.match(/capsule-([0-9a-f]{12})/)[1]), state: 'stopped' }];
  const resumeOnce = async () => {
    const fake = fakeRunner({ agents });
    setProcessRunner(fake.runner);
    await quietly(() => main(['run', root]));
    setProcessRunner(null);
    const call = fake.calls.find((item) => item.command === 'claude' && item.args[1] === '--resume');
    return call.args.at(-1);
  };
  // The runtime record names the launched session 7c5dcf5d; point it at the stopped one, as `claude agents` would.
  const recordFile = path.join(root, '.autopilot', 'runtime', 'last-session.json');
  const stateFile = path.join(root, '.autopilot', 'runtime', 'task-state.json');
  const runtime = JSON.parse(await read(recordFile));
  await fs.writeFile(recordFile, JSON.stringify({ ...runtime, id: 'c0ffee01', sessionName: agents[0].name }));
  const taskState = JSON.parse(await read(stateFile));
  await fs.writeFile(stateFile, JSON.stringify({ ...taskState, session: { id: 'c0ffee01', sessionId: agents[0].sessionId, name: agents[0].name } }));
  const unchanged = await resumeOnce();
  scenarios.push({
    id: 'D',
    label: 'resume, unchanged task and context',
    v040: { context: 0, contextAsInstructed: 0, memory: 0, checks: 0, codex: 0, resume: 0 },
    v041: { context: 0, memory: 0, checks: 0, codex: 0, resume: byteLength(unchanged) },
    rereads: { v040: 'none (claude respawn sends no message)', v041: 'none' },
    codexCalls: { v040: 0, v041: 0 },
    reviewRounds: { v040: 0, v041: 0 },
    note: 'v0.4.0 respawns without a message; v0.4.1 sends a short continuation',
  });
  ok('D: the resume message says the context is unchanged and asks for no reread', /unchanged since you read them/.test(unchanged) && !/Context Capsule at/.test(unchanged));

  // E: ARCHITECTURE.md's Reservations section changed before the session resumes.
  agents[0].state = 'stopped';
  const architecture = await read(path.join(root, 'ARCHITECTURE.md'));
  await write(root, 'ARCHITECTURE.md', architecture.replace('- The default hold time is 15 minutes and comes from `config.inventory.reservationTtlMinutes`.', '- The default hold time is 20 minutes and comes from `config.inventory.reservationTtlMinutes`.\n- The reservation-expiry job releases expired holds every minute.'));
  await git(root, ['commit', '-q', '-am', 'docs: reservation hold time']);
  const changed = await resumeOnce();
  const deltaPath = /Read the delta at (.+?\.md)/.exec(changed)?.[1];
  const delta = deltaPath ? await read(deltaPath) : '';
  scenarios.push({
    id: 'E',
    label: 'resume after a context file changed',
    v040: { context: 0, contextAsInstructed: 0, memory: 0, checks: 0, codex: 0, resume: 0 },
    v041: { context: 0, memory: 0, checks: 0, codex: 0, resume: byteLength(changed) + byteLength(delta) },
    rereads: { v040: 'none, and the change is never delivered (stale context)', v041: 'delta only' },
    codexCalls: { v040: 0, v041: 0 },
    reviewRounds: { v040: 0, v041: 0 },
    note: 'v0.4.0 sends nothing, so the session keeps the stale section; v0.4.1 sends the changed section',
  });
  ok('E: the resume message names the changed source and the delta', /ARCHITECTURE\.md/.test(changed) && Boolean(deltaPath));
  ok('E: the delta carries the changed Reservations text verbatim', delta.includes('The default hold time is 20 minutes'));
  ok('E: the delta leaves unchanged sources out', !delta.includes('## D12: automatic release') && !delta.includes('# Project state'));

  setClock(null);
  await fs.rm(root, { recursive: true, force: true });
  return summarizeBenchmark(scenarios, checks);
}

function totalOf(side, { asInstructed = false } = {}) {
  return (asInstructed && side.contextAsInstructed !== undefined ? side.contextAsInstructed : side.context) + side.memory + side.checks + side.codex + side.resume;
}

export function summarizeBenchmark(scenarios, checks) {
  const rows = scenarios.map((scenario) => ({ ...scenario, totalV040: totalOf(scenario.v040), totalV041: totalOf(scenario.v041), totalV040AsInstructed: totalOf(scenario.v040, { asInstructed: true }) }));
  const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
  const component = (side, key) => rows.reduce((total, row) => total + row[side][key], 0);
  const v040 = sum('totalV040');
  const v041 = sum('totalV041');
  const v040AsInstructed = sum('totalV040AsInstructed');
  return {
    rows,
    components: Object.fromEntries(['context', 'memory', 'checks', 'codex', 'resume'].map((key) => [key, { v040: component('v040', key), v041: component('v041', key) }])),
    totals: {
      v040,
      v041,
      reduction: 1 - v041 / v040,
      v040AsInstructed,
      reductionAsInstructed: 1 - v041 / v040AsInstructed,
      codexCalls: { v040: rows.reduce((total, row) => total + row.codexCalls.v040, 0), v041: rows.reduce((total, row) => total + row.codexCalls.v041, 0) },
    },
    checks,
  };
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function formatBenchmark(result) {
  const lines = ['LeanLoop benchmark (bytes an agent is given or told to read; not provider-billed tokens)', ''];
  lines.push('| Scenario | v0.4.0 | v0.4.1 | Change | Codex calls | Review rounds | Context read at start |');
  lines.push('| --- | ---: | ---: | ---: | --- | --- | --- |');
  for (const row of result.rows) {
    const change = row.totalV040 ? `${Math.round((1 - row.totalV041 / row.totalV040) * 100)}% less` : `+${kb(row.totalV041)}`;
    lines.push(`| ${row.id}. ${row.label} | ${kb(row.totalV040)} | ${kb(row.totalV041)} | ${change} | ${row.codexCalls.v040} → ${row.codexCalls.v041} | ${row.reviewRounds.v040} → ${row.reviewRounds.v041} | ${row.rereads.v040} → ${row.rereads.v041} |`);
  }
  const { totals, components } = result;
  lines.push(`| **Total** | **${kb(totals.v040)}** | **${kb(totals.v041)}** | **${Math.round(totals.reduction * 100)}% less** | ${totals.codexCalls.v040} → ${totals.codexCalls.v041} | | |`);
  lines.push('', '| Component | v0.4.0 | v0.4.1 |', '| --- | ---: | ---: |');
  const names = { context: 'Launch context', memory: 'Project memory (rule + CLAUDE.md)', checks: 'Check output', codex: 'Codex plan and review text', resume: 'Resume messages' };
  for (const [key, value] of Object.entries(components)) lines.push(`| ${names[key]} | ${kb(value.v040)} | ${kb(value.v041)} |`);
  lines.push('', `Counting v0.4.0's explicit rereads of the rule and CLAUDE.md, which its launch prompt asks for: ${kb(totals.v040AsInstructed)} → ${kb(totals.v041)} (${Math.round(totals.reductionAsInstructed * 100)}% less).`);
  lines.push('', 'Required information kept:');
  for (const check of result.checks) lines.push(`- [${check.ok ? 'x' : ' '}] ${check.label}`);
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runBenchmark();
  console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 2) : formatBenchmark(result));
  if (result.checks.some((check) => !check.ok)) process.exitCode = 1;
}
