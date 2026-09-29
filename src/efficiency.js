// Local LeanLoop metrics: bytes Autopilot put in front of the agents, and bytes it kept out. They describe the
// orchestration layer only. Nothing here knows or claims provider-billed tokens, and nothing leaves the machine.
import { promises as fs } from 'node:fs';
import { formatBytes } from './lib.js';
import { runtimePath } from './runtime.js';

// Rough rule of thumb for English prose and code. Reports label every conversion as an estimate.
export const BYTES_PER_TOKEN_ESTIMATE = 4;
const MAX_LEDGER_BYTES = 2 * 1024 * 1024;

function ledgerPath(root) {
  return runtimePath(root, 'efficiency.jsonl');
}

export async function recordEvent(root, event, now = new Date()) {
  if (!root) return;
  const file = ledgerPath(root);
  try {
    await fs.mkdir(runtimePath(root), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify({ t: now.toISOString(), ...event })}\n`, 'utf8');
    const { size } = await fs.stat(file);
    if (size > MAX_LEDGER_BYTES) {
      const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
      await fs.writeFile(file, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`, 'utf8');
    }
  } catch {
    // Metrics are best effort and must never break a command.
  }
}

export async function readEvents(root) {
  const text = await fs.readFile(ledgerPath(root), 'utf8').catch(() => '');
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events;
}

const sum = (items, key) => items.reduce((total, item) => total + (Number(item[key]) || 0), 0);

export function summarize(events, { taskHash = null } = {}) {
  const scoped = taskHash ? events.filter((event) => event.task === taskHash) : events;
  const of = (type) => scoped.filter((event) => event.type === type);
  const capsules = of('capsule');
  const resumes = of('resume');
  const checks = of('check');
  const codex = of('codex');
  const skips = of('review-skip');
  const caps = of('review-cap');
  const context = { launches: capsules.length, rawBytes: sum(capsules, 'rawBytes'), capsuleBytes: sum(capsules, 'capsuleBytes'), reused: capsules.filter((event) => event.reused).length };
  context.avoidedBytes = Math.max(0, context.rawBytes - context.capsuleBytes);
  const resume = {
    total: resumes.length,
    unchanged: resumes.filter((event) => event.kind === 'unchanged').length,
    delta: resumes.filter((event) => event.kind === 'delta').length,
    full: resumes.filter((event) => event.kind === 'full').length,
    respawned: resumes.filter((event) => event.kind === 'respawn').length,
    promptBytes: sum(resumes, 'promptBytes') + sum(resumes, 'deltaBytes'),
    reusedBytes: sum(resumes, 'reusedBytes'),
  };
  const checkRuns = checks.filter((event) => event.status !== 'skipped');
  const check = {
    runs: checkRuns.length,
    failed: checkRuns.filter((event) => event.status === 'fail').length,
    reusedPasses: checkRuns.filter((event) => event.status === 'reused').length,
    logBytes: sum(checkRuns, 'logBytes'),
    compactBytes: sum(checkRuns, 'compactBytes'),
  };
  check.avoidedBytes = Math.max(0, check.logBytes - check.compactBytes);
  const plans = codex.filter((event) => event.op === 'plan');
  const reviews = codex.filter((event) => event.op === 'review');
  const codexSummary = {
    plannerInvocations: plans.filter((event) => ['ok', 'failed', 'quota'].includes(event.outcome)).length,
    plansReused: plans.filter((event) => event.outcome === 'reused').length,
    reviewRounds: reviews.filter((event) => event.outcome === 'ok').length,
    reviewFailures: reviews.filter((event) => ['failed', 'quota'].includes(event.outcome)).length,
    reviewsSkipped: skips.length,
    roundsRefusedAtBudget: caps.length,
    roundsAvoided: skips.reduce((total, event) => total + (event.avoidedRounds || 1), 0) + caps.length,
    transcriptBytes: sum(codex, 'transcriptBytes'),
    printedBytes: sum(codex, 'printedBytes'),
    quotaStops: of('quota').length,
  };
  codexSummary.avoidedBytes = Math.max(0, codexSummary.transcriptBytes - codexSummary.printedBytes);
  const sessions = { duplicateStartsAvoided: of('duplicate-start-avoided').length };
  const avoidedBytes = context.avoidedBytes + resume.reusedBytes + check.avoidedBytes + codexSummary.avoidedBytes;
  return {
    scope: taskHash ? 'current task' : 'all recorded tasks',
    events: scoped.length,
    context,
    resume,
    checks: check,
    codex: codexSummary,
    sessions,
    avoidedBytes,
    tokenEquivalentEstimate: Math.round(avoidedBytes / BYTES_PER_TOKEN_ESTIMATE),
    note: `Local orchestration bytes only. The token figure is an estimate at ${BYTES_PER_TOKEN_ESTIMATE} bytes per token, not provider-billed tokens.`,
  };
}

function percent(part, whole) {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%';
}

export function formatReport(summary) {
  const { context, resume, checks, codex, sessions } = summary;
  return [
    `LeanLoop efficiency: ${summary.scope} (local orchestration metrics; nothing leaves this machine)`,
    `Context:  ${context.launches} capsule(s): configured context ${formatBytes(context.rawBytes)} → capsules ${formatBytes(context.capsuleBytes)} (${formatBytes(context.avoidedBytes)} avoided, ${percent(context.avoidedBytes, context.rawBytes)}); ${context.reused} reused from cache`,
    `Resume:   ${resume.total} (unchanged ${resume.unchanged}, delta ${resume.delta}, full ${resume.full}); ${formatBytes(resume.reusedBytes)} of unchanged context not resent; resume messages ${formatBytes(resume.promptBytes)}`,
    `Checks:   ${checks.runs} run(s), ${checks.failed} failed, ${checks.reusedPasses} pass(es) reused: full logs ${formatBytes(checks.logBytes)} → shown ${formatBytes(checks.compactBytes)} (${percent(checks.avoidedBytes, checks.logBytes)} kept out)`,
    `Codex:    planner ${codex.plannerInvocations} call(s), ${codex.plansReused} plan reuse(s); review ${codex.reviewRounds} round(s), ${codex.reviewsSkipped} skipped by the adaptive policy, ${codex.roundsRefusedAtBudget} refused at the budget; transcripts ${formatBytes(codex.transcriptBytes)} → shown ${formatBytes(codex.printedBytes)}; ${codex.quotaStops} quota stop(s)`,
    `Sessions: ${sessions.duplicateStartsAvoided} duplicate start(s) avoided`,
    `Total kept out of agent context: ${formatBytes(summary.avoidedBytes)} ≈ ${summary.tokenEquivalentEstimate.toLocaleString('en-US')} tokens (estimate)`,
    summary.note,
  ].join('\n');
}
