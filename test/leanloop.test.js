import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildConfig, configProblems, main, resumeFromTicket, ruleText, setClock, setHelperLauncher, setSleep, upgrade } from '../src/cli.js';
import { parseCodexCommand } from '../src/codex-run.js';
import { sessionName } from '../src/sessions.js';
import { sha256 } from '../src/lib.js';
import { gitIn, readConfig, tempRoot, useFakeCli, v031Config, v040Config, writeConfig } from './helpers.js';

const FIXTURE = new URL('../bench/fixtures/acme-orders/', import.meta.url);
const TASK = '# Task: release expired reservations\n\nAdd a job in `src/jobs/reservation-expiry.ts` that calls `release(orderId, \'expired\')`.\n';
const T0 = new Date('2026-09-29T12:00:00Z');

async function write(root, rel, text) {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), text, 'utf8');
}

const runtime = (root, ...parts) => path.join(root, '.autopilot', 'runtime', ...parts);
const readJsonFile = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

// A committed project with the benchmark's context documents, the Autopilot rule and a task.
async function leanProject(t, patch = {}) {
  const root = await tempRoot(t);
  await gitIn(root, ['init', '-q', '-b', 'main']);
  for (const file of ['CLAUDE.md', 'AGENTS.md', 'PROJECT_STATE.md', 'DECISIONS.md', 'ARCHITECTURE.md']) await write(root, file, await fs.readFile(new URL(file, FIXTURE), 'utf8'));
  await write(root, '.gitignore', '.autopilot/runtime/\n.claude/worktrees/\n');
  await write(root, '.claude/rules/dev-autopilot.md', ruleText());
  await write(root, 'NEXT_TASK.md', TASK);
  await write(root, 'README.md', '# App\n');
  await writeConfig(root, { ...buildConfig(root, 'demo'), checks: ['npm test'], ...patch });
  await gitIn(root, ['add', '-A']);
  await gitIn(root, ['commit', '-q', '-m', 'init']);
  return root;
}

async function commit(root, message = 'change') {
  await gitIn(root, ['add', '-A']);
  await gitIn(root, ['commit', '-q', '--allow-empty', '-m', message]);
}

function useClock(t, date = T0) {
  let now = new Date(date);
  setClock(() => new Date(now));
  t.after(() => setClock(null));
  return { set: (value) => { now = new Date(value); } };
}

function useHelpers(t, pid = 999999) {
  const launched = [];
  setHelperLauncher((root, ticket) => {
    launched.push({ root, id: ticket.id });
    return pid;
  });
  t.after(() => setHelperLauncher(null));
  return launched;
}

// The generated session of the project's current task, as `claude agents --json` would list it.
async function currentSession(root, state, id = 'c0ffee01') {
  const hash = sha256(await fs.readFile(path.join(root, 'NEXT_TASK.md'), 'utf8'));
  return { id, sessionId: `${id}-1111-4222-8333-444455556666`, kind: 'background', cwd: root, name: sessionName('autopilot-demo', hash), state, status: state === 'done' ? 'idle' : undefined };
}

const resumeCall = (fake) => fake.calls.find((call) => call.command === 'claude' && call.args[0] === '--bg' && call.args[1] === '--resume');
const newLaunch = (fake) => fake.calls.find((call) => call.command === 'claude' && call.args[0] === '--bg' && call.args[1] !== '--resume');
const codexCalls = (fake, sub) => fake.calls.filter((call) => call.command === 'codex' && call.args[0] === sub && call.args[1] !== '--help');

function captureStderr(t) {
  const lines = [];
  t.mock.method(console, 'error', (...parts) => lines.push(parts.join(' ')));
  return () => lines.join('\n');
}

function captureStdout(t) {
  const writes = [];
  t.mock.method(process.stdout, 'write', (chunk) => {
    writes.push(String(chunk));
    return true;
  });
  return () => writes.join('');
}

// Launches the task, then lets the launched session appear in `claude agents` in the given state.
async function launched(t, root, state = 'stopped') {
  useFakeCli(t);
  await main(['run', root]);
  const session = await currentSession(root, state);
  const record = await readJsonFile(runtime(root, 'last-session.json'));
  await fs.writeFile(runtime(root, 'last-session.json'), JSON.stringify({ ...record, id: session.id }));
  const taskState = await readJsonFile(runtime(root, 'task-state.json'));
  await fs.writeFile(runtime(root, 'task-state.json'), JSON.stringify({ ...taskState, session: { id: session.id, sessionId: session.sessionId, name: session.name } }));
  return session;
}

// ---------------------------------------------------------------- launch

test('run launches with a Context Capsule, records the compact task state and the capsule metrics', async (t) => {
  const root = await leanProject(t);
  useClock(t);
  const fake = useFakeCli(t);
  await main(['run', root]);
  const prompt = newLaunch(fake).args.at(-1);
  const capsulePath = /Context Capsule at (.+?\.md):/.exec(prompt)[1];
  const capsule = await fs.readFile(capsulePath, 'utf8');
  assert.ok(capsule.includes(TASK.trim()));
  const state = await readJsonFile(runtime(root, 'task-state.json'));
  assert.equal(state.taskHash, sha256(TASK));
  assert.equal(state.status, 'working');
  assert.equal(state.base, 'main');
  assert.equal(state.context.capsule, capsulePath);
  assert.equal(JSON.stringify(state).includes('Execute the task'), false, 'no prompts are stored');
  const [event] = (await fs.readFile(runtime(root, 'efficiency.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(event.type, 'capsule');
  assert.ok(event.capsuleBytes < event.rawBytes);
  assert.match(fake.text(), /Context Capsule \(built\): .* in place of .* of task, config and context files/);
});

// ---------------------------------------------------------------- Delta Resume

test('Delta Resume: an unchanged task and context get a short continuation, not a reread', async (t) => {
  const root = await leanProject(t);
  const session = await launched(t, root);
  const fake = useFakeCli(t, { agents: [session] });
  await main(['run', root]);
  const call = resumeCall(fake);
  assert.deepEqual(call.args.slice(0, 3), ['--bg', '--resume', session.sessionId]);
  const prompt = call.args[3];
  assert.match(prompt, /unchanged since you read them\. What you read before remains authoritative: do not reread the task, the rule or the context files\./);
  assert.doesNotMatch(prompt, /Context Capsule at/);
  assert.ok(Buffer.byteLength(prompt) < 700);
  assert.equal(newLaunch(fake), undefined);
  const state = await readJsonFile(runtime(root, 'task-state.json'));
  assert.equal(state.lastResume.kind, 'unchanged');
  assert.match(fake.text(), /Resumed c0ffee01: task and context unchanged/);
});

test('Delta Resume: a changed context file is sent as a delta of only the changed material', async (t) => {
  const root = await leanProject(t);
  const session = await launched(t, root);
  const architecture = await fs.readFile(path.join(root, 'ARCHITECTURE.md'), 'utf8');
  await write(root, 'ARCHITECTURE.md', architecture.replace('- Existing jobs: `outbox-processor`', '- Existing jobs: `reservation-expiry`, `outbox-processor`'));
  await commit(root, 'docs');
  const fake = useFakeCli(t, { agents: [session] });
  await main(['run', root]);
  const prompt = resumeCall(fake).args[3];
  assert.match(prompt, /these context sources changed since you read them: ARCHITECTURE\.md\. Read the delta at (.+?\.md) and reread only what it points to/);
  const deltaPath = /Read the delta at (.+?\.md)/.exec(prompt)[1];
  const delta = await fs.readFile(deltaPath, 'utf8');
  assert.ok(delta.includes('- Existing jobs: `reservation-expiry`, `outbox-processor`'));
  assert.equal(delta.includes('## D12'), false);
  const state = await readJsonFile(runtime(root, 'task-state.json'));
  assert.equal(state.lastResume.kind, 'delta');

  // Resuming again with nothing changed since the delta is a plain continuation.
  const again = useFakeCli(t, { agents: [{ ...session, state: 'stopped' }] });
  await main(['run', root]);
  assert.match(resumeCall(again).args[3], /unchanged since you read them/);
});

test('Delta Resume: a changed task file is a new task with its own session, never a resume', async (t) => {
  const root = await leanProject(t);
  const session = await launched(t, root);
  await write(root, 'NEXT_TASK.md', '# Task: something else\n\nChange `src/orders/format.ts`.\n');
  await commit(root, 'next task');
  const fake = useFakeCli(t, { agents: [session] });
  await main(['run', root]);
  assert.equal(resumeCall(fake), undefined, 'the earlier task session is stale');
  const launch = newLaunch(fake);
  assert.ok(launch, 'a new session is started');
  assert.match(launch.args[launch.args.indexOf('--name') + 1], new RegExp(`-${sha256('# Task: something else\n\nChange `src/orders/format.ts`.\n').slice(0, 6)}$`));
  const state = await readJsonFile(runtime(root, 'task-state.json'));
  assert.equal(state.taskHash, sha256('# Task: something else\n\nChange `src/orders/format.ts`.\n'), 'the earlier task state is replaced, not merged');
  assert.equal(state.lastResume, undefined);
});

test('Delta Resume: with its record of the session lost, the session is pointed at the capsule', async (t) => {
  const root = await leanProject(t);
  const session = await launched(t, root);
  await fs.rm(runtime(root, 'task-state.json'));
  const fake = useFakeCli(t, { agents: [session] });
  await main(['run', root]);
  assert.match(resumeCall(fake).args[3], /no record of the context this session read, so read the Context Capsule at /);
});

test('Delta Resume: a session other than the one recorded is never told its context is unchanged', async (t) => {
  const root = await leanProject(t);
  await launched(t, root);
  const other = { ...(await currentSession(root, 'stopped', 'feedbeef')) };
  const fake = useFakeCli(t, { agents: [other] });
  await main(['run', root]);
  assert.match(resumeCall(fake).args[3], /read the Context Capsule at /);
});

test('Delta Resume: with several background sessions only the current task session is resumed', async (t) => {
  const root = await leanProject(t);
  const session = await launched(t, root);
  const stale = { id: 'aaaaaaaa', sessionId: 'aaaaaaaa-1111-4222-8333-444455556666', kind: 'background', cwd: root, name: 'autopilot-demo-111111', state: 'stopped' };
  const mine = { id: 'bbbbbbbb', sessionId: 'bbbbbbbb-1111-4222-8333-444455556666', kind: 'background', cwd: root, name: 'my own work', state: 'done' };
  const fake = useFakeCli(t, { agents: [stale, mine, session] });
  await main(['run', root]);
  const resumes = fake.calls.filter((call) => call.args[1] === '--resume');
  assert.deepEqual(resumes.map((call) => call.args[2]), [session.sessionId]);
  assert.equal(fake.calls.some((call) => ['stop', 'rm'].includes(call.args[0])), false);
});

test('Delta Resume: a finished-but-idle session is stopped first so it continues under its own id', async (t) => {
  const root = await leanProject(t);
  const session = await launched(t, root, 'done');
  const taskState = await readJsonFile(runtime(root, 'task-state.json'));
  await fs.writeFile(runtime(root, 'task-state.json'), JSON.stringify({ ...taskState, waiting: { reason: 'quota', provider: 'codex', step: 'dev-autopilot codex review', resetAt: null, resumeAt: null } }));
  const fake = useFakeCli(t, { agents: [session] });
  await main(['run', root]);
  const stopIndex = fake.calls.findIndex((call) => call.line === `claude stop ${session.id}`);
  const resumeIndex = fake.calls.findIndex((call) => call.args[1] === '--resume');
  assert.ok(stopIndex >= 0 && stopIndex < resumeIndex);
  assert.match(fake.calls[resumeIndex].args[3], /Codex usage limit that stopped this task may have reset\. Rerun the step that failed \(dev-autopilot codex review\)/);
  assert.equal((await readJsonFile(runtime(root, 'task-state.json'))).waiting, undefined);
});

test('Delta Resume records a copy that Claude Code starts under a new id', async (t) => {
  const root = await leanProject(t);
  const session = await launched(t, root);
  const fake = useFakeCli(t, { agents: [session], results: { 'claude --bg --resume': { stdout: 'started a copy\nbackgrounded · 1234abcd · copy\n' } } });
  await main(['run', root]);
  assert.match(fake.text(), /continued the conversation in a new background session 1234abcd/);
  assert.equal((await readJsonFile(runtime(root, 'last-session.json'))).id, '1234abcd');
  assert.equal((await readJsonFile(runtime(root, 'task-state.json'))).session.id, '1234abcd');
});

test('Delta Resume falls back to claude respawn when --bg --resume is not supported', async (t) => {
  const root = await leanProject(t);
  const session = await launched(t, root);
  const fake = useFakeCli(t, { agents: [session], results: { 'claude --bg --resume': { code: 1, stderr: "error: unknown option '--resume'" } } });
  await main(['run', root]);
  assert.ok(fake.calls.some((call) => call.line === `claude respawn ${session.id}`));
});

test('dev-autopilot resume <id> of the current task sends the LeanLoop continuation', async (t) => {
  const root = await leanProject(t);
  const session = await launched(t, root);
  const fake = useFakeCli(t, { agents: [session] });
  await main(['resume', session.id, root]);
  assert.match(resumeCall(fake).args[3], /unchanged since you read them/);
  assert.equal(fake.calls.some((call) => call.args[0] === 'respawn'), false);
});

// ---------------------------------------------------------------- the Codex wrapper

test('codex plan is never invoked when the planner is disabled', async (t) => {
  const root = await leanProject(t, { planner: { enabled: false } });
  const fake = useFakeCli(t);
  const out = captureStdout(t);
  await main(['codex', 'plan', root]);
  assert.match(out(), /Codex planning is off \(planner\.enabled is not true\), so Codex was not asked for a plan/);
  assert.deepEqual(codexCalls(fake, 'exec'), []);
});

test('codex plan runs read-only once per task and context, and --force asks again', async (t) => {
  const root = await leanProject(t);
  useClock(t);
  await launched(t, root);
  const fake = useFakeCli(t, { results: { 'codex exec --sandbox': { stdout: 'PLAN: add the job, then the tests.\n', stderr: 'OpenAI Codex progress noise\n'.repeat(50) } } });
  const out = captureStdout(t);
  await main(['codex', 'plan', root]);
  const [call] = codexCalls(fake, 'exec');
  assert.deepEqual(call.args.slice(0, 3), ['exec', '--sandbox', 'read-only']);
  assert.equal(call.args.includes('--model') || call.args.includes('-m'), false);
  assert.equal(call.args.at(-1), '-', 'the prompt goes through stdin');
  assert.match(call.options.input, /Do not write code and do not edit files\./);
  assert.match(call.options.input, /Context Capsule at .*capsule-[0-9a-f]{12}\.md/);
  assert.match(out(), /PLAN: add the job/);
  assert.doesNotMatch(out(), /progress noise/, 'Codex progress stays in the transcript');

  await main(['codex', 'plan', root]);
  assert.equal(codexCalls(fake, 'exec').length, 1, 'the saved plan is reused');
  assert.match(out(), /Saved Codex plan for this unchanged task and context/);
  await main(['codex', 'plan', '--force', root]);
  assert.equal(codexCalls(fake, 'exec').length, 2);
});

test('configured Codex commands must stay native, read-only and model-free', () => {
  assert.deepEqual(parseCodexCommand('codex exec', 'plan'), ['exec', '--sandbox', 'read-only']);
  assert.throws(() => parseCodexCommand('codex exec --sandbox workspace-write', 'plan'), /read-only sandbox/);
  assert.throws(() => parseCodexCommand('codex exec -m gpt-x', 'plan'), /-m: model selection/);
  assert.throws(() => parseCodexCommand('codex review -c model="x"', 'review'), /may not override the model/);
  assert.throws(() => parseCodexCommand('codex review --dangerously-bypass-approvals-and-sandbox', 'review'), /bypassing approvals/);
  assert.throws(() => parseCodexCommand('claude -p review', 'review'), /must start with "codex"/);
  assert.deepEqual(parseCodexCommand('codex review', 'review'), ['review']);
  const config = buildConfig('/w', 'a');
  config.reviewer.command = 'codex review --model o3';
  assert.match(configProblems(config).join('\n'), /reviewer\.command may not include --model/);
});

test('codex review skips a docs-only change without calling Codex', async (t) => {
  const root = await leanProject(t);
  await gitIn(root, ['switch', '-q', '-c', 'task']);
  await write(root, 'README.md', '# App\n\nMore docs.\n');
  const fake = useFakeCli(t);
  const out = captureStdout(t);
  await main(['codex', 'review', root]);
  assert.match(out(), /^SKIP {2}Codex review not needed: docs-only change/);
  assert.deepEqual(codexCalls(fake, 'review'), []);
  assert.notEqual(process.exitCode, 3);
});

test('codex review gives a small change one round and refuses a second', async (t) => {
  const root = await leanProject(t);
  await gitIn(root, ['switch', '-q', '-c', 'task']);
  await write(root, 'src/format.js', 'export const x = 1;\n');
  const fake = useFakeCli(t, { results: { 'codex review --base': { stdout: '- [P2] Name the constant.\n', stderr: 'progress\n'.repeat(100) } } });
  const out = captureStdout(t);
  await main(['codex', 'review', root]);
  const [call] = codexCalls(fake, 'review');
  assert.deepEqual(call.args, ['review', '--base', 'main']);
  assert.equal(call.options.input, undefined, 'stdin stays closed');
  assert.match(out(), /\[P2\] Name the constant\./);
  assert.match(out(), /Codex review round 1 of 1 for this small change; max 2\. This was the last round in the budget\./);
  await main(['codex', 'review', root]);
  assert.equal(codexCalls(fake, 'review').length, 1);
  assert.match(out(), /STOP {2}Review budget used: 1 of 1 round\(s\) for this small change/);
  assert.equal(process.exitCode, 3);
  const state = await readJsonFile(runtime(root, 'task-state.json'));
  assert.deepEqual([state.review.kind, state.review.budget, state.review.rounds, state.review.maxRounds], ['small', 1, 1, 2]);
});

test('codex review gives a high-risk change the configured maximum', async (t) => {
  const root = await leanProject(t);
  await gitIn(root, ['switch', '-q', '-c', 'task']);
  await write(root, 'src/auth/session.js', 'export const x = 1;\n');
  const fake = useFakeCli(t, { results: { 'codex review --base': { stdout: 'No issues.\n' } } });
  captureStdout(t);
  await main(['codex', 'review', root]);
  await main(['codex', 'review', root]);
  await main(['codex', 'review', root]);
  assert.equal(codexCalls(fake, 'review').length, 2);
  assert.equal((await readJsonFile(runtime(root, 'task-state.json'))).review.kind, 'high-risk');
});

test('a failed review is not a round, and ordinary throttling is retried once after a pause', async (t) => {
  const root = await leanProject(t);
  await gitIn(root, ['switch', '-q', '-c', 'task']);
  await write(root, 'src/format.js', 'export const x = 1;\n');
  const pauses = [];
  setSleep(async (ms) => pauses.push(ms));
  t.after(() => setSleep(null));
  let attempts = 0;
  const fake = useFakeCli(t);
  const base = fake.runner;
  const { setProcessRunner } = await import('../src/cli.js');
  setProcessRunner(async (command, args, options) => {
    if (command === 'codex' && args[0] === 'review' && args[1] === '--base') {
      fake.calls.push({ command, args, options, line: [command, ...args].join(' ') });
      attempts += 1;
      return attempts === 1 ? { code: 1, stdout: '', stderr: 'stream error: 429 Too Many Requests (rate limit)' } : attempts === 2 ? { code: 1, stdout: '', stderr: 'network error: getaddrinfo ENOTFOUND' } : { code: 0, stdout: 'Clean.\n', stderr: '' };
    }
    return base(command, args, options);
  });
  const out = captureStdout(t);
  await main(['codex', 'review', root]);
  assert.deepEqual(pauses, [20000]);
  assert.match(out(), /CODEX REVIEW FAILED \(network, exit 1\)/);
  assert.match(out(), /This failed run does not count as a review round\./);
  assert.equal((await readJsonFile(runtime(root, 'task-state.json'))).review.rounds, 0);
  await main(['codex', 'review', root]);
  assert.match(out(), /Codex review round 1 of 1/);
});

// ---------------------------------------------------------------- quota

const QUOTA_WITH_RESET = "ERROR: You've hit your usage limit. Upgrade to Pro or try again in 2 hours 30 minutes.";

async function quotaReview(t, { autoResume, stderr = QUOTA_WITH_RESET }) {
  const root = await leanProject(t, { quota: { autoResume, graceMinutes: 2 } });
  useClock(t);
  const session = await launched(t, root, 'working');
  await gitIn(root, ['switch', '-q', '-c', 'task']);
  await write(root, 'src/format.js', 'export const x = 1;\n');
  const launchedHelpers = useHelpers(t);
  const fake = useFakeCli(t, { results: { 'codex review --base': { code: 1, stderr } } });
  const out = captureStdout(t);
  await main(['codex', 'review', root]);
  await commit(root, 'task change');
  await gitIn(root, ['switch', '-q', 'main']);
  return { root, session, fake, out: out(), launchedHelpers };
}

test('a Codex quota stop with a stated reset schedules a resume ticket at reset + 2 minutes when autoResume is on', async (t) => {
  const { root, session, out, launchedHelpers } = await quotaReview(t, { autoResume: true });
  assert.equal(process.exitCode, 75);
  assert.match(out, /QUOTA EXHAUSTED \(Codex\): ERROR: You've hit your usage limit/);
  assert.match(out, /Stated reset: 2026-09-29 14:30 UTC/);
  assert.match(out, /waiting-quota — resume scheduled 2026-09-29 14:32 UTC/);
  assert.match(out, /Stop here and report the quota blocker; do not retry\./);
  const ticket = await readJsonFile(runtime(root, 'resume-ticket.json'));
  assert.deepEqual([ticket.status, ticket.resetAt, ticket.resumeAt, ticket.taskHash, ticket.session.id], ['pending', '2026-09-29T14:30:00.000Z', '2026-09-29T14:32:00.000Z', sha256(TASK), session.id]);
  assert.deepEqual(launchedHelpers.map((item) => item.id), [ticket.id]);
  assert.equal(ticket.helper.pid, 999999);
  const state = await readJsonFile(runtime(root, 'task-state.json'));
  assert.equal(state.waiting.ticketId, ticket.id);
  assert.equal(state.review.rounds, 0, 'a quota stop is not a review round');
});

test('with autoResume off, a quota stop is recorded but nothing is scheduled', async (t) => {
  const { root, out, launchedHelpers } = await quotaReview(t, { autoResume: false });
  assert.match(out, /Automatic resume is off \(quota\.autoResume\)\. Run dev-autopilot run after 2026-09-29 14:32 UTC/);
  assert.equal(await fs.stat(runtime(root, 'resume-ticket.json')).catch(() => null), null);
  assert.deepEqual(launchedHelpers, []);
  assert.equal((await readJsonFile(runtime(root, 'task-state.json'))).waiting.resumeAt, '2026-09-29T14:32:00.000Z');
});

test('without a stated reset time, quota exhaustion stops safely and schedules nothing', async (t) => {
  const stderr = await fs.readFile(new URL('./fixtures/quota/codex-0.157.1-out-of-credits.txt', import.meta.url), 'utf8');
  const { root, out, launchedHelpers } = await quotaReview(t, { autoResume: true, stderr });
  assert.match(out, /quota exhausted; reset time unavailable for automatic scheduling \(the output states no reset time\)\./);
  assert.equal(await fs.stat(runtime(root, 'resume-ticket.json')).catch(() => null), null);
  assert.deepEqual(launchedHelpers, []);
});

test('status shows waiting-quota with the scheduled time, and restarts a dead helper', async (t) => {
  const { root } = await quotaReview(t, { autoResume: true });
  const helpers = useHelpers(t);
  const fake = useFakeCli(t);
  const notices = captureStderr(t);
  await main(['status', root]);
  const report = JSON.parse(fake.output.find((line) => line.startsWith('{')));
  assert.equal(fake.output.filter((line) => !line.startsWith('{')).length, 0, 'stdout is only the JSON report');
  assert.equal(report.task.state, `waiting-quota — resume scheduled 2026-09-29 14:32 UTC (${new Intl.DateTimeFormat('en-CA', { dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }).format(new Date('2026-09-29T14:32:00Z'))} local)`);
  assert.equal(helpers.length, 1, 'the helper pid was not alive, so it was re-armed');
  assert.match(notices(), /Restarted the quota auto-resume helper/);
});

test('run before the resume time only reports the wait', async (t) => {
  const { root, session } = await quotaReview(t, { autoResume: true });
  useHelpers(t, process.pid);
  const fake = useFakeCli(t, { agents: [{ ...session, state: 'done', status: 'idle' }] });
  await main(['run', root]);
  assert.match(fake.text(), /waiting-quota — resume scheduled 2026-09-29 14:32 UTC/);
  assert.equal(resumeCall(fake), undefined);
});

test('a due ticket resumes the same task session through the checked path, once', async (t) => {
  const { root, session } = await quotaReview(t, { autoResume: true });
  setClock(() => new Date('2026-09-29T14:33:00Z'));
  const fake = useFakeCli(t, { agents: [{ ...session, state: 'done', status: 'idle' }] });
  const result = await resumeFromTicket(root, { source: 'helper' });
  assert.equal(result.status, 'resumed', result.message);
  assert.ok(fake.calls.some((call) => call.line === `claude stop ${session.id}`));
  const prompt = resumeCall(fake).args[3];
  assert.match(prompt, /the Codex usage limit that stopped this task stated a reset time of 2026-09-29T14:30:00\.000Z, which has passed\. Rerun the step that failed \(dev-autopilot codex review\)/);
  assert.equal((await readJsonFile(runtime(root, 'resume-ticket.json'))).status, 'done');
  assert.equal((await readJsonFile(runtime(root, 'task-state.json'))).waiting, undefined);
  assert.equal((await resumeFromTicket(root, { source: 'helper' })).status, 'none', 'a second helper does nothing');
});

test('a quota resume through the respawn fallback still ends the wait, but keeps the undelivered context pending', async (t) => {
  for (const [label, agentsFor, results] of [
    ['--bg --resume is not supported', (session) => [{ ...session, state: 'done', status: 'idle' }], { 'claude --bg --resume': { code: 1, stderr: "error: unknown option '--resume'" } }],
    ['no sessionId is reported', (session) => [{ ...session, sessionId: undefined, state: 'stopped' }], {}],
  ]) {
    await t.test(label, async (st) => {
      const { root, session } = await quotaReview(st, { autoResume: true });
      const before = await readJsonFile(runtime(root, 'task-state.json'));
      await fs.appendFile(path.join(root, 'ARCHITECTURE.md'), '\n## Later section\n\nAdded after the session read the context.\n');
      await commit(root, 'docs');
      setClock(() => new Date('2026-09-29T14:33:00Z'));
      const fake = useFakeCli(st, { agents: agentsFor(session), results });
      const result = await resumeFromTicket(root);
      assert.equal(result.status, 'resumed', result.message);
      assert.ok(fake.calls.some((call) => call.line === `claude respawn ${session.id}`));
      assert.equal((await readJsonFile(runtime(root, 'resume-ticket.json'))).status, 'done');
      const after = await readJsonFile(runtime(root, 'task-state.json'));
      assert.equal(after.waiting, undefined, 'the quota wait is over');
      assert.equal(after.status, 'working');
      assert.equal(after.lastResume.kind, 'respawn');
      assert.equal(after.context.fingerprint, before.context.fingerprint, 'the delta was not delivered, so the next resume still sends it');
      assert.match(fake.text(), /The context changed since the session read it: attach and ask it to read .*delta-/);
    });
  }
});

test('a due ticket is cancelled when the task was replaced, completed, stopped or superseded', async (t) => {
  const scenarios = [
    ['the task file changed', async (root) => { await write(root, 'NEXT_TASK.md', '# Another task\n'); }, /task file changed/],
    ['the task is ready', async (root) => {
      const state = await readJsonFile(runtime(root, 'task-state.json'));
      await fs.writeFile(runtime(root, 'task-state.json'), JSON.stringify({ ...state, status: 'ready' }));
    }, /the task is ready/],
    ['auto-resume was switched off', async (root) => {
      const config = await readConfig(root);
      await writeConfig(root, { ...config, quota: { autoResume: false } });
    }, /quota\.autoResume is off/],
  ];
  for (const [label, change, reason] of scenarios) {
    await t.test(label, async (st) => {
      const { root, session } = await quotaReview(st, { autoResume: true });
      await change(root);
      setClock(() => new Date('2026-09-29T14:33:00Z'));
      const fake = useFakeCli(st, { agents: [{ ...session, state: 'done', status: 'idle' }] });
      const result = await resumeFromTicket(root);
      assert.equal(result.status, 'cancelled');
      assert.match(result.message, reason);
      assert.equal(resumeCall(fake), undefined);
      assert.equal((await readJsonFile(runtime(root, 'resume-ticket.json'))).status, 'cancelled');
    });
  }
  await t.test('the session is already working again', async (st) => {
    const { root, session } = await quotaReview(st, { autoResume: true });
    setClock(() => new Date('2026-09-29T14:33:00Z'));
    useFakeCli(st, { agents: [{ ...session, state: 'working' }] });
    assert.match((await resumeFromTicket(root)).message, /already working/);
  });
  await t.test('another session is active in the project', async (st) => {
    const { root, session } = await quotaReview(st, { autoResume: true });
    setClock(() => new Date('2026-09-29T14:33:00Z'));
    const other = { id: 'dddddddd', sessionId: 'dddddddd-1', kind: 'background', cwd: root, name: 'autopilot-demo-222222', state: 'working' };
    useFakeCli(st, { agents: [{ ...session, state: 'done' }, other] });
    assert.match((await resumeFromTicket(root)).message, /another session \(dddddddd\) is active/);
  });
  await t.test('the session is gone', async (st) => {
    const { root } = await quotaReview(st, { autoResume: true });
    setClock(() => new Date('2026-09-29T14:33:00Z'));
    useFakeCli(st, { agents: [] });
    assert.match((await resumeFromTicket(root)).message, /no longer exists/);
  });
  await t.test('the ticket is long overdue', async (st) => {
    const { root, session } = await quotaReview(st, { autoResume: true });
    setClock(() => new Date('2026-10-05T00:00:00Z'));
    useFakeCli(st, { agents: [{ ...session, state: 'done' }] });
    assert.equal((await resumeFromTicket(root)).status, 'expired');
  });
});

test('dev-autopilot stop cancels a pending quota resume for that task', async (t) => {
  const { root, session } = await quotaReview(t, { autoResume: true });
  const fake = useFakeCli(t, { agents: [{ ...session, state: 'done', status: 'idle' }] });
  await main(['stop', session.id, root]);
  assert.match(fake.text(), /Cancelled the scheduled quota auto-resume for this task \(stopped with dev-autopilot stop\)/);
  assert.equal((await readJsonFile(runtime(root, 'resume-ticket.json'))).status, 'cancelled');
  const state = await readJsonFile(runtime(root, 'task-state.json'));
  assert.equal(state.status, 'stopped');
  assert.equal(state.waiting, undefined);
  setClock(() => new Date('2026-09-29T14:33:00Z'));
  assert.equal((await resumeFromTicket(root)).status, 'none');
});

test('stop cancels the ticket even when its session is already gone', async (t) => {
  const { root, session } = await quotaReview(t, { autoResume: true });
  const fake = useFakeCli(t, { agents: [] });
  await main(['stop', session.id, root]);
  assert.equal((await readJsonFile(runtime(root, 'resume-ticket.json'))).status, 'cancelled');
  assert.equal(fake.calls.some((call) => call.args[0] === 'stop'), false);
});

test('a changed task cancels a stale ticket on the next command', async (t) => {
  const { root } = await quotaReview(t, { autoResume: true });
  await write(root, 'NEXT_TASK.md', '# A new task\n');
  useFakeCli(t);
  const notices = captureStderr(t);
  await main(['status', root]);
  assert.match(notices(), /Cancelled a scheduled quota auto-resume: the task file changed/);
  assert.equal((await readJsonFile(runtime(root, 'resume-ticket.json'))).status, 'cancelled');
});

test('after a reboot the next command re-arms a due ticket, which then resumes', async (t) => {
  const { root, session } = await quotaReview(t, { autoResume: true });
  setClock(() => new Date('2026-09-29T18:00:00Z'));
  const helpers = useHelpers(t);
  useFakeCli(t, { agents: [{ ...session, state: 'done', status: 'idle' }] });
  const notices = captureStderr(t);
  await main(['status', root]);
  assert.equal(helpers.length, 1);
  assert.match(notices(), /is due; its helper was not running, so it was restarted and resumes now/);
  const run = useFakeCli(t, { agents: [{ ...session, state: 'done', status: 'idle' }] });
  await main(['run', root]);
  assert.match(run.text(), /Quota auto-resume: continued session c0ffee01/);
});

test('a failed Claude session whose log states the usage-limit reset waits for it instead of resuming', async (t) => {
  const root = await leanProject(t, { quota: { autoResume: true } });
  useClock(t);
  const session = await launched(t, root, 'failed');
  const helpers = useHelpers(t);
  const fake = useFakeCli(t, { agents: [session], results: { [`claude logs ${session.id}`]: { stdout: 'Working on the job…\n5-hour limit reached ∙ resets 3pm (Europe/London)\n' } } });
  await main(['run', root]);
  assert.equal(resumeCall(fake), undefined);
  assert.match(fake.text(), /QUOTA EXHAUSTED \(Claude\): 5-hour limit reached/);
  assert.match(fake.text(), /waiting-quota — resume scheduled 2026-09-29 14:02 UTC/);
  assert.equal(helpers.length, 1);
  assert.equal((await readJsonFile(runtime(root, 'resume-ticket.json'))).provider, 'claude');
});

test('a failed Claude session with a quota message but no usable reset time is resumed when you run it', async (t) => {
  const root = await leanProject(t, { quota: { autoResume: true } });
  const session = await launched(t, root, 'failed');
  const fake = useFakeCli(t, { agents: [session], results: { [`claude logs ${session.id}`]: { stdout: 'Claude usage limit reached. Try again later.\n' } } });
  await main(['run', root]);
  assert.ok(resumeCall(fake));
  assert.match(fake.text(), /reports an exhausted Claude usage limit, and the output states no reset time/);
});

test('the detached helper exits at once for a ticket that is no longer pending', async (t) => {
  const root = await tempRoot(t);
  await write(root, '.autopilot/runtime/resume-ticket.json', JSON.stringify({ version: 1, id: 'abc', status: 'cancelled', taskHash: 'x', resumeAt: T0.toISOString() }));
  const { launchDetachedHelper } = await import('../src/tickets.js');
  const pid = launchDetachedHelper(root, { id: 'abc' });
  assert.ok(Number.isInteger(pid));
  let log = '';
  for (let attempt = 0; attempt < 100 && !log.includes('stopping'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    log = await fs.readFile(runtime(root, 'resume-helper.log'), 'utf8').catch(() => '');
  }
  assert.match(log, /\[abc\] stopping: ticket is cancelled/);
  const { processAlive } = await import('../src/tickets.js');
  for (let attempt = 0; attempt < 100 && processAlive(pid); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(processAlive(pid), false, 'the helper has exited');
});

// ---------------------------------------------------------------- task state and efficiency

test('dev-autopilot state records PR, CI and blockers compactly and never overwrites another task', async (t) => {
  const root = await leanProject(t);
  await launched(t, root);
  const fake = useFakeCli(t);
  await main(['state', '--pr', '42', '--ci', 'passing', root]);
  await main(['state', '--blocker', 'Needs   a production secret', root]);
  const state = await readJsonFile(runtime(root, 'task-state.json'));
  assert.deepEqual([state.pr, state.ci, state.blocker], [42, 'passing', 'Needs a production secret']);
  await main(['state', root]);
  const view = JSON.parse(fake.output.find((line) => line.startsWith('{')));
  assert.equal(view.state, 'blocked — Needs a production secret');
  assert.equal(view.pr, 42);
  await main(['state', '--clear-blocker', '--status', 'ready', root]);
  assert.equal((await readJsonFile(runtime(root, 'task-state.json'))).blocker, undefined);
  await assert.rejects(main(['state', '--ci', 'green', root]), /--ci must be one of: pending, passing, failing, none/);
  await assert.rejects(main(['state', '--pr', 'abc', root]), /--pr takes a pull-request number/);
  await write(root, 'NEXT_TASK.md', '# Other\n');
  await assert.rejects(main(['state', '--pr', '7', root]), /belongs to a different task file/);
  assert.equal((await readJsonFile(runtime(root, 'task-state.json'))).pr, 42);
});

test('dev-autopilot efficiency reports local bytes and labels the token figure as an estimate', async (t) => {
  const root = await leanProject(t);
  const session = await launched(t, root);
  useFakeCli(t, { agents: [session] });
  await main(['run', root]); // an unchanged resume
  const fake = useFakeCli(t);
  await main(['efficiency', root]);
  const text = fake.text();
  assert.match(text, /^LeanLoop efficiency: all recorded tasks \(local orchestration metrics; nothing leaves this machine\)/);
  assert.match(text, /Context: {2}1 capsule\(s\): configured context [\d.]+ KB → capsules [\d.]+ KB/);
  assert.match(text, /Resume: {3}1 \(unchanged 1, delta 0, full 0\)/);
  assert.match(text, /≈ [\d,]+ tokens \(estimate\)/);
  assert.match(text, /not provider-billed tokens/);
  await main(['efficiency', '--json', '--task', root]);
  const summary = JSON.parse(fake.output.filter((line) => line.startsWith('{')).at(-1));
  assert.equal(summary.scope, 'current task');
  assert.equal(summary.resume.unchanged, 1);
  assert.ok(summary.context.avoidedBytes > 0);
});

// ---------------------------------------------------------------- compatibility

test('v0.4.0 and v0.3.1 configs are valid unchanged, upgrade leaves them byte-for-byte, and run uses LeanLoop', async (t) => {
  for (const [label, load] of [['v0.4.0', v040Config], ['v0.3.1', v031Config]]) {
    await t.test(label, async (st) => {
      const config = await load();
      assert.deepEqual(configProblems(config), []);
      const root = await leanProject(st);
      await writeConfig(root, config);
      await commit(root, 'legacy config');
      const before = await fs.readFile(path.join(root, '.autopilot', 'config.json'), 'utf8');
      const fake = useFakeCli(st);
      await upgrade(root);
      await upgrade(root);
      assert.equal(await fs.readFile(path.join(root, '.autopilot', 'config.json'), 'utf8'), before);
      assert.match(fake.text(), /LeanLoop is on with its defaults .* reviewer\.maxRounds = 3/);
      assert.match(fake.text(), /Quota auto-resume stays off/);
      await commit(root, 'upgrade');
      const run = useFakeCli(st);
      await main(['run', root]);
      assert.match(newLaunch(run).args.at(-1), /Context Capsule at .* at most 3 rounds/);
    });
  }
});

test('doctor reports LeanLoop and warns when dev-autopilot is not on PATH or the rule is outdated', async (t) => {
  const root = await leanProject(t);
  const fake = useFakeCli(t, { results: { 'dev-autopilot --version': { code: 1, stderr: 'not found' } } });
  await write(root, '.claude/rules/dev-autopilot.md', '# Dev Agent Autopilot v0.4.0\n');
  await main(['doctor', root]);
  const report = JSON.parse(fake.output.find((line) => line.trimStart().startsWith('{')));
  assert.equal(report.leanloop.enabled, true);
  assert.equal(report.leanloop.devAutopilotOnPath, false);
  assert.deepEqual(report.leanloop.quota, { autoResume: false, graceMinutes: 2 });
  assert.match(report.warnings.join('\n'), /dev-autopilot is not on PATH/);
  assert.match(report.warnings.join('\n'), /from another Autopilot version\. Run dev-autopilot upgrade/);
  assert.notEqual(process.exitCode, 2, 'LeanLoop warnings never fail doctor');
});

test('invalid LeanLoop settings are reported by run before anything starts', async (t) => {
  const root = await leanProject(t, { leanloop: { enabled: 'yes', checks: { timeoutMinutes: -1 }, context: { maxExcerptBytes: 10 } }, quota: { graceMinutes: 500 } });
  const fake = useFakeCli(t);
  await assert.rejects(main(['run', root]), /leanloop\.enabled must be true or false[\s\S]*leanloop\.context\.maxExcerptBytes[\s\S]*leanloop\.checks\.timeoutMinutes[\s\S]*quota\.graceMinutes/);
  assert.equal(newLaunch(fake), undefined);
});
