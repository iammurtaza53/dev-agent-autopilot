// The Codex invocations Autopilot owns: read-only planning (`codex exec --sandbox read-only`) and the independent
// review (`codex review --base <branch>`). The native CLI does the work; this wrapper only keeps transcripts on
// disk, shows the agent the result, avoids duplicate planning, applies the review budget and classifies
// failures so an exhausted quota stops cleanly. It never edits files and never passes a model.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { byteLength, formatBytes, redactSecrets, stripAnsi, writeFileAtomic } from './lib.js';
import { runtimePath, taskKey } from './runtime.js';

export const QUOTA_EXIT_CODE = 75;
export const BUDGET_EXIT_CODE = 3;
const CODEX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_PRINT_BYTES = 48 * 1024;

const FORBIDDEN = [
  [/^(-m|--model)(=|$)/, 'model selection (Autopilot never pins a model)'],
  [/^--oss$|^--local-provider/, 'provider selection'],
  [/^--dangerously/, 'bypassing approvals or the sandbox'],
  [/^--full-auto$|^--approve-for-me$/, 'automatic write approval'],
  [/^--add-dir/, 'extra writable directories'],
];

// Splits a configured command such as "codex exec --sandbox read-only" and checks that it stays a native,
// read-only Codex invocation of the right kind.
export function parseCodexCommand(command, kind) {
  const tokens = String(command || '').trim().split(/\s+/).filter(Boolean);
  const label = kind === 'plan' ? 'planner.command' : 'reviewer.command';
  if (tokens[0] !== 'codex') throw new Error(`${label} must start with "codex" (found "${command}").`);
  const rest = tokens.slice(1);
  if (kind === 'plan' && !['exec', 'e'].includes(rest[0])) throw new Error(`${label} must be a "codex exec" command (found "${command}").`);
  if (kind === 'review' && !(rest[0] === 'review' || (rest[0] === 'exec' && rest[1] === 'review'))) throw new Error(`${label} must be "codex review" (found "${command}").`);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    for (const [pattern, why] of FORBIDDEN) if (pattern.test(token)) throw new Error(`${label} may not include ${token}: ${why}.`);
    if ((token === '-c' || token === '--config') && /^model(_|\b|=)/.test(rest[index + 1] || '')) throw new Error(`${label} may not override the model.`);
    if (/^(-c|--config)=model/.test(token)) throw new Error(`${label} may not override the model.`);
  }
  if (kind === 'plan') {
    const at = rest.findIndex((token) => token === '--sandbox' || token === '-s');
    const inline = rest.find((token) => token.startsWith('--sandbox='));
    const mode = inline ? inline.split('=')[1] : at >= 0 ? rest[at + 1] : null;
    if (mode && mode !== 'read-only') throw new Error(`${label} must plan in a read-only sandbox (found --sandbox ${mode}).`);
    if (!mode) rest.push('--sandbox', 'read-only');
  }
  return rest;
}

// The final message of a Codex run: stdout when Codex printed it there, otherwise the text after the last
// "codex" marker in its progress stream, otherwise the end of the stream.
export function finalMessage(stdout, stderr) {
  const out = stripAnsi(stdout).trim();
  if (out) return out;
  const lines = stripAnsi(stderr).split('\n');
  const marker = lines.map((line) => line.trim()).lastIndexOf('codex');
  const text = marker >= 0 ? lines.slice(marker + 1).join('\n').trim() : lines.slice(-40).join('\n').trim();
  return text;
}

function bounded(text) {
  if (byteLength(text) <= MAX_PRINT_BYTES) return text;
  const cut = Buffer.from(text, 'utf8').subarray(0, MAX_PRINT_BYTES).toString('utf8').replace(/�+$/, '');
  return `${cut}\n… (cut at ${formatBytes(MAX_PRINT_BYTES)}; the transcript has the rest)`;
}

function stamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

async function saveTranscript(stateRoot, op, taskHash, date, result) {
  const file = runtimePath(stateRoot, 'codex', `${op}-${taskKey(taskHash)}-${stamp(date)}.log`);
  const text = `exit: ${result.code}${result.timedOut ? ' (timed out)' : ''}\n--- stdout ---\n${result.stdout || ''}\n--- stderr ---\n${result.stderr || ''}`;
  await writeFileAtomic(file, text);
  return { file, bytes: byteLength(`${result.stdout || ''}${result.stderr || ''}`) };
}

function failureBlock(op, result, verdict, transcript) {
  const tail = stripAnsi(`${result.stdout || ''}\n${result.stderr || ''}`).split('\n').map((line) => line.trimEnd()).filter((line) => line.trim()).slice(-15);
  return [
    `CODEX ${op.toUpperCase()} FAILED (${verdict.kind}, exit ${result.code}${result.timedOut ? ', timed out' : ''}): ${redactSecrets(verdict.evidence || 'no error text')}`,
    `  transcript: ${transcript.file}`,
    ...redactSecrets(tail.join('\n')).split('\n').map((line) => `  | ${line}`),
  ].join('\n');
}

// Runs one Codex command with one automatic retry for ordinary rate throttling. Returns the final result plus
// the failure verdict when it failed.
async function invoke({ exec, args, cwd, input, assess, sleep, now }) {
  let attempt = 0;
  for (;;) {
    const result = await exec('codex', args, { cwd, input, timeoutMs: CODEX_TIMEOUT_MS })
      .catch((error) => ({ code: 127, stdout: '', stderr: error.message, timedOut: false }));
    if (result.code === 0 && !result.timedOut) return { result, verdict: null };
    const verdict = assess(`${result.stdout || ''}\n${result.stderr || ''}`, { now: now() });
    if (verdict.kind === 'rate-limit' && attempt === 0) {
      attempt += 1;
      await sleep(20000);
      continue;
    }
    return { result, verdict };
  }
}

export function planningPrompt({ taskFile, capsulePath, contextFiles, note }) {
  const context = capsulePath
    ? `the Context Capsule at ${capsulePath} (exact excerpts of the project context with source paths and hashes; open an original source only when you need more)`
    : `the configured context files that exist (${contextFiles.join(', ') || 'none configured'})`;
  return [
    'You are the architect for this task. Do not write code and do not edit files.',
    `Read the task in ${taskFile} and ${context}, then inspect the relevant code.`,
    'Return a concise implementation plan: approach; files/modules to change; interfaces and data shapes; risks and edge cases; a test plan; ordered implementation steps.',
    note ? `Additional focus from the developer: ${note}` : '',
  ].filter(Boolean).join('\n');
}

// deps: { exec, now, sleep, assess, record(event), onQuota(verdict, step) → lines }
export async function codexPlan(deps, { workRoot, stateRoot, config, taskHash, fingerprint, capsulePath, note, force }) {
  const lines = [];
  if (config.planner?.enabled !== true) {
    await deps.record({ type: 'codex', op: 'plan', outcome: 'disabled' });
    return { code: 0, output: 'Codex planning is off (planner.enabled is not true), so Codex was not asked for a plan. Work from the task file.\n' };
  }
  const args = parseCodexCommand(config.planner?.command || 'codex exec --sandbox read-only', 'plan');
  const planFile = runtimePath(stateRoot, 'codex', `plan-${taskKey(taskHash)}-${(fingerprint || 'none').slice(0, 12)}.md`);
  if (!force) {
    const saved = await fs.readFile(planFile, 'utf8').catch(() => null);
    if (saved) {
      const output = `${bounded(saved.trim())}\n\n(Saved Codex plan for this unchanged task and context: ${planFile}. Codex was not asked again; use --force only if the plan is unusable.)\n`;
      await deps.record({ type: 'codex', op: 'plan', outcome: 'reused', printedBytes: byteLength(output) });
      return { code: 0, output };
    }
  }
  const lastMessage = runtimePath(stateRoot, 'codex', `plan-${taskKey(taskHash)}.last-message.txt`);
  await fs.mkdir(path.dirname(lastMessage), { recursive: true });
  await fs.rm(lastMessage, { force: true });
  const prompt = planningPrompt({ taskFile: config.project?.taskFile || 'NEXT_TASK.md', capsulePath, contextFiles: config.project?.contextFiles || [], note });
  const { result, verdict } = await invoke({ ...deps, args: [...args, '--output-last-message', lastMessage, '-'], cwd: workRoot, input: prompt });
  const transcript = await saveTranscript(stateRoot, 'plan', taskHash, deps.now(), result);
  if (verdict) {
    if (verdict.kind === 'quota') {
      lines.push(...(await deps.onQuota(verdict, 'dev-autopilot codex plan')));
      await deps.record({ type: 'codex', op: 'plan', outcome: 'quota', transcriptBytes: transcript.bytes, printedBytes: byteLength(lines.join('\n')) });
      return { code: QUOTA_EXIT_CODE, output: `${lines.join('\n')}\n  transcript: ${transcript.file}\n` };
    }
    const block = failureBlock('plan', result, verdict, transcript);
    await deps.record({ type: 'codex', op: 'plan', outcome: 'failed', transcriptBytes: transcript.bytes, printedBytes: byteLength(block) });
    return { code: result.code || 1, output: `${block}\n` };
  }
  const fromFile = await fs.readFile(lastMessage, 'utf8').catch(() => '');
  const plan = (stripAnsi(fromFile).trim() || finalMessage(result.stdout, result.stderr)).trim();
  await writeFileAtomic(planFile, `${plan}\n`);
  await fs.rm(lastMessage, { force: true });
  const output = `${bounded(plan)}\n\n(Codex plan saved: ${planFile}; transcript: ${transcript.file})\n`;
  await deps.record({ type: 'codex', op: 'plan', outcome: 'ok', transcriptBytes: transcript.bytes, printedBytes: byteLength(output) });
  return { code: 0, output };
}

// deps as for codexPlan, plus budget: { kind, rounds, maxRounds, reasons }, used: rounds already run for this task,
// saveRound(n) records a completed round.
export async function codexReview(deps, { workRoot, stateRoot, config, taskHash, base, budget, used }) {
  const args = parseCodexCommand(config.reviewer?.command || 'codex review', 'review');
  const why = budget.reasons?.length ? ` (${budget.reasons.slice(0, 3).join('; ')})` : '';
  if (budget.rounds === 0) {
    const output = `SKIP  Codex review not needed: ${budget.kind} change${why}. Review budget 0 of max ${budget.maxRounds}.\n`;
    await deps.record({ type: 'review-skip', kind: budget.kind, avoidedRounds: 1 });
    return { code: 0, output };
  }
  if (used >= budget.rounds) {
    const output = `STOP  Review budget used: ${used} of ${budget.rounds} round(s) for this ${budget.kind} change${why}. Do not run another round. If findings remain, report them as a blocker.\n`;
    if (budget.rounds < budget.maxRounds) await deps.record({ type: 'review-cap', kind: budget.kind, budget: budget.rounds, maxRounds: budget.maxRounds });
    return { code: BUDGET_EXIT_CODE, output };
  }
  const baseArgs = args.includes('--base') ? args : [...args, '--base', base];
  const { result, verdict } = await invoke({ ...deps, args: baseArgs, cwd: workRoot, input: undefined });
  const transcript = await saveTranscript(stateRoot, 'review', taskHash, deps.now(), result);
  if (verdict) {
    if (verdict.kind === 'quota') {
      const lines = await deps.onQuota(verdict, 'dev-autopilot codex review');
      await deps.record({ type: 'codex', op: 'review', outcome: 'quota', transcriptBytes: transcript.bytes, printedBytes: byteLength(lines.join('\n')) });
      return { code: QUOTA_EXIT_CODE, output: `${lines.join('\n')}\n  transcript: ${transcript.file}\n` };
    }
    const block = failureBlock('review', result, verdict, transcript);
    await deps.record({ type: 'codex', op: 'review', outcome: 'failed', transcriptBytes: transcript.bytes, printedBytes: byteLength(block) });
    return { code: result.code || 1, output: `${block}\nThis failed run does not count as a review round.\n` };
  }
  const round = used + 1;
  await deps.saveRound(round);
  const review = finalMessage(result.stdout, result.stderr) || '(Codex returned an empty review.)';
  const next = round < budget.rounds
    ? 'If this review is clean, stop reviewing. After fixing its findings, one more round is allowed.'
    : 'This was the last round in the budget. If findings remain after your fixes, report them as a blocker.';
  const output = `${bounded(review)}\n\n(Codex review round ${round} of ${budget.rounds} for this ${budget.kind} change; max ${budget.maxRounds}. ${next} Transcript: ${transcript.file})\n`;
  await deps.record({ type: 'codex', op: 'review', outcome: 'ok', round, budget: budget.rounds, kind: budget.kind, transcriptBytes: transcript.bytes, printedBytes: byteLength(output) });
  return { code: 0, output };
}
