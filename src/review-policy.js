// LeanLoop adaptive review budget: how many Codex review rounds a change gets, decided from the actual git diff.
// No model is asked to classify anything, and reviewer.maxRounds stays the strict upper limit.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { git } from './lib.js';

export const DEFAULT_MAX_ROUNDS = 2;

export const DEFAULT_ADAPTIVE = Object.freeze({
  enabled: true,
  docsOnlyRounds: 0,
  smallRounds: 1,
  normalRounds: 2,
  highRiskRounds: null, // null: reviewer.maxRounds
  smallMaxFiles: 3,
  smallMaxLines: 80,
  docsExtensions: ['.md', '.markdown', '.txt', '.rst', '.adoc'],
  highRiskPaths: [],
  highRiskKeywords: [],
  useDefaultHighRisk: true,
});

// Built-in high-risk path rules, matched against the lower-cased repository path.
export const DEFAULT_HIGH_RISK_RULES = [
  ['security/auth', /(^|\/)[^/]*(auth|login|logout|oauth|jwt|passw|permission|rbac|acl|security|crypto|csrf|sanitiz)[^/]*(\/|$)/],
  ['payments/billing', /(^|\/)[^/]*(payment|billing|invoice|checkout|stripe|paypal|subscription|pricing|refund|payout|wallet)[^/]*(\/|$)/],
  ['database migration', /(^|\/)(migrations?|migrate|alembic|prisma|flyway|liquibase)(\/|$)|\.sql$|(^|\/)[^/]*migration[^/]*$|(^|\/)schema\.(prisma|rb|sql|graphql)$/],
  ['secrets/credentials', /(^|\/)\.env(\.|$)|\.(pem|key|p12|pfx|jks|keystore|kdbx)$|(^|\/)[^/]*(secret|credential)[^/]*$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)/],
  ['release/deployment', /(^|\/)(deploy|deployment|deployments|release|releases|infra|infrastructure|k8s|kubernetes|helm|terraform|ansible|fastlane)(\/|$)|(^|\/)[^/]*(deploy|release)[^/]*\.(ya?ml|json|toml|sh|ps1|js|ts)$|(^|\/)(dockerfile[^/]*|containerfile|docker-compose[^/]*|compose\.ya?ml|procfile|vercel\.json|netlify\.toml|fly\.toml|app\.ya?ml|eas\.json|serverless\.ya?ml|cname)$|\.tf$/],
  ['dependencies/lockfile', /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb?|requirements[^/]*\.txt|pipfile(\.lock)?|poetry\.lock|pyproject\.toml|setup\.py|setup\.cfg|go\.mod|go\.sum|cargo\.toml|cargo\.lock|gemfile(\.lock)?|composer\.(json|lock)|packages\.config|directory\.packages\.props|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|podfile(\.lock)?|package\.swift|package\.resolved|\.npmrc|\.yarnrc(\.yml)?|deno\.jsonc?|deno\.lock|mix\.(exs|lock)|pubspec\.(yaml|lock))$|\.csproj$/],
  ['CI/workflow', /^\.github\/(workflows|actions)\/|^\.gitlab-ci\.yml$|^\.circleci\/|^azure-pipelines[^/]*$|(^|\/)jenkinsfile$|^\.buildkite\/|^\.travis\.yml$|^bitbucket-pipelines\.yml$|^\.github\/dependabot\.yml$|(^|\/)codeowners$|^\.pre-commit-config\.yaml$|^\.husky\//],
  ['native/build configuration', /(^|\/)(androidmanifest\.xml|info\.plist|[^/]*\.entitlements|[^/]*\.pbxproj|makefile|cmakelists\.txt|[^/]*\.cmake|binding\.gyp|build\.rs|tsconfig[^/]*\.json|jsconfig\.json|babel\.config\.[^/]+|\.babelrc[^/]*|webpack\.config\.[^/]+|vite\.config\.[^/]+|rollup\.config\.[^/]+|metro\.config\.[^/]+|next\.config\.[^/]+|nuxt\.config\.[^/]+|svelte\.config\.[^/]+|angular\.json|app\.json|app\.config\.[^/]+|gradle-wrapper\.properties|\.nvmrc|\.node-version|\.tool-versions)$|(^|\/)(android|ios)\/.*\.(gradle|xml|plist|pbxproj|xcconfig|entitlements)$/],
  ['agent instructions', /(^|\/)(claude|agents|claude\.local)\.md$|^\.claude\/|^\.codex\/|^\.autopilot\/|^\.cursor\/|^\.github\/copilot-instructions\.md$|^\.mcp\.json$|(^|\/)\.cursorrules$/],
  ['repository security config', /(^|\/)(\.gitignore|\.gitattributes|\.dockerignore|security\.md)$/],
];

// Built-in keywords searched in changed lines of non-documentation files.
export const DEFAULT_HIGH_RISK_KEYWORDS = [
  'password', 'passwd', 'secret', 'api_key', 'apikey', 'api-key', 'private_key', 'privatekey', 'credential', 'oauth', 'jwt',
  'bearer', 'authorization', 'authenticat', 'csrf', 'xss', 'sanitiz', 'encrypt', 'decrypt', 'createCipher', 'payment', 'billing',
  'stripe', 'paypal', 'invoice', 'refund', 'DROP TABLE', 'ALTER TABLE', 'DELETE FROM', 'TRUNCATE TABLE', 'child_process',
  'dangerouslySetInnerHTML', 'innerHTML', 'eval(', 'setuid', 'sudo ',
];

const KINDS = ['empty', 'docs-only', 'small', 'normal', 'high-risk'];

export function adaptiveOptions(config) {
  const raw = config?.reviewer?.adaptive;
  if (raw === false) return { ...DEFAULT_ADAPTIVE, enabled: false };
  const custom = raw && typeof raw === 'object' ? raw : {};
  const options = {};
  for (const key of Object.keys(DEFAULT_ADAPTIVE)) options[key] = custom[key] === undefined ? DEFAULT_ADAPTIVE[key] : custom[key];
  return options;
}

export function adaptiveProblems(config) {
  const raw = config?.reviewer?.adaptive;
  if (raw === undefined || raw === false || raw === true) return [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['reviewer.adaptive must be an object, true or false.'];
  const problems = [];
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') problems.push('reviewer.adaptive.enabled must be true or false.');
  const whole = (key, min) => {
    const value = raw[key];
    if (value !== undefined && !(Number.isInteger(value) && value >= min)) problems.push(`reviewer.adaptive.${key} must be a whole number of at least ${min} (found ${JSON.stringify(value)}).`);
  };
  whole('docsOnlyRounds', 0);
  // Code changes always get at least one Codex review round.
  whole('smallRounds', 1);
  whole('normalRounds', 1);
  if (raw.highRiskRounds !== undefined && raw.highRiskRounds !== null) whole('highRiskRounds', 1);
  whole('smallMaxFiles', 0);
  whole('smallMaxLines', 0);
  for (const key of ['docsExtensions', 'highRiskPaths', 'highRiskKeywords']) {
    const value = raw[key];
    if (value !== undefined && !(Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim()))) problems.push(`reviewer.adaptive.${key} must be a list of non-empty strings.`);
  }
  if (raw.useDefaultHighRisk !== undefined && typeof raw.useDefaultHighRisk !== 'boolean') problems.push('reviewer.adaptive.useDefaultHighRisk must be true or false.');
  return problems;
}

// Gitignore-style globs: `*` stays within a folder, `**` crosses folders, and a pattern without a slash
// matches the file or folder name anywhere. Matching ignores case.
export function globToRegExp(glob) {
  let pattern = String(glob).trim().replace(/\\/g, '/');
  const anchored = pattern.startsWith('/');
  if (anchored) pattern = pattern.slice(1);
  if (pattern.endsWith('/')) pattern += '**';
  const hasSlash = pattern.replace(/\/\*\*$/, '').includes('/');
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const prefix = anchored || hasSlash ? '^' : '^(?:.*/)?';
  const suffix = hasSlash ? '$' : '(?:/.*)?$';
  return new RegExp(`${prefix}${source}${suffix}`, 'i');
}

function keywordPattern(keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(/^\w/.test(keyword) ? `\\b${escaped}` : escaped, 'i');
}

function isDoc(file, extensions) {
  const lower = file.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension.toLowerCase()));
}

export function highRiskReasons(filePath, options) {
  const lower = String(filePath).replace(/\\/g, '/').toLowerCase();
  const reasons = [];
  if (options.useDefaultHighRisk) for (const [label, pattern] of DEFAULT_HIGH_RISK_RULES) if (pattern.test(lower)) reasons.push(label);
  for (const glob of options.highRiskPaths) if (globToRegExp(glob).test(lower)) reasons.push(`reviewer.adaptive.highRiskPaths "${glob}"`);
  return reasons;
}

// files: [{ path, oldPath?, added, removed, binary, lines: [changed line text] }]
export function classifyChange(files, config) {
  const options = adaptiveOptions(config);
  if (!files.length) return { kind: 'empty', reasons: ['no changes against the base branch'], files: 0, lines: 0 };
  const lines = files.reduce((sum, file) => sum + (file.added || 0) + (file.removed || 0), 0);
  const highRisk = [];
  for (const file of files) {
    for (const candidate of [file.path, file.oldPath].filter(Boolean)) {
      for (const reason of highRiskReasons(candidate, options)) highRisk.push(`${candidate}: ${reason}`);
    }
  }
  const keywords = [...(options.useDefaultHighRisk ? DEFAULT_HIGH_RISK_KEYWORDS : []), ...options.highRiskKeywords];
  const patterns = keywords.map((keyword) => [keyword, keywordPattern(keyword)]);
  for (const file of files) {
    if (isDoc(file.path, options.docsExtensions)) continue;
    const hits = new Set();
    for (const line of file.lines || []) for (const [keyword, pattern] of patterns) if (pattern.test(line)) hits.add(keyword.trim());
    if (hits.size) highRisk.push(`${file.path}: changed lines mention ${[...hits].slice(0, 4).map((hit) => `"${hit}"`).join(', ')}`);
  }
  const summary = { files: files.length, lines };
  if (highRisk.length) return { kind: 'high-risk', reasons: [...new Set(highRisk)], ...summary };
  const docsOnly = files.every((file) => !file.binary && isDoc(file.path, options.docsExtensions) && (!file.oldPath || isDoc(file.oldPath, options.docsExtensions)));
  if (docsOnly) return { kind: 'docs-only', reasons: [`only documentation files (${options.docsExtensions.join(', ')})`], ...summary };
  const binary = files.filter((file) => file.binary).map((file) => file.path);
  if (!binary.length && files.length <= options.smallMaxFiles && lines <= options.smallMaxLines) {
    return { kind: 'small', reasons: [`${files.length} file(s), ${lines} changed line(s): within ${options.smallMaxFiles} files and ${options.smallMaxLines} lines`], ...summary };
  }
  const why = binary.length ? `binary file(s) changed: ${binary.slice(0, 3).join(', ')}` : `${files.length} file(s), ${lines} changed line(s): above the small-change limits (${options.smallMaxFiles} files, ${options.smallMaxLines} lines)`;
  return { kind: 'normal', reasons: [why], ...summary };
}

export function roundsFor(kind, config) {
  const maxRounds = config?.reviewer?.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const options = adaptiveOptions(config);
  if (!options.enabled) return { rounds: maxRounds, maxRounds, adaptive: false };
  const byKind = {
    empty: 0,
    'docs-only': options.docsOnlyRounds,
    small: options.smallRounds,
    normal: options.normalRounds,
    'high-risk': options.highRiskRounds ?? maxRounds,
  };
  return { rounds: Math.min(byKind[kind] ?? maxRounds, maxRounds), maxRounds, adaptive: true };
}

// A budget never shrinks within a task: once a change has earned more rounds, later fixes can't lower it.
export function reviewBudget(classification, config, previous = null) {
  const { rounds, maxRounds, adaptive } = roundsFor(classification.kind, config);
  const earlier = previous && KINDS.includes(previous.kind) ? previous : null;
  if (earlier && earlier.rounds > rounds) {
    return { ...classification, rounds: Math.min(earlier.rounds, maxRounds), maxRounds, adaptive, keptFrom: earlier.kind };
  }
  return { ...classification, rounds, maxRounds, adaptive };
}

export async function resolveBase(workRoot, base, runGit = git) {
  for (const ref of [base, `origin/${base}`]) {
    const result = await runGit(workRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(() => null);
    if (result?.code === 0) return ref;
  }
  return null;
}

function parseNumstat(text) {
  const tokens = text.split('\0');
  const files = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(token);
    if (!match) continue;
    const binary = match[1] === '-' || match[2] === '-';
    const entry = { added: binary ? 0 : Number(match[1]), removed: binary ? 0 : Number(match[2]), binary, lines: [] };
    if (match[3]) entry.path = match[3];
    else {
      entry.oldPath = tokens[index + 1];
      entry.path = tokens[index + 2];
      index += 2;
    }
    if (entry.path) files.push(entry);
  }
  return files;
}

// Changed lines per file, from a zero-context patch, for the keyword scan.
function attachPatchLines(files, patch) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  let current = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) current = null;
    else if (line.startsWith('+++ ')) {
      const target = line.slice(4).replace(/^b\//, '');
      current = byPath.get(target) || null;
    } else if (current && (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('---')) {
      if (current.lines.length < 5000) current.lines.push(line.slice(1));
    }
  }
}

// Everything the branch changes against the merge base with the base branch: commits, staged and unstaged
// edits, and untracked files that aren't ignored.
export async function collectDiff(workRoot, base, runGit = git) {
  const ref = await resolveBase(workRoot, base, runGit);
  if (!ref) throw new Error(`Base branch "${base}" was not found (tried ${base} and origin/${base}).`);
  const mergeBase = await runGit(workRoot, ['merge-base', ref, 'HEAD']);
  if (mergeBase.code !== 0) throw new Error(`Could not find the merge base of ${ref} and HEAD: ${(mergeBase.stderr || '').trim()}`);
  const baseSha = mergeBase.stdout.trim();
  const numstat = await runGit(workRoot, ['-c', 'core.quotepath=off', 'diff', '--numstat', '-z', '-M', '--no-ext-diff', baseSha]);
  if (numstat.code !== 0) throw new Error(`git diff failed: ${(numstat.stderr || '').trim()}`);
  const files = parseNumstat(numstat.stdout);
  const patch = await runGit(workRoot, ['-c', 'core.quotepath=off', 'diff', '-U0', '--no-color', '--no-ext-diff', '-M', baseSha]);
  if (patch.code === 0) attachPatchLines(files, patch.stdout.slice(0, 8 * 1024 * 1024));

  const untracked = await runGit(workRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untracked.code === 0) {
    for (const rel of untracked.stdout.split('\0').filter(Boolean)) {
      const buffer = await fs.readFile(path.join(workRoot, rel)).catch(() => null);
      if (!buffer) continue;
      const binary = buffer.includes(0);
      const text = binary ? '' : buffer.subarray(0, 1024 * 1024).toString('utf8');
      const lines = binary ? [] : text.split(/\r?\n/).filter((line, index, all) => index < all.length - 1 || line);
      files.push({ path: rel.replace(/\\/g, '/'), added: lines.length, removed: 0, binary, lines: lines.slice(0, 5000), untracked: true });
    }
  }
  return { base: ref, mergeBase: baseSha, files };
}
