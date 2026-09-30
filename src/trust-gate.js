// Optional trust-handoff gate. When `trustGate.enabled` is true, Autopilot runs HostLatch
// (github.com/iammurtaza53/hostlatch) on the task branch. HostLatch reports changes that a trusted host could
// execute later with the developer's authority: package lifecycle scripts, IDE tasks, agent hooks and settings,
// MCP commands, CI workflows, Git attributes and dev containers. Autopilot runs it as an external command and
// only reads its JSON manifest; it never changes HostLatch's decision.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { redactSecrets } from './lib.js';
import { runtimePath, taskKey } from './runtime.js';

export const DEFAULT_TRUST_GATE = Object.freeze({ enabled: false, command: 'hostlatch', failOn: 'block' });
const DECISIONS = ['allow', 'review', 'block'];
const FAIL_ON = ['block', 'review'];
const MAX_FINDINGS_SHOWN = 8;
const SCAN_TIMEOUT_MS = 10 * 60 * 1000;

export function trustGateOptions(config) {
  const custom = config?.trustGate && typeof config.trustGate === 'object' ? config.trustGate : {};
  return {
    enabled: custom.enabled === true,
    command: typeof custom.command === 'string' && custom.command.trim() ? custom.command.trim() : DEFAULT_TRUST_GATE.command,
    failOn: FAIL_ON.includes(custom.failOn) ? custom.failOn : DEFAULT_TRUST_GATE.failOn,
  };
}

export function trustGateProblems(config) {
  const gate = config?.trustGate;
  if (gate === undefined) return [];
  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) return ['trustGate must be an object.'];
  const problems = [];
  if (gate.enabled !== undefined && typeof gate.enabled !== 'boolean') problems.push(`trustGate.enabled must be true or false (found ${JSON.stringify(gate.enabled)}).`);
  if (gate.command !== undefined && !(typeof gate.command === 'string' && gate.command.trim())) problems.push('trustGate.command must be a non-empty command, such as "hostlatch".');
  if (gate.failOn !== undefined && !FAIL_ON.includes(gate.failOn)) problems.push(`trustGate.failOn must be "block" or "review" (found ${JSON.stringify(gate.failOn)}).`);
  return problems;
}

// Splits a configured command into program and arguments. Double quotes keep paths with spaces together,
// for example: node "D:/tools/host latch/bin/hostlatch.js". No shell is involved.
export function commandParts(command) {
  const parts = [];
  for (const match of String(command).matchAll(/"([^"]*)"|(\S+)/g)) parts.push(match[1] ?? match[2]);
  return parts;
}

function stamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

// Runs `<command> scan <workRoot> --base <base> --json --output <file> --fail-on never` and returns the parsed
// decision. `--fail-on never` keeps the exit code for real errors; Autopilot applies trustGate.failOn itself.
export async function runTrustScan({ exec, workRoot, stateRoot, config, taskHash, base, now = new Date() }) {
  const options = trustGateOptions(config);
  const [program, ...prefix] = commandParts(options.command);
  const file = runtimePath(stateRoot, 'trust', `${taskKey(taskHash)}-${stamp(now)}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const args = [...prefix, 'scan', workRoot, '--base', base, '--json', '--output', file, '--fail-on', 'never'];
  const result = await exec(program, args, { cwd: workRoot, timeoutMs: SCAN_TIMEOUT_MS })
    .catch((error) => ({ code: 127, stdout: '', stderr: error.message, timedOut: false }));
  let manifest = null;
  for (const source of [() => fs.readFile(file, 'utf8'), async () => result.stdout]) {
    try {
      manifest = JSON.parse(await source());
      break;
    } catch {}
  }
  const decision = manifest?.summary?.decision;
  if (result.code !== 0 || !DECISIONS.includes(decision)) {
    const detail = (result.stderr || result.stdout || '').trim().split(/\r?\n/).find(Boolean) || `exit ${result.code}`;
    return { ok: false, error: redactSecrets(result.code === 0 ? 'HostLatch returned no readable decision' : detail).slice(0, 240), command: options.command };
  }
  return {
    ok: true,
    decision,
    riskScore: manifest.summary.riskScore ?? null,
    findings: Array.isArray(manifest.findings) ? manifest.findings : [],
    bySeverity: manifest.summary.bySeverity || {},
    manifestId: manifest.manifestId || null,
    version: manifest.tool?.version || null,
    file,
  };
}

// The status the gate reports for a scan: a failed scan fails closed, because the owner switched the gate on.
export function trustStatus(scan, failOn) {
  if (!scan.ok) return 'fail';
  if (scan.decision === 'block' || (scan.decision === 'review' && failOn === 'review')) return 'fail';
  return scan.decision === 'review' ? 'review' : 'pass';
}

// The compact check-output block for a scan: one line when it is clean, the findings (without evidence) otherwise.
export function formatTrustBlock(scan, failOn) {
  const status = trustStatus(scan, failOn);
  const label = { pass: 'PASS', review: 'REVIEW', fail: 'FAIL' }[status];
  if (!scan.ok) {
    return { status, text: `${label}  trust handoff (HostLatch)  could not run: ${scan.error}\n  | Install HostLatch or set trustGate.command (for example: npx --yes github:iammurtaza53/hostlatch#v0.2.0).` };
  }
  const severities = Object.entries(scan.bySeverity).filter(([, count]) => count > 0).map(([name, count]) => `${name} ${count}`).join(', ');
  const lines = [`${label}  trust handoff (HostLatch)  ${scan.decision} · risk ${scan.riskScore ?? '?'}/100 · ${scan.findings.length} finding(s)${severities ? ` (${severities})` : ''} · manifest ${scan.manifestId || 'n/a'}`];
  for (const finding of scan.findings.slice(0, MAX_FINDINGS_SHOWN)) {
    lines.push(redactSecrets(`  | [${String(finding.severity || '?').toUpperCase()}] ${finding.ruleId || '?'} ${finding.path || ''}: ${finding.title || ''}`));
  }
  if (scan.findings.length > MAX_FINDINGS_SHOWN) lines.push(`  | …and ${scan.findings.length - MAX_FINDINGS_SHOWN} more`);
  if (scan.findings.length) lines.push(`  manifest: ${scan.file}`);
  if (status === 'fail') lines.push('  A person must review these activation paths before merge. Do not hide or rewrite changes to pass the scan.');
  return { status, text: lines.join('\n') };
}

// High-risk review reasons for a scan that flagged something; empty for a clean or failed scan.
export function trustReviewReasons(scan) {
  if (!scan?.ok || scan.decision === 'allow') return [];
  const top = scan.findings.slice(0, 3).map((finding) => `${finding.ruleId} ${finding.path}`);
  return [`HostLatch ${scan.decision}${top.length ? `: ${top.join(', ')}` : ''}`];
}

export function trustStateOf(scan, at) {
  return scan.ok
    ? { decision: scan.decision, riskScore: scan.riskScore, findings: scan.findings.length, manifestId: scan.manifestId, manifest: scan.file, at }
    : { decision: 'error', error: scan.error, at };
}

