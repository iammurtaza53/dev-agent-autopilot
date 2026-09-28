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
  } = options;

  return await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer = null;
    let settled = false;

    const stdio = stdin === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'];
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

export async function appendGitignore(root, entries) {
  const file = path.join(root, '.gitignore');
  let text = (await exists(file)) ? await fs.readFile(file, 'utf8') : '';
  const lines = new Set(text.split(/\r?\n/));
  for (const entry of entries) {
    if (lines.has(entry)) continue;
    text += `${text && !text.endsWith('\n') ? '\n' : ''}${entry}\n`;
    lines.add(entry);
  }
  await fs.writeFile(file, text, 'utf8');
}

export function parseBackgroundId(output) {
  const text = String(output || '');
  return (
    /backgrounded\s*[·:]\s*([0-9a-f]{6,})/i.exec(text)?.[1] ||
    /claude\s+attach\s+([0-9a-f]{6,})/i.exec(text)?.[1] ||
    null
  );
}

export function normalizePathForCompare(value) {
  return path.resolve(String(value || '')).replace(/\\/g, '/').toLowerCase();
}
