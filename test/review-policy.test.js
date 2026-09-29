import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { adaptiveProblems, classifyChange, collectDiff, globToRegExp, highRiskReasons, reviewBudget, roundsFor } from '../src/review-policy.js';
import { buildConfig, configProblems } from '../src/cli.js';
import { gitIn, tempRoot, v031Config } from './helpers.js';

const file = (filePath, added = 5, removed = 0, lines = []) => ({ path: filePath, added, removed, binary: false, lines });
const config = (reviewer = {}) => {
  const base = buildConfig('/w/app', 'app');
  return { ...base, reviewer: { ...base.reviewer, ...reviewer } };
};

test('documentation-only changes need no Codex review round', () => {
  const change = classifyChange([file('README.md'), file('docs/guide.md', 40, 10), file('notes/changes.txt')], config());
  assert.equal(change.kind, 'docs-only');
  assert.equal(reviewBudget(change, config()).rounds, 0);
});

test('agent instructions, security docs and lockfiles are never documentation-only', () => {
  for (const [changed, reason] of [
    ['CLAUDE.md', 'agent instructions'],
    ['AGENTS.md', 'agent instructions'],
    ['.claude/rules/dev-autopilot.md', 'agent instructions'],
    ['SECURITY.md', 'repository security config'],
    ['requirements.txt', 'dependencies/lockfile'],
  ]) {
    const change = classifyChange([file('README.md'), file(changed)], config());
    assert.equal(change.kind, 'high-risk', changed);
    assert.ok(change.reasons.some((item) => item.includes(reason)), `${changed}: ${change.reasons.join('; ')}`);
  }
});

test('a small low-risk change gets one round, a larger one two', () => {
  const small = classifyChange([file('src/format.js', 12, 3), file('test/format.test.js', 20)], config());
  assert.equal(small.kind, 'small');
  assert.equal(reviewBudget(small, config()).rounds, 1);
  const normal = classifyChange([file('src/a.js', 60), file('src/b.js', 30)], config());
  assert.equal(normal.kind, 'normal', 'more than 80 changed lines');
  assert.equal(reviewBudget(normal, config()).rounds, 2);
  assert.equal(classifyChange([file('a.js', 1), file('b.js', 1), file('c.js', 1), file('d.js', 1)], config()).kind, 'normal', 'more than 3 files');
  assert.equal(classifyChange([{ ...file('assets/logo.png'), binary: true }], config()).kind, 'normal', 'binary files are never small');
});

test('high-risk paths and changed-line keywords get reviewer.maxRounds, whatever their size', () => {
  const cases = [
    ['src/auth/session.ts', 'security/auth'],
    ['src/payments/refund.js', 'payments/billing'],
    ['db/migrations/0042_add_index.sql', 'database migration'],
    ['config/.env.production', 'secrets/credentials'],
    ['deploy/production.yml', 'release/deployment'],
    ['package-lock.json', 'dependencies/lockfile'],
    ['.github/workflows/ci.yml', 'CI/workflow'],
    ['ios/App/Info.plist', 'native/build configuration'],
    ['tsconfig.json', 'native/build configuration'],
  ];
  for (const [changed, reason] of cases) {
    const change = classifyChange([file(changed, 1)], config({ maxRounds: 3 }));
    assert.equal(change.kind, 'high-risk', changed);
    assert.ok(change.reasons.join(' ').includes(reason), `${changed}: ${change.reasons.join('; ')}`);
    assert.equal(reviewBudget(change, config({ maxRounds: 3 })).rounds, 3, 'the configured maximum');
  }
  const keyword = classifyChange([file('src/util.js', 2, 0, ['const token = jwt.sign(payload, secret);'])], config());
  assert.equal(keyword.kind, 'high-risk');
  assert.match(keyword.reasons[0], /src\/util\.js: changed lines mention "secret", "jwt"|"jwt", "secret"/);
  const docsKeyword = classifyChange([file('docs/security-notes.md', 2, 0, ['Rotate the password yearly.'])], config());
  assert.notEqual(docsKeyword.reasons.join(' ').includes('changed lines mention'), true, 'keywords are only scanned in non-documentation files');
});

test('renamed files are judged by both their old and new paths', () => {
  const change = classifyChange([{ ...file('docs/notes.md', 0, 0), oldPath: 'src/auth/notes.js' }], config());
  assert.equal(change.kind, 'high-risk');
});

test('every threshold is configurable, and project high-risk paths and keywords add to the defaults', () => {
  const custom = config({ maxRounds: 4, adaptive: { smallMaxFiles: 1, smallMaxLines: 10, normalRounds: 3, highRiskPaths: ['src/billing-core/**', 'legacy/'], highRiskKeywords: ['LEGACY_FLAG'] } });
  assert.equal(classifyChange([file('src/a.js', 5), file('src/b.js', 5)], custom).kind, 'normal');
  assert.equal(reviewBudget(classifyChange([file('src/a.js', 50)], custom), custom).rounds, 3);
  const pathRisk = classifyChange([file('src/billing-core/x/y.ts', 1)], custom);
  assert.ok(pathRisk.reasons.some((item) => item.includes('reviewer.adaptive.highRiskPaths "src/billing-core/**"')));
  assert.equal(classifyChange([file('app/legacy/old.js', 1)], custom).kind, 'high-risk', 'a folder pattern matches anywhere');
  assert.equal(classifyChange([file('src/flags.js', 1, 0, ['if (LEGACY_FLAG) return;'])], custom).kind, 'high-risk');
  assert.equal(reviewBudget(pathRisk, custom).rounds, 4);
  const noDefaults = config({ adaptive: { useDefaultHighRisk: false } });
  assert.equal(classifyChange([file('src/auth/x.js', 1)], noDefaults).kind, 'small');
});

test('reviewer.maxRounds stays the strict cap, and adaptive review can be switched off', () => {
  assert.equal(roundsFor('normal', config({ maxRounds: 1 })).rounds, 1);
  assert.equal(roundsFor('high-risk', config({ maxRounds: 2, adaptive: { highRiskRounds: 5 } })).rounds, 2);
  assert.deepEqual(roundsFor('docs-only', config({ maxRounds: 3, adaptive: false })), { rounds: 3, maxRounds: 3, adaptive: false });
  assert.equal(roundsFor('docs-only', config({ maxRounds: 3, adaptive: { enabled: false } })).rounds, 3);
  assert.equal(roundsFor('empty', config()).rounds, 0);
});

test('a budget never shrinks within a task', () => {
  const earlier = { kind: 'high-risk', rounds: 2 };
  const now = reviewBudget(classifyChange([file('src/a.js', 1)], config()), config(), earlier);
  assert.equal(now.kind, 'small');
  assert.equal(now.rounds, 2);
  assert.equal(now.keptFrom, 'high-risk');
});

test('v0.4 configs need no change: missing adaptive settings take the defaults', async () => {
  const legacy = await v031Config();
  assert.deepEqual(configProblems(legacy), []);
  const docs = classifyChange([file('README.md')], legacy);
  assert.equal(reviewBudget(docs, legacy).rounds, 0);
  assert.equal(reviewBudget(classifyChange([file('src/auth/x.js')], legacy), legacy).rounds, 3, 'high risk keeps the v0.4 maximum of 3');
});

test('invalid adaptive settings are reported, and code changes can never be set to zero rounds', () => {
  const problems = adaptiveProblems(config({ adaptive: { smallRounds: 0, normalRounds: 'two', highRiskRounds: 0, docsOnlyRounds: -1, highRiskPaths: 'src/**', enabled: 'yes' } }));
  assert.equal(problems.length, 6);
  assert.ok(problems.some((item) => /reviewer\.adaptive\.smallRounds must be a whole number of at least 1/.test(item)));
  assert.deepEqual(adaptiveProblems(config({ adaptive: false })), []);
  assert.match(configProblems(config({ adaptive: { smallRounds: 0 } }))[0], /smallRounds/);
});

test('globToRegExp follows gitignore-style matching', () => {
  assert.ok(globToRegExp('*.sql').test('db/x/001.sql'));
  assert.ok(globToRegExp('src/**/secrets/*').test('src/a/b/secrets/key.txt'));
  assert.equal(globToRegExp('src/*.js').test('src/a/b.js'), false);
  assert.ok(globToRegExp('/infra/').test('infra/main.tf'));
  assert.equal(globToRegExp('/infra/').test('app/infra/main.tf'), false);
  assert.ok(globToRegExp('Payments').test('src/payments/index.ts'), 'case-insensitive');
  assert.deepEqual(highRiskReasons('src\\auth\\x.ts', { useDefaultHighRisk: true, highRiskPaths: [] }), ['security/auth'], 'Windows separators');
});

// ---------------------------------------------------------------- the real git diff

async function repo(t) {
  const root = await tempRoot(t);
  await gitIn(root, ['init', '-q', '-b', 'main']);
  await fs.writeFile(path.join(root, 'README.md'), '# App\n', 'utf8');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.js'), 'export const a = 1;\n', 'utf8');
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored/\n', 'utf8');
  await gitIn(root, ['add', '-A']);
  await gitIn(root, ['commit', '-q', '-m', 'init']);
  await gitIn(root, ['switch', '-q', '-c', 'task']);
  return root;
}

test('collectDiff covers commits, uncommitted edits, renames and untracked files, but not ignored ones', async (t) => {
  const root = await repo(t);
  await fs.writeFile(path.join(root, 'README.md'), '# App\n\nMore.\n', 'utf8');
  await gitIn(root, ['commit', '-q', '-am', 'docs']);
  await gitIn(root, ['mv', 'src/a.js', 'src/renamed.js']);
  await fs.writeFile(path.join(root, 'src', 'new.js'), 'export const password = process.env.PASSWORD;\n', 'utf8');
  await fs.mkdir(path.join(root, 'ignored'), { recursive: true });
  await fs.writeFile(path.join(root, 'ignored', 'x.js'), 'x', 'utf8');
  const diff = await collectDiff(root, 'main');
  assert.equal(diff.base, 'main');
  const paths = diff.files.map((item) => item.path).sort();
  assert.deepEqual(paths, ['README.md', 'src/new.js', 'src/renamed.js']);
  assert.equal(diff.files.find((item) => item.path === 'src/renamed.js').oldPath, 'src/a.js');
  const change = classifyChange(diff.files, config());
  assert.equal(change.kind, 'high-risk');
  assert.match(change.reasons.join(' '), /src\/new\.js: changed lines mention "password"/);
});

test('collectDiff of a docs-only branch is docs-only, and a missing base branch is a clear error', async (t) => {
  const root = await repo(t);
  await fs.writeFile(path.join(root, 'README.md'), '# App\n\nUsage.\n', 'utf8');
  const change = classifyChange((await collectDiff(root, 'main')).files, config());
  assert.equal(change.kind, 'docs-only');
  await assert.rejects(collectDiff(root, 'develop'), /Base branch "develop" was not found \(tried develop and origin\/develop\)/);
  assert.equal(classifyChange((await collectDiff(root, 'task')).files.filter(() => false), config()).kind, 'empty');
});
