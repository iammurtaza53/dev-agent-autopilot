// LeanLoop Quiet Checks: run the configured checks, keep every byte of their output on disk, and show the agent
// only what it needs: PASS and a duration, or FAIL with the exit code, the log path and a bounded excerpt.
import { spawn } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { byteLength, formatBytes, git, readJsonSafe, redactSecrets, sha256, slugify, stripAnsi, writeJsonAtomic } from './lib.js';
import { runtimePath, taskKey } from './runtime.js';

export const DEFAULT_CHECK_OPTIONS = Object.freeze({
  timeoutMinutes: 30,
  failureExcerptLines: 60,
  failureExcerptBytes: 6000,
  reuseUnchangedPasses: true,
  keepRuns: 10,
});

export function checkOptions(config) {
  const custom = config?.leanloop?.checks || {};
  const options = {};
  for (const key of Object.keys(DEFAULT_CHECK_OPTIONS)) options[key] = custom[key] === undefined ? DEFAULT_CHECK_OPTIONS[key] : custom[key];
  return options;
}

export function checkProblems(config) {
  const problems = [];
  const checks = config?.checks;
  if (checks !== undefined && !Array.isArray(checks)) problems.push('checks must be a list of commands.');
  for (const [index, entry] of (Array.isArray(checks) ? checks : []).entries()) {
    const command = typeof entry === 'string' ? entry : entry?.command;
    if (typeof command !== 'string' || !command.trim()) problems.push(`checks[${index}] must be a command string or { "name", "command" }.`);
  }
  const custom = config?.leanloop?.checks;
  if (custom === undefined) return problems;
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) return [...problems, 'leanloop.checks must be an object.'];
  const whole = (key, min) => {
    const value = custom[key];
    if (value !== undefined && !(Number.isInteger(value) && value >= min)) problems.push(`leanloop.checks.${key} must be a whole number of at least ${min} (found ${JSON.stringify(value)}).`);
  };
  whole('timeoutMinutes', 0);
  whole('failureExcerptLines', 5);
  whole('failureExcerptBytes', 500);
  whole('keepRuns', 1);
  if (custom.reuseUnchangedPasses !== undefined && typeof custom.reuseUnchangedPasses !== 'boolean') problems.push('leanloop.checks.reuseUnchangedPasses must be true or false.');
  return problems;
}

// Checks may be plain command strings (as in every earlier version) or { name, command } objects.
export function normalizeChecks(config) {
  const seen = new Map();
  return (Array.isArray(config?.checks) ? config.checks : [])
    .map((entry) => (typeof entry === 'string' ? { command: entry } : { name: entry?.name, command: entry?.command }))
    .filter((entry) => typeof entry.command === 'string' && entry.command.trim())
    .map((entry) => {
      const base = String(entry.name || entry.command).trim();
      const count = (seen.get(base) || 0) + 1;
      seen.set(base, count);
      return { name: count > 1 ? `${base} #${count}` : base, command: entry.command.trim() };
    });
}

const POSIX = process.platform !== 'win32';

// Stops a check and everything it started. On POSIX the check runs in its own process group, because killing
// only the shell can leave the real command running with the output pipe open.
function killTree(child) {
  if (!child.pid) return;
  if (!POSIX) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    return;
  }
  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
    } catch {
      try { child.kill(name); } catch {}
    }
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), 3000).unref();
}

// A check in its own process group doesn't see Ctrl+C in the terminal, so interrupting dev-autopilot passes the
// signal on to it before dev-autopilot itself stops.
function forwardSignals(child) {
  if (!POSIX || !child.pid) return () => {};
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((name) => {
    const handler = () => {
      try { process.kill(-child.pid, name); } catch {}
      for (const [other, fn] of handlers) process.removeListener(other, fn);
      process.kill(process.pid, name);
    };
    process.on(name, handler);
    return [name, handler];
  });
  return () => {
    for (const [name, fn] of handlers) process.removeListener(name, fn);
  };
}

// Runs one shell command with stdout and stderr streamed, in arrival order, into logFile.
export function runLogged(command, { cwd, env = process.env, logFile, timeoutMs = 0 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const out = createWriteStream(logFile);
    let bytes = 0;
    let timedOut = false;
    let settled = false;
    let timer = null;
    let unforward = () => {};
    const finish = (code, spawnError = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unforward();
      if (spawnError) {
        const note = `dev-autopilot: could not start the command: ${spawnError}\n`;
        bytes += Buffer.byteLength(note);
        out.write(note);
      }
      out.end(() => resolve({ code, bytes, durationMs: Date.now() - started, timedOut }));
    };
    let child;
    try {
      child = spawn(command, { cwd, env, shell: true, windowsHide: true, detached: POSIX, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish(127, error.message);
      return;
    }
    unforward = forwardSignals(child);
    const onData = (chunk) => {
      bytes += chunk.length;
      out.write(chunk);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (error) => finish(127, error.message));
    child.on('close', (code) => finish(timedOut ? 124 : code ?? 1));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        const note = `\ndev-autopilot: timed out after ${Math.round(timeoutMs / 1000)}s; stopping the command.\n`;
        bytes += Buffer.byteLength(note);
        out.write(note);
        killTree(child);
      }, timeoutMs);
    }
  });
}

// Reads a log for analysis: the whole file up to 8 MB, otherwise its first and last 2 MB.
async function readLog(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const limit = 8 * 1024 * 1024;
    if (size <= limit) {
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, 0);
      return buffer.toString('utf8');
    }
    const part = 2 * 1024 * 1024;
    const head = Buffer.alloc(part);
    const tail = Buffer.alloc(part);
    await handle.read(head, 0, part, 0);
    await handle.read(tail, 0, part, size - part);
    return `${head.toString('utf8')}\n… (${formatBytes(size - 2 * part)} not analysed) …\n${tail.toString('utf8')}`;
  } finally {
    await handle.close();
  }
}

const FAILURE_LINE = /\b(?:errors?|failed|failure|failing|fail|exception|traceback|panic(?:ked)?|assert(?:ion)?(?:error)?|expected|received|not ok|segmentation fault|cannot find|undefined reference|no such file|timed out)\b|✖|✗|✘|×|\bFAIL\b|ERR!/i;
const PASS_LINE = /^\s*(?:✔|✓|√|ok\b|PASS\b|passed\b)/i;

function cleanLines(text) {
  const lines = stripAnsi(text).split('\n').map((line) => line.trimEnd());
  const out = [];
  for (const line of lines) {
    if (!line.trim() && (!out.length || !out.at(-1).trim())) continue;
    out.push(line);
  }
  while (out.length && !out.at(-1).trim()) out.pop();
  return out;
}

// A bounded, deterministic excerpt of a failing check: windows around the first failure markers plus the end of
// the log, where runners print their summary. Gaps are marked, and credential-like values are redacted.
export function failureExcerpt(text, { maxLines = 60, maxBytes = 6000 } = {}) {
  const lines = cleanLines(text);
  const total = lines.length;
  const anchors = [];
  lines.forEach((line, index) => {
    if (FAILURE_LINE.test(line) && !PASS_LINE.test(line)) anchors.push(index);
  });
  let picked;
  if (!anchors.length || total <= maxLines) {
    picked = new Set(lines.map((_, index) => index).slice(-maxLines));
  } else {
    picked = new Set();
    const tailLines = Math.max(5, Math.floor(maxLines * 0.35));
    const headBudget = maxLines - tailLines;
    for (const anchor of anchors) {
      for (let index = Math.max(0, anchor - 2); index <= Math.min(total - 1, anchor + 6); index += 1) {
        if (picked.size >= headBudget) break;
        picked.add(index);
      }
      if (picked.size >= headBudget) break;
    }
    for (let index = Math.max(0, total - tailLines); index < total; index += 1) picked.add(index);
  }
  const indexes = [...picked].sort((a, b) => a - b);
  const out = [];
  let previous = -1;
  for (const index of indexes) {
    if (index > previous + 1) out.push(previous === -1 && index > 0 ? `… (${index} earlier lines)` : '…');
    out.push(lines[index]);
    previous = index;
  }
  let excerptText = redactSecrets(out.join('\n'));
  if (byteLength(excerptText) > maxBytes) {
    const keep = Math.floor(maxBytes / 2);
    const buffer = Buffer.from(excerptText, 'utf8');
    const head = buffer.subarray(0, keep).toString('utf8').replace(/�+$/, '');
    const tail = buffer.subarray(buffer.length - keep).toString('utf8').replace(/^�+/, '');
    excerptText = `${head.slice(0, head.lastIndexOf('\n'))}\n… (excerpt cut to ${formatBytes(maxBytes)}) …\n${tail.slice(tail.indexOf('\n') + 1)}`;
  }
  return { text: excerptText, shownLines: out.length, totalLines: total };
}

// One short, optional fact from a passing run, such as "93 passed". Empty when nothing matches confidently.
export function passSummary(text) {
  const lines = cleanLines(String(text).slice(-16384)).map((line) => line.trim()).filter(Boolean).slice(-80);
  const find = (pattern) => {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const match = pattern.exec(lines[index]);
      if (match) return match;
    }
    return null;
  };
  const nodePass = find(/^ℹ pass (\d+)$/);
  if (nodePass) {
    const skipped = find(/^ℹ skipped (\d+)$/);
    return `${nodePass[1]} passed${skipped && skipped[1] !== '0' ? `, ${skipped[1]} skipped` : ''}`;
  }
  const cargo = find(/test result: ok\. (\d+) passed/);
  if (cargo) return `${cargo[1]} passed`;
  const jest = find(/^Tests?:?\s+(?=\d)(.*\b\d+ passed\b.*)$/i);
  if (jest) return jest[1].replace(/\s+/g, ' ').slice(0, 80);
  const pytest = find(/^=+\s*(.*\b\d+ passed\b.*?)\s+in\s+[\d.]+s\b/i);
  if (pytest) return pytest[1].slice(0, 80);
  const mocha = find(/^(\d+) passing\b/);
  if (mocha) return `${mocha[1]} passed`;
  const goPackages = lines.filter((line) => /^ok\s+\S+/.test(line)).length;
  if (goPackages) return `${goPackages} package${goPackages === 1 ? '' : 's'} ok`;
  const generic = find(/\b(\d+) (?:tests? )?passed\b/i);
  return generic ? `${generic[1]} passed` : '';
}

// Identifies the exact working tree: HEAD, staged and unstaged changes, and untracked (not ignored) files.
// Returns null when it can't be computed cheaply, and then nothing is reused.
export async function treeFingerprint(workRoot, runGit = git) {
  const head = await runGit(workRoot, ['rev-parse', 'HEAD']).catch(() => null);
  const status = await runGit(workRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).catch(() => null);
  const diff = await runGit(workRoot, ['diff', 'HEAD', '--no-ext-diff', '--binary']).catch(() => null);
  if (!head || head.code !== 0 || !status || status.code !== 0 || !diff || diff.code !== 0) return null;
  const untracked = status.stdout.split('\0').filter((item) => item.startsWith('?? ')).map((item) => item.slice(3));
  if (untracked.length > 2000) return null;
  const hashes = [];
  let total = 0;
  for (const rel of untracked.sort()) {
    const buffer = await fs.readFile(path.join(workRoot, rel)).catch(() => null);
    if (!buffer) return null;
    total += buffer.length;
    if (total > 50 * 1024 * 1024) return null;
    hashes.push([rel, sha256(buffer)]);
  }
  return sha256(JSON.stringify([path.resolve(workRoot), head.stdout.trim(), status.stdout, sha256(diff.stdout), hashes]));
}

function runIdFrom(date) {
  const iso = date.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}-${iso.slice(20, 23)}`;
}

function formatDuration(ms) {
  return ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

async function pruneRuns(taskDir, keep) {
  const names = (await fs.readdir(taskDir).catch(() => [])).filter((name) => /^\d{8}-\d{6}-\d{3}$/.test(name)).sort();
  for (const name of names.slice(0, Math.max(0, names.length - keep))) await fs.rm(path.join(taskDir, name), { recursive: true, force: true });
}

function selectChecks(checks, only) {
  if (!only) return checks;
  const wanted = String(only).trim();
  const byIndex = /^\d+$/.test(wanted) ? checks[Number(wanted) - 1] : null;
  const matches = byIndex ? [byIndex] : checks.filter((check) => check.name === wanted || check.command === wanted);
  if (!matches.length) throw new Error(`No configured check matches "${wanted}". Configured: ${checks.map((check, index) => `${index + 1}. ${check.name}`).join(', ')}`);
  return matches;
}

// Runs the checks sequentially and returns the compact report plus per-check results.
export async function runChecks({ workRoot, stateRoot, config, taskHash, only, bail = false, force = false, now = () => new Date(), runGit = git, env = process.env }) {
  const options = checkOptions(config);
  const checks = selectChecks(normalizeChecks(config), only);
  const startedAt = now();
  const runId = runIdFrom(startedAt);
  const taskDir = runtimePath(stateRoot, 'checks', taskKey(taskHash));
  const runDir = path.join(taskDir, runId);
  const latestFile = path.join(taskDir, 'latest.json');
  const latest = (await readJsonSafe(latestFile)) || {};
  const reuse = options.reuseUnchangedPasses && !force;
  const tree = reuse ? await treeFingerprint(workRoot, runGit) : null;
  await fs.mkdir(runDir, { recursive: true });

  const results = [];
  const lines = [];
  let failed = false;
  for (const [index, check] of checks.entries()) {
    if (failed && bail) {
      results.push({ ...check, status: 'skipped' });
      lines.push(`SKIP  ${check.name}  (after an earlier failure; --bail)`);
      continue;
    }
    const reuseKey = tree ? sha256(JSON.stringify([tree, check.command])) : null;
    const previous = latest[check.name];
    if (reuseKey && previous?.status === 'pass' && previous.reuseKey === reuseKey) {
      const line = `PASS  ${check.name}  (reused: tree unchanged since ${previous.at}; --force reruns)`;
      lines.push(line);
      results.push({ ...check, status: 'reused', exitCode: 0, durationMs: 0, logFile: previous.logFile, logBytes: previous.logBytes || 0, compactBytes: byteLength(line) });
      continue;
    }
    const logFile = path.join(runDir, `${String(index + 1).padStart(2, '0')}-${slugify(check.name, 40)}.log`);
    const run = await runLogged(check.command, { cwd: workRoot, env, logFile, timeoutMs: options.timeoutMinutes * 60000 });
    const passed = run.code === 0 && !run.timedOut;
    let block;
    if (passed) {
      const meta = passSummary(await readLog(logFile));
      block = `PASS  ${check.name}  (${formatDuration(run.durationMs)})${meta ? ` · ${meta}` : ''}`;
    } else {
      failed = true;
      const excerptResult = failureExcerpt(await readLog(logFile), { maxLines: options.failureExcerptLines, maxBytes: options.failureExcerptBytes });
      const why = run.timedOut ? `timed out after ${options.timeoutMinutes}m` : `exit ${run.code}`;
      block = [
        `FAIL  ${check.name}  ${why}  (${formatDuration(run.durationMs)})`,
        `  log: ${logFile} (${formatBytes(run.bytes)})`,
        `  excerpt: ${excerptResult.shownLines} of ${excerptResult.totalLines} lines`,
        ...excerptResult.text.split('\n').map((line) => `  | ${line}`),
      ].join('\n');
    }
    lines.push(block);
    const result = { ...check, status: passed ? 'pass' : 'fail', exitCode: run.code, timedOut: run.timedOut, durationMs: run.durationMs, logFile, logBytes: run.bytes, compactBytes: byteLength(block) };
    results.push(result);
    latest[check.name] = { status: result.status, at: `${startedAt.toISOString().slice(0, 19).replace('T', ' ')} UTC`, runId, logFile, logBytes: run.bytes, reuseKey };
  }

  const passedCount = results.filter((result) => result.status === 'pass' || result.status === 'reused').length;
  const failedCount = results.filter((result) => result.status === 'fail').length;
  const footer = checks.length
    ? `checks: ${passedCount} passed, ${failedCount} failed${results.some((result) => result.status === 'skipped') ? `, ${results.filter((result) => result.status === 'skipped').length} skipped` : ''}${failedCount ? ' · full log: dev-autopilot check --log <name>' : ''}`
    : 'No checks are configured in "checks" in .autopilot/config.json.';
  lines.push(footer);
  const output = `${lines.join('\n')}\n`;

  await writeJsonAtomic(path.join(runDir, 'summary.json'), {
    runId,
    taskHash: taskHash || null,
    workRoot,
    startedAt: startedAt.toISOString(),
    results: results.map(({ name, command, status, exitCode, durationMs, logFile, logBytes, compactBytes }) => ({ name, command, status, exitCode, durationMs, logFile, logBytes, compactBytes })),
  });
  await writeJsonAtomic(latestFile, latest);
  await pruneRuns(taskDir, options.keepRuns);
  return { runId, output, results, status: failedCount ? 'fail' : 'pass', checksConfigured: checks.length };
}

// Finds the stored log of the latest run of one check, by name, command or 1-based position.
export async function latestLog({ stateRoot, config, taskHash, check }) {
  const checks = normalizeChecks(config);
  const [match] = selectChecks(checks, check);
  const latest = (await readJsonSafe(runtimePath(stateRoot, 'checks', taskKey(taskHash), 'latest.json'))) || {};
  const entry = latest[match.name];
  if (!entry?.logFile) throw new Error(`No stored log for "${match.name}" yet. Run dev-autopilot check first.`);
  const text = await fs.readFile(entry.logFile, 'utf8').catch(() => null);
  if (text === null) throw new Error(`The stored log for "${match.name}" is gone (${entry.logFile}). Run dev-autopilot check again.`);
  return { name: match.name, file: entry.logFile, status: entry.status, text };
}

