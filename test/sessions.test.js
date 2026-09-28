import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySession, findSession, isBackground, isCurrentTask, isOwned, matchesRecord, planCleanup, sessionName } from '../src/sessions.js';

const bg = (id, state, name = `autopilot-demo-${id.slice(0, 6)}`) => ({
  id,
  sessionId: `${id}-1111-4222-8333-444455556666`,
  kind: 'background',
  cwd: '/work/demo',
  name,
  state,
});
const interactive = { sessionId: '00000000-aaaa-4bbb-8ccc-000000000002', kind: 'interactive', cwd: '/work/demo', name: 'chat', status: 'busy' };

test('findSession accepts the short id', () => {
  const sessions = [bg('7c5dcf5d', 'blocked'), bg('abcdef12', 'done')];
  assert.equal(findSession(sessions, '7c5dcf5d').session.id, '7c5dcf5d');
});

test('findSession accepts the full sessionId and maps it to the short id', () => {
  const sessions = [bg('7c5dcf5d', 'blocked'), bg('abcdef12', 'done')];
  assert.equal(findSession(sessions, '7c5dcf5d-1111-4222-8333-444455556666').session.id, '7c5dcf5d');
  assert.equal(findSession(sessions, '  7C5DCF5D-1111-4222-8333-444455556666 ').session.id, '7c5dcf5d');
});

test('findSession accepts an exact session name', () => {
  assert.equal(findSession([bg('7c5dcf5d', 'working', 'autopilot-demo-9e18f9')], 'autopilot-demo-9e18f9').session.id, '7c5dcf5d');
});

test('findSession explains which identifier to use when nothing matches', () => {
  const { error } = findSession([bg('7c5dcf5d', 'done')], '0badc0de-1234-4abc-8def-000000000001');
  assert.match(error, /No Claude background session matches "0badc0de-1234-4abc-8def-000000000001"/);
  assert.match(error, /"id" value from dev-autopilot status/);
});

test('findSession rejects interactive sessions with an actionable message', () => {
  const { error } = findSession([interactive], interactive.sessionId);
  assert.match(error, /interactive Claude Code session, not a background session/);
});

test('findSession refuses an ambiguous name instead of guessing', () => {
  const { error } = findSession([bg('11111111', 'done', 'same'), bg('22222222', 'done', 'same')], 'same');
  assert.match(error, /matches more than one Claude session \(11111111, 22222222\)/);
});

test('matchesRecord never matches on missing values', () => {
  assert.equal(matchesRecord(interactive, { id: null }), false);
  assert.equal(matchesRecord(bg('7c5dcf5d', 'done'), null), false);
  assert.equal(matchesRecord(bg('7c5dcf5d', 'done'), { id: '7c5dcf5d' }), true);
  assert.equal(isBackground(interactive), false);
});

test('classifySession labels active, current and stale sessions', () => {
  const record = { id: 'cccccccc', taskHash: 'task-2' };
  const context = { prefix: 'autopilot-demo', record, taskHash: 'task-2' };
  assert.deepEqual(classifySession(bg('aaaaaaaa', 'working'), context), { owned: true, current: false, lifecycle: 'active', useId: 'aaaaaaaa' });
  assert.equal(classifySession(bg('cccccccc', 'done'), context).lifecycle, 'current');
  assert.equal(classifySession(bg('dddddddd', 'done'), context).lifecycle, 'stale');
  // Once the task file changes, the old record's session is no longer current.
  assert.equal(classifySession(bg('cccccccc', 'done'), { ...context, taskHash: 'task-3' }).lifecycle, 'stale');
  assert.equal(classifySession(bg('eeeeeeee', 'done', 'my own session'), context).owned, false);
});

test('ownership needs the exact generated name shape or the saved record', () => {
  const context = { prefix: 'autopilot-demo', record: { id: 'cccccccc' }, taskHash: 'abc123def' };
  assert.equal(sessionName('autopilot-demo', '9e18f9f543b8'), 'autopilot-demo-9e18f9');
  assert.equal(isOwned(bg('aaaaaaaa', 'done', 'autopilot-demo-9e18f9'), context), true);
  assert.equal(isOwned(bg('aaaaaaaa', 'done', 'autopilot-demo-investigation'), context), false);
  assert.equal(isOwned(bg('aaaaaaaa', 'done', 'autopilot-demo-9e18f9-copy'), context), false);
  assert.equal(isOwned(bg('aaaaaaaa', 'done', 'autopilot-demox-9e18f9'), context), false);
  assert.equal(isOwned(bg('cccccccc', 'done', 'renamed by the user'), context), true, 'the recorded session stays owned');
  assert.equal(isOwned(bg('aaaaaaaa', 'done', 'x-9e18f9'), { prefix: 'x.y', record: null }), false, 'the prefix is matched literally');
});

test('generated names always keep six hash digits, even with an over-long prefix', () => {
  const long = `autopilot-${'x'.repeat(70)}`;
  const name = sessionName(long, '9e18f9f543b8');
  assert.equal(name.length, 64);
  assert.match(name, /-9e18f9$/);
  assert.notEqual(sessionName(long, '111111aaaa'), name, 'different tasks get different names');
  assert.equal(isOwned(bg('aaaaaaaa', 'done', name), { prefix: long, record: null }), true);
  assert.equal(isOwned(bg('aaaaaaaa', 'done', 'autopilot-demo-abc'), { prefix: 'autopilot-demo', record: null }), false, 'fewer than six digits is not generated');
});

test('the current task is recognised by its generated name when the runtime record is gone', () => {
  const context = { prefix: 'autopilot-demo', record: null, taskHash: '9e18f9f543b8' };
  assert.equal(classifySession(bg('aaaaaaaa', 'done', 'autopilot-demo-9e18f9'), context).lifecycle, 'current');
  assert.equal(classifySession(bg('bbbbbbbb', 'done', 'autopilot-demo-111111'), context).lifecycle, 'stale');
  assert.equal(isCurrentTask(bg('aaaaaaaa', 'stopped', 'autopilot-demo-9e18f9'), { ...context, taskHash: null }), false);
});

test('planCleanup removes nothing when the task file is missing', () => {
  const sessions = [bg('aaaaaaaa', 'done'), bg('bbbbbbbb', 'failed')];
  const { remove, keep } = planCleanup(sessions, { prefix: 'autopilot-demo', record: null, taskHash: null });
  assert.deepEqual(remove, []);
  assert.deepEqual(keep.map(({ reason }) => reason), ['task file not found, so the current task is unknown', 'task file not found, so the current task is unknown']);
});

test('planCleanup keeps a finished session whose name only starts with the prefix', () => {
  const { remove, keep } = planCleanup([bg('aaaaaaaa', 'done', 'autopilot-demo-investigation')], { prefix: 'autopilot-demo', record: null, taskHash: 'fff' });
  assert.deepEqual(remove, []);
  assert.equal(keep[0].reason, 'not started by Autopilot');
});

test('planCleanup only removes finished Autopilot sessions of earlier tasks', () => {
  const record = { id: 'cccccccc', taskHash: 'task-2' };
  const sessions = [
    bg('aaaaaaaa', 'working'),
    bg('bbbbbbbb', 'blocked'),
    bg('cccccccc', 'done'),
    bg('dddddddd', 'done'),
    bg('ffffffff', 'failed'),
    bg('99999999', 'stopped'),
    bg('eeeeeeee', 'done', 'someone else'),
    bg('12121212', 'mystery'),
    interactive,
  ];
  const { remove, keep } = planCleanup(sessions, { prefix: 'autopilot-demo', record, taskHash: 'task-2' });
  assert.deepEqual(remove.map(({ session }) => session.id), ['dddddddd', 'ffffffff', '99999999']);
  assert.deepEqual(
    Object.fromEntries(keep.map(({ session, reason }) => [session.id, reason])),
    {
      aaaaaaaa: 'still working',
      bbbbbbbb: 'still blocked',
      cccccccc: 'belongs to the current task',
      eeeeeeee: 'not started by Autopilot',
      12121212: 'unknown state "mystery"',
    },
  );
});
