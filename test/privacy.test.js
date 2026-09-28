import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runProcess } from '../src/lib.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

async function trackedFiles(t) {
  const result = await runProcess('git', ['ls-files', '-z'], { cwd: repoRoot });
  if (result.code !== 0) {
    t.skip('not a git checkout');
    return null;
  }
  return result.stdout.split('\0').filter(Boolean);
}

// Local runtime and credential locations that must never be committed.
const FORBIDDEN_PATHS = [
  /(^|\/)\.autopilot\/runtime\//,
  /(^|\/)\.autopilot\/logs\//,
  /(^|\/)\.claude\/worktrees\//,
  /(^|\/)\.claude\/settings\.local\.json$/,
  /(^|\/)\.claude\/projects\//,
  /(^|\/)\.claude\.json$/,
  /(^|\/)\.credentials\.json$/,
  /(^|\/)\.codex\//,
  /(^|\/)auth\.json$/,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)node_modules\//,
];

// Built from parts so this file doesn't match itself.
const SECRET_PATTERNS = [
  ['GitHub token', new RegExp(`\\b(gh${'[pousr]'}_[A-Za-z0-9]{30,}|github_${'pat'}_[A-Za-z0-9_]{30,})`)],
  ['OpenAI key', new RegExp(`\\bsk-(proj-)?[A-Za-z0-9_-]{32,}`)],
  ['Anthropic key', new RegExp(`\\bsk-${'ant'}-[A-Za-z0-9_-]{20,}`)],
  ['AWS access key', new RegExp(`\\bA${'KIA'}[0-9A-Z]{16}\\b`)],
  ['Slack token', new RegExp(`\\bxox[${'baprs'}]-[A-Za-z0-9-]{10,}`)],
  ['private key', new RegExp(`-----BEGIN [A-Z ]*PRIVATE ${'KEY'}-----`)],
];

// Public contact addresses that may appear; any other personal mailbox must not.
const ALLOWED_EMAILS = new Set(['murtaza@5cube.io', 'iammurtaza53@gmail.com']);
const PERSONAL_EMAIL = /[A-Za-z0-9._%+-]+@(gmail|googlemail|outlook|hotmail|yahoo|icloud|proton|protonmail)\.[a-z.]+/gi;

test('no runtime state, credentials or local agent data is tracked', async (t) => {
  const files = await trackedFiles(t);
  if (!files) return;
  const offenders = files.filter((file) => FORBIDDEN_PATHS.some((pattern) => pattern.test(file)));
  assert.deepEqual(offenders, []);
});

test('tracked files contain no tokens, keys or personal email addresses', async (t) => {
  const files = await trackedFiles(t);
  if (!files) return;
  const findings = [];
  for (const file of files) {
    const text = await fs.readFile(path.join(repoRoot, file), 'utf8').catch(() => '');
    if (text.includes('\0')) continue;
    for (const [label, pattern] of SECRET_PATTERNS) if (pattern.test(text)) findings.push(`${file}: ${label}`);
    for (const email of text.match(PERSONAL_EMAIL) || []) {
      if (!ALLOWED_EMAILS.has(email.toLowerCase())) findings.push(`${file}: personal email address`);
    }
  }
  assert.deepEqual(findings, []);
});
