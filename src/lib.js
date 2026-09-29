import spawn from 'cross-spawn';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

export async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

// Distinguishes "no fallback given" from an explicit fallback such as null.
const NO_FALLBACK = Symbol('NO_FALLBACK');

export async function readJson(file, fallback = NO_FALLBACK) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' && fallback !== NO_FALLBACK) return fallback;
    throw error;
  }
}

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// Writes through a temporary file and a rename, so a reader never sees a half-written file.
export async function writeFileAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temp, text, 'utf8');
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(temp, file);
      return;
    } catch (error) {
      // Windows refuses the rename while another process has the target open; that clears quickly.
      if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) {
        await fs.rm(temp, { force: true });
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

export async function writeJsonAtomic(file, value) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

// Reads JSON that Autopilot wrote itself; a missing or unreadable file counts as absent.
export async function readJsonSafe(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

// Escape sequences (CSI, OSC and two-byte), carriage-return progress redraws and other control characters.
const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export function stripAnsi(text) {
  return String(text ?? '')
    .replace(ANSI_SEQUENCE, '')
    .replace(/\r\n/g, '\n')
    .replace(/[^\n]*\r(?!\n)/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

// High-confidence credential formats. A match is never cached, excerpted or echoed back to an agent.
export const SECRET_PATTERNS = [
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g],
  ['OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['Stripe key', /\b[rs]k_live_[A-Za-z0-9]{20,}/g],
  ['private key', new RegExp(`-----BEGIN [A-Z ]*PRIVATE ${'KEY'}-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE ${'KEY'}-----|$)`, 'g')],
];

export function findSecrets(text) {
  const found = [];
  for (const [label, pattern] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(String(text ?? ''))) found.push(label);
    pattern.lastIndex = 0;
  }
  return found;
}

export function redactSecrets(text) {
  let result = String(text ?? '');
  for (const [label, pattern] of SECRET_PATTERNS) result = result.replace(pattern, `[REDACTED ${label}]`);
  return result;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

export function slugify(value, max = 52) {
  return (
    String(value || 'project')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/g, '') || 'project'
  );
}

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex');
}

export async function runProcess(command, args = [], options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = 0,
    stream = false,
    stdin = 'pipe',
    input,
  } = options;

  return await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer = null;
    let settled = false;

    // `input` is written to the child's stdin; otherwise stdin is closed, like `< /dev/null`.
    const stdio = stdin === 'inherit' ? 'inherit' : [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'];
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: stdin !== 'inherit',
      stdio,
    });

    if (stdin === 'inherit') {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code: code ?? 1, signal, stdout: '', stderr: '', timedOut: false }));
      return;
    }

    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (stream) process.stdout.write(text);
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (stream) process.stderr.write(text);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, 3000).unref();
      }, timeoutMs);
    }

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? (timedOut ? 124 : 1), signal, stdout, stderr, timedOut });
    });
  });
}

export async function git(cwd, args, options = {}) {
  return runProcess('git', args, { cwd, ...options });
}

export async function currentBranch(cwd) {
  const result = await git(cwd, ['branch', '--show-current']);
  if (result.code !== 0) throw new Error(result.stderr || 'Unable to read current branch');
  return result.stdout.trim();
}

export async function isDirty(cwd) {
  const result = await git(cwd, ['status', '--porcelain']);
  if (result.code !== 0) throw new Error(result.stderr || 'Unable to read git status');
  return result.stdout.trim().length > 0;
}

// `dir/`, `/dir/`, `dir` and `/dir` all ignore the directory `dir`, so they count as the same entry.
function gitignoreKey(line) {
  return line.trimEnd().replace(/^\//, '').replace(/\/$/, '');
}

// Appends missing entries, keeps existing content untouched, and returns the entries it added.
export async function appendGitignore(root, entries) {
  const file = path.join(root, '.gitignore');
  let text = (await exists(file)) ? await fs.readFile(file, 'utf8') : '';
  const keys = new Set(text.split(/\r?\n/).map(gitignoreKey));
  const added = [];
  for (const entry of entries) {
    const key = gitignoreKey(entry);
    if (keys.has(key)) continue;
    text += `${text && !text.endsWith('\n') ? '\n' : ''}${entry}\n`;
    keys.add(key);
    added.push(entry);
  }
  if (added.length) await fs.writeFile(file, text, 'utf8');
  return added;
}

export function parseBackgroundId(output) {
  const text = String(output || '');
  return (
    /backgrounded\s*[·:]\s*([0-9a-f]{6,})/i.exec(text)?.[1] ||
    /claude\s+attach\s+([0-9a-f]{6,})/i.exec(text)?.[1] ||
    null
  );
}

// Windows and macOS file systems are case-insensitive by default, so paths are case-folded only there.
export function normalizePathForCompare(value, platform = process.platform) {
  const normalized = path.resolve(String(value || '')).replace(/\\/g, '/');
  return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized;
}
