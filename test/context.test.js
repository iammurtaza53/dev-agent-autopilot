import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  collectContext,
  diffManifests,
  ensureCapsule,
  isSecretFileName,
  normalizeRel,
  parseSections,
  renderDelta,
  taskSignals,
} from '../src/context.js';
import { buildConfig } from '../src/cli.js';
import { sha256 } from '../src/lib.js';
import { gitIn, tempRoot } from './helpers.js';

const FIXTURE = new URL('../bench/fixtures/acme-orders/', import.meta.url);

async function write(root, rel, text) {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), text, 'utf8');
}

// A project with the benchmark's context documents and the given task.
async function contextProject(t, task, extra = {}) {
  const root = await tempRoot(t);
  for (const file of ['CLAUDE.md', 'AGENTS.md', 'PROJECT_STATE.md', 'DECISIONS.md', 'ARCHITECTURE.md']) {
    await write(root, file, await fs.readFile(new URL(file, FIXTURE), 'utf8'));
  }
  await write(root, 'NEXT_TASK.md', task);
  for (const [file, text] of Object.entries(extra)) await write(root, file, text);
  const config = buildConfig(root, 'acme');
  config.checks = ['npm test'];
  await write(root, '.autopilot/config.json', JSON.stringify(config));
  return { root, config };
}

const TASK = `# Task: release expired inventory reservations automatically

Phase 5 item 1, decision D12. Add a job in \`src/jobs/reservation-expiry.ts\` that calls \`release(orderId, 'expired')\`
for held reservations past \`expires_at\`. Register it in \`src/jobs/index.ts\`.
`;

// ---------------------------------------------------------------- sections and signals

test('parseSections splits Markdown at headings with line ranges, ignoring headings in code fences', () => {
  const text = ['intro', '# Title', 'body', '```md', '# not a heading', '```', '## Child', 'child body', '', 'Setext', '------', 'setext body'].join('\n');
  const sections = parseSections(text);
  assert.deepEqual(sections.map((section) => [section.key, section.start, section.end]), [
    ['(preamble)', 1, 1],
    ['Title', 2, 6],
    ['Title > Child', 7, 9],
    ['Title > Setext', 10, 12],
  ]);
  assert.equal(sections[1].blockEnd, 12, 'a parent block covers its subsections');
  assert.equal(sections[1].hash, sha256(sections[1].text));
});

test('parseSections splits non-Markdown files into line windows and skips front matter headings', () => {
  const windows = parseSections(Array.from({ length: 90 }, (_, i) => `line ${i + 1}`).join('\n'), false);
  assert.deepEqual(windows.map((section) => section.key), ['lines 1-40', 'lines 41-80', 'lines 81-90']);
  const withFrontMatter = parseSections('---\ntitle: x\n---\n# Real');
  assert.deepEqual(withFrontMatter.map((section) => section.key), ['(preamble)', 'Real']);
});

test('taskSignals finds paths, identifiers, called names and numbered references, not prose like and/or', () => {
  const signals = taskSignals(TASK, { exclude: ['ARCHITECTURE.md'] });
  assert.deepEqual(signals.paths, ['src/jobs/index.ts', 'src/jobs/reservation-expiry.ts']);
  assert.ok(signals.basenames.includes('reservation-expiry.ts'));
  assert.equal(signals.basenames.includes('index.ts'), false, 'generic file names are not signals');
  assert.ok(signals.identifiers.includes('expires_at'));
  assert.ok(signals.identifiers.includes('orderId'));
  assert.ok(signals.calls.includes('release'));
  assert.ok(signals.references.includes('phase 5'));
  assert.ok(signals.references.includes('D12'));
  assert.deepEqual(taskSignals('Read and/or write the input/output.').paths, []);
  assert.deepEqual(taskSignals('See `ARCHITECTURE.md` for details.', { exclude: ['ARCHITECTURE.md'] }).basenames, [], 'naming a context file is not a signal');
});

test('paths are normalised to forward slashes and never escape the repository', () => {
  assert.equal(normalizeRel('docs\\ARCHITECTURE.md'), 'docs/ARCHITECTURE.md');
  assert.equal(normalizeRel('./CLAUDE.md'), 'CLAUDE.md');
  assert.equal(normalizeRel('../outside.md'), null);
  assert.equal(normalizeRel('C:\\Users\\me\\notes.md'), null);
  assert.equal(normalizeRel('/etc/passwd'), null);
  assert.equal(isSecretFileName('.env.production'), true);
  assert.equal(isSecretFileName('config/secrets.json'), true);
  assert.equal(isSecretFileName('keys/deploy.pem'), true);
  assert.equal(isSecretFileName('docs/secrets-policy.md'), false, 'a document about secrets is still read (its content is scanned)');
});

// ---------------------------------------------------------------- capsule selection and provenance

test('the capsule holds the task verbatim, mandatory context and the relevant sections, with provenance', async (t) => {
  const { root, config } = await contextProject(t, TASK);
  const capsule = await ensureCapsule(root, config, { version: 'test' });
  const text = await fs.readFile(capsule.markdown, 'utf8');
  assert.ok(text.includes(TASK.trim()), 'task verbatim');
  assert.match(text, new RegExp(`Task: NEXT_TASK\\.md \\(sha256:${sha256(TASK).slice(0, 12)}, lines 1-4, verbatim\\)`));
  // Mandatory: the instruction file and a safety heading, whatever the task says.
  assert.ok(text.includes((await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8')).trim()));
  assert.match(text, /### DECISIONS\.md › Decision log › Security \(sha256:[0-9a-f]{12}, lines \d+-\d+; safety heading\)/);
  // Relevant sections, exact text, with source hash and line range.
  const architecture = await fs.readFile(path.join(root, 'ARCHITECTURE.md'), 'utf8');
  assert.match(text, new RegExp(`ARCHITECTURE\\.md › Acme Orders: architecture › Jobs runner \\(sha256:${sha256(architecture).slice(0, 12)}, lines \\d+-\\d+; matched: `));
  assert.ok(text.includes('`src/jobs/runner.ts` is a small scheduler'));
  assert.ok(text.includes('## D12: automatic release of expired reservations'));
  // Unrelated sections are indexed, not copied.
  assert.equal(text.includes('## D6: Fastify over Express\n\nContext'), false);
  assert.match(text, /L\d+-\d+ D6: Fastify over Express/);
  // CLAUDE.md is project memory: referenced by hash, not repeated.
  assert.match(text, /## Already in your context[\s\S]*`CLAUDE\.md` \(sha256:/);
  assert.equal(text.includes('Money is integer minor units; format only with `formatMoney()`.'), false);
  assert.ok(capsule.manifest.capsuleBytes < capsule.manifest.rawBytes / 2, `capsule ${capsule.manifest.capsuleBytes} vs raw ${capsule.manifest.rawBytes}`);
  assert.equal(capsule.manifest.sources['ARCHITECTURE.md'].hash, sha256(architecture));
});

test('mandatory context survives a task that matches nothing, including configured alwaysInclude entries and markers', async (t) => {
  const marked = '# Notes\n\nIntro.\n\n<!-- autopilot:always -->\nNever run the migration script by hand.\n<!-- /autopilot:always -->\n\n## Misc\n\nOther text.\n';
  const { root, config } = await contextProject(t, '# Task\n\nRename a variable.\n', { 'NOTES.md': marked });
  config.project.contextFiles.push('NOTES.md');
  config.leanloop = { enabled: true, context: { alwaysInclude: ['PROJECT_STATE.md#Environments'] } };
  const capsule = await ensureCapsule(root, config, { version: 'test' });
  const text = await fs.readFile(capsule.markdown, 'utf8');
  assert.ok(text.includes('Staging data is reset weekly. Never copy production data to staging.'), 'alwaysInclude section');
  assert.match(text, /PROJECT_STATE\.md › Project state › Environments .*leanloop\.context\.alwaysInclude/);
  assert.ok(text.includes('Never run the migration script by hand.'), 'autopilot:always block');
  assert.ok(text.includes('Webhooks must verify the provider signature before any processing.'), 'safety heading');
  assert.ok(text.includes('Never merge pull requests or deploy; a human does that.'), 'instruction file');
  assert.match(text, /Human gates \(`safety\.humanGates`, verbatim\):\n  - Pull-request merge\./);
});

test('credential-like content and secret-named files are never excerpted, and ignored files are not processed', async (t) => {
  const token = `gh${'p'}_${'a1B2'.repeat(9)}`;
  const { root, config } = await contextProject(t, TASK, {
    'OPS.md': `# Ops\n\n## Access\n\nUse ${token} for the deploy bot.\n\n## Safety rules\n\nNever deploy on Fridays.\n`,
    '.env.local': 'SECRET=1\n',
    'LOCAL_NOTES.md': '# Local\n\nPrivate notes.\n',
    '.gitignore': 'LOCAL_NOTES.md\n',
  });
  await gitIn(root, ['init', '-q']);
  config.project.contextFiles.push('OPS.md', '.env.local', 'LOCAL_NOTES.md', '../outside.md');
  const capsule = await ensureCapsule(root, config, { version: 'test' });
  const text = await fs.readFile(capsule.markdown, 'utf8');
  const cache = await fs.readFile(path.join(root, '.autopilot', 'runtime', 'context', 'index.json'), 'utf8');
  for (const stored of [text, cache, JSON.stringify(capsule.manifest)]) assert.equal(stored.includes(token), false);
  assert.ok(text.includes('Never deploy on Fridays.'), 'the rest of the file is still used');
  assert.match(text, /`OPS\.md` lines \d+-\d+ \(Access\): withheld because it contains a credential-like value \(GitHub token\)/);
  assert.match(text, /`\.env\.local`: withheld: the file name suggests credentials/);
  assert.match(text, /`LOCAL_NOTES\.md`: git-ignored local file/);
  assert.equal(text.includes('Private notes.'), false);
  assert.match(text, /`\.\.\/outside\.md`: outside the repository/);
});

test('project memory imported from CLAUDE.md with @path is referenced, not repeated', async (t) => {
  const { root, config } = await contextProject(t, TASK, { 'CLAUDE.md': '# Acme\n\nSee @AGENTS.md for the rules.\n\n```\n@not-an-import.md\n```\n' });
  const collected = await collectContext(root, config);
  const roles = Object.fromEntries(collected.entries.map((entry) => [entry.path, entry.role]));
  assert.equal(roles['AGENTS.md'], 'memory');
  assert.equal(roles['not-an-import.md'], undefined);
  const text = await fs.readFile((await ensureCapsule(root, config, { version: 'test' })).markdown, 'utf8');
  assert.match(text, /Already in your context[\s\S]*`AGENTS\.md`/);
  assert.equal(text.includes('## Safety rules\n\n- Never run migrations'), false, 'the imported file is not duplicated');
});

// ---------------------------------------------------------------- cache and invalidation

test('an unchanged capsule is reused, and any source change invalidates it', async (t) => {
  const { root, config } = await contextProject(t, TASK);
  const first = await ensureCapsule(root, config, { version: 'test' });
  const again = await ensureCapsule(root, config, { version: 'test' });
  assert.equal(first.reused, false);
  assert.equal(again.reused, true);
  assert.equal(again.manifest.fingerprint, first.manifest.fingerprint);

  await fs.appendFile(path.join(root, 'DECISIONS.md'), '\n## D14: new decision\n\nText.\n');
  const changed = await ensureCapsule(root, config, { version: 'test' });
  assert.equal(changed.reused, false);
  assert.notEqual(changed.manifest.fingerprint, first.manifest.fingerprint);
  assert.notEqual(changed.manifest.sources['DECISIONS.md'].hash, first.manifest.sources['DECISIONS.md'].hash);

  const edited = await fs.readFile(changed.markdown, 'utf8');
  await fs.writeFile(changed.markdown, `${edited}\ntampered\n`);
  assert.equal((await ensureCapsule(root, config, { version: 'test' })).reused, false, 'a capsule whose own hash no longer matches is rebuilt');
  assert.equal((await ensureCapsule(root, config, { version: 'next' })).reused, false, 'a new Autopilot version rebuilds the capsule');
});

test('the section cache is keyed by content hash and never serves stale sections', async (t) => {
  const { root, config } = await contextProject(t, TASK);
  await ensureCapsule(root, config, { version: 'test' });
  const indexFile = path.join(root, '.autopilot', 'runtime', 'context', 'index.json');
  const before = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  assert.equal(before.files['ARCHITECTURE.md'].hash, sha256(await fs.readFile(path.join(root, 'ARCHITECTURE.md'), 'utf8')));
  assert.equal(JSON.stringify(before).includes('small scheduler'), false, 'the cache stores structure, not text');
  const architecture = await fs.readFile(path.join(root, 'ARCHITECTURE.md'), 'utf8');
  await fs.writeFile(path.join(root, 'ARCHITECTURE.md'), architecture.replace('## Jobs runner', '## Jobs runner\n\nThe runner now uses Postgres advisory locks.'));
  const text = await fs.readFile((await ensureCapsule(root, config, { version: 'test' })).markdown, 'utf8');
  assert.ok(text.includes('The runner now uses Postgres advisory locks.'));
  const after = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  assert.notEqual(after.files['ARCHITECTURE.md'].hash, before.files['ARCHITECTURE.md'].hash);
});

test('a changed task gets its own capsule instead of the previous one', async (t) => {
  const { root, config } = await contextProject(t, TASK);
  const first = await ensureCapsule(root, config, { version: 'test' });
  await write(root, 'NEXT_TASK.md', '# Task: consistent order numbers\n\nUse `formatOrderNumber()` in `src/api/routes/orders.ts`.\n');
  const second = await ensureCapsule(root, config, { version: 'test' });
  assert.notEqual(second.markdown, first.markdown);
  assert.equal(second.reused, false);
  const text = await fs.readFile(second.markdown, 'utf8');
  assert.ok(text.includes('`src/api/routes/orders.ts` exposes `POST /orders`'));
  assert.equal(text.includes('`src/jobs/runner.ts` is a small scheduler'), false);
});

// ---------------------------------------------------------------- delta

test('diffManifests and renderDelta report only what changed, with exact new text for relevant sections', async (t) => {
  const { root, config } = await contextProject(t, TASK);
  const before = await ensureCapsule(root, config, { version: 'test' });
  const architecture = await fs.readFile(path.join(root, 'ARCHITECTURE.md'), 'utf8');
  await fs.writeFile(path.join(root, 'ARCHITECTURE.md'), architecture
    .replace('- Existing jobs: `outbox-processor`, `payment-reconciliation`, `reporting-export`.', '- Existing jobs: `outbox-processor`, `payment-reconciliation`, `reporting-export`, `reservation-expiry`.')
    .replace('## Auth module', '## Auth module\n\nSessions now rotate every 24 hours.'));
  const after = await ensureCapsule(root, config, { version: 'test' });
  const changes = diffManifests(before.manifest, after.manifest);
  assert.deepEqual(changes.map((change) => change.path), ['ARCHITECTURE.md']);
  assert.deepEqual(changes[0].changed.sort(), ['Acme Orders: architecture > Auth module', 'Acme Orders: architecture > Jobs runner']);
  const delta = renderDelta(before.manifest, after, config);
  assert.ok(delta.markdown.includes('`reservation-expiry`.'), 'the relevant changed section is included verbatim');
  assert.match(delta.markdown, /- Changed: Auth module \(lines \d+-\d+\): not matched to this task\. Read it if you need it\./);
  assert.equal(delta.markdown.includes('Sessions now rotate every 24 hours.'), false);
  assert.equal(delta.markdown.includes('## D12'), false, 'unchanged sources are left out');
  assert.ok(delta.bytes < after.manifest.capsuleBytes);
});

test('every project rule under .claude/rules/ is part of the fingerprint, and a changed rule is in the delta', async (t) => {
  const { root, config } = await contextProject(t, TASK, {
    '.claude/rules/dev-autopilot.md': '# Dev Agent Autopilot\n\nWorkflow.\n',
    '.claude/rules/team/security.md': '# Security rules\n\nNever log tokens.\n',
  });
  const before = await ensureCapsule(root, config, { version: 'test' });
  assert.equal(before.manifest.sources['.claude/rules/team/security.md'].role, 'memory');
  assert.match(await fs.readFile(before.markdown, 'utf8'), /Already in your context[\s\S]*`\.claude\/rules\/team\/security\.md`/);
  await write(root, '.claude/rules/team/security.md', '# Security rules\n\nNever log tokens or card numbers.\n');
  const after = await ensureCapsule(root, config, { version: 'test' });
  assert.notEqual(after.manifest.fingerprint, before.manifest.fingerprint);
  const delta = renderDelta(before.manifest, after, config);
  assert.deepEqual(delta.changedPaths, ['.claude/rules/team/security.md']);
  assert.ok(delta.markdown.includes('Never log tokens or card numbers.'), 'project memory changes are always sent in full');
});

test('a changed instruction file is always sent in full in the delta', async (t) => {
  const { root, config } = await contextProject(t, TASK);
  const before = await ensureCapsule(root, config, { version: 'test' });
  await fs.appendFile(path.join(root, 'AGENTS.md'), '\n## Release rules\n\n- Never tag a release from an agent session.\n');
  const after = await ensureCapsule(root, config, { version: 'test' });
  const delta = renderDelta(before.manifest, after, config);
  assert.ok(delta.markdown.includes('Never tag a release from an agent session.'));
  assert.deepEqual(delta.changedPaths, ['AGENTS.md']);
});
