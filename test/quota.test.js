import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { assessFailure, classifyFailure, parseResetTime, quotaOptions, quotaProblems, resumeAtFor, zonedTimeToUtc } from '../src/quota.js';

const NOW = new Date('2026-09-29T12:00:00Z');
const iso = (result) => result.resetAt?.toISOString() ?? null;

test('the real Codex out-of-credits output is quota exhaustion without a reset time', async () => {
  const output = await fs.readFile(new URL('./fixtures/quota/codex-0.157.1-out-of-credits.txt', import.meta.url), 'utf8');
  const verdict = assessFailure(output, { now: NOW });
  assert.equal(verdict.kind, 'quota');
  assert.match(verdict.evidence, /out of credits/);
  assert.equal(verdict.resetAt, null);
  assert.equal(verdict.reason, 'the output states no reset time');
});

test('quota exhaustion is told apart from auth, network, throttling, refusals and bad commands', () => {
  const cases = [
    ["You've hit your usage limit. Upgrade to Pro or try again later.", 'quota'],
    ['Claude usage limit reached. Your limit will reset at 3pm (Europe/London).', 'quota'],
    ['Error: insufficient_quota: You exceeded your current quota', 'quota'],
    ['stream error: 429 Too Many Requests; usage limit reached', 'quota'],
    ['Error: Not logged in. Please run codex login.', 'auth'],
    ['401 Unauthorized: invalid api key', 'auth'],
    ['rate limit exceeded, retry after 20 seconds', 'rate-limit'],
    ['API Error: 529 Overloaded', 'rate-limit'],
    ['getaddrinfo ENOTFOUND api.openai.com', 'network'],
    ['stream disconnected before completion', 'network'],
    ['The request was refused under the content policy.', 'refusal'],
    ["error: unexpected argument '--frobnicate' found", 'usage-error'],
    ['Segmentation fault', 'other'],
  ];
  for (const [text, kind] of cases) assert.equal(classifyFailure(text).kind, kind, text);
  assert.equal(assessFailure('rate limit exceeded, retry after 20 seconds', { now: NOW }).resetAt, null, 'a throttle is not a quota reset');
});

test('an absolute reset time is read from ISO timestamps with a zone and from epochs', () => {
  assert.equal(iso(parseResetTime('Usage limit reached. Resets at 2026-09-30T02:00:00Z.', { now: NOW })), '2026-09-30T02:00:00.000Z');
  assert.equal(iso(parseResetTime('quota exceeded, reset at 2026-09-30T04:30:00+02:00', { now: NOW })), '2026-09-30T02:30:00.000Z');
  assert.equal(iso(parseResetTime('Claude AI usage limit reached|1790700000', { now: NOW })), '2026-09-29T16:40:00.000Z');
  assert.equal(iso(parseResetTime('{"error":"usage_limit_reached","resets_at": 1790700000123}', { now: NOW })), '2026-09-29T16:40:00.123Z');
});

test('a clock time is read only with an explicit time zone, across daylight-saving offsets', () => {
  assert.equal(iso(parseResetTime('5-hour limit reached ∙ resets 3pm (Europe/London)', { now: NOW })), '2026-09-29T14:00:00.000Z', 'BST');
  assert.equal(iso(parseResetTime('Weekly limit reached ∙ resets Oct 6, 5pm (America/New_York)', { now: NOW })), '2026-10-06T21:00:00.000Z', 'EDT');
  assert.equal(iso(parseResetTime('Weekly limit reached ∙ resets Nov 3, 9am (Europe/London)', { now: new Date('2026-10-30T12:00:00Z') })), '2026-11-03T09:00:00.000Z', 'GMT after the change');
  assert.equal(iso(parseResetTime('usage limit reached; resets at 17:30 UTC', { now: NOW })), '2026-09-29T17:30:00.000Z');
  assert.equal(iso(parseResetTime('usage limit reached; resets at 9am (Asia/Tokyo)', { now: NOW })), '2026-09-30T00:00:00.000Z', 'the next 9am in Tokyo');
  assert.equal(zonedTimeToUtc({ year: 2026, month: 3, day: 29, hour: 12, minute: 0 }, 'Europe/London').toISOString(), '2026-03-29T11:00:00.000Z');
});

test('a clock time that has passed moves to the same wall time tomorrow, across a DST change', () => {
  // 23:00 EDT on 31 October 2026; New York falls back to EST at 02:00 on 1 November.
  const now = new Date('2026-11-01T03:00:00Z');
  assert.equal(iso(parseResetTime('usage limit reached, resets 5pm (America/New_York)', { now })), '2026-11-01T22:00:00.000Z', '5 PM EST, not 4 PM');
  assert.equal(iso(parseResetTime('usage limit reached, resets at 09:00 UTC', { now: NOW })), '2026-09-30T09:00:00.000Z');
  assert.equal(iso(parseResetTime('usage limit reached, resets at 09:00 +02:00', { now: NOW })), '2026-09-30T07:00:00.000Z');
});

test('the evidence line is redacted before it can be printed or stored', () => {
  const token = `gh${'p'}_${'Q7r'.repeat(12)}`;
  const verdict = assessFailure(`Error: usage limit reached for token ${token}; try again in 2 hours`, { now: NOW });
  assert.equal(verdict.kind, 'quota');
  assert.equal(verdict.evidence.includes(token), false);
  assert.match(verdict.evidence, /\[REDACTED GitHub token\]/);
  assert.equal(classifyFailure(`fatal: ${token}`).evidence.includes(token), false);
});

test('a relative reset time is added to the moment the output was observed', () => {
  assert.equal(iso(parseResetTime("You've hit your usage limit. Try again in 4 days 21 hours 35 minutes.", { now: NOW })), '2026-10-04T09:35:00.000Z');
  assert.equal(iso(parseResetTime('usage limit reached, resets in 2h 15m', { now: NOW })), '2026-09-29T14:15:00.000Z');
  assert.equal(iso(parseResetTime('quota exhausted; available again in 45 minutes', { now: NOW })), '2026-09-29T12:45:00.000Z');
});

test('ambiguous or missing reset times are rejected instead of guessed', () => {
  const ambiguous = [
    ["You've hit your usage limit. Try again at 3:42 PM.", /"3:42 PM" has no time zone/],
    ['usage limit reached; try again at 2026-09-30 02:00', /"2026-09-30 02:00" has no time zone/],
    ['5-hour limit resets in 5 hours; weekly limit resets in 3 days', /2 different times/],
    ['usage limit reached, resets 3pm (Mars/Olympus_Mons)', /unknown time zone/],
  ];
  for (const [text, reason] of ambiguous) {
    const result = parseResetTime(text, { now: NOW });
    assert.equal(result.resetAt, null, text);
    assert.match(result.reason, reason);
  }
  assert.equal(parseResetTime('Your plan is Plus. Usage limit reached.', { now: NOW }).reason, 'the output states no reset time', 'no reset is inferred from a plan type');
  assert.match(parseResetTime('usage limit reached; resets in 30 days', { now: NOW }).reason, /more than 8 days away/);
  assert.equal(parseResetTime('2026-09-29T11:00:00Z usage limit reached', { now: NOW }).resetAt, null, 'a log timestamp is not a reset time');
});

test('a stated reset time in the past is reported as such', () => {
  const result = parseResetTime('usage limit reached, resets at 2026-09-29T11:00:00Z', { now: NOW });
  assert.equal(result.inPast, true);
});

test('resumeAt is the reset time plus the grace period, two minutes by default', () => {
  const reset = new Date('2026-09-29T14:00:00Z');
  assert.equal(resumeAtFor(reset).toISOString(), '2026-09-29T14:02:00.000Z');
  assert.equal(resumeAtFor(reset, 10).toISOString(), '2026-09-29T14:10:00.000Z');
  assert.deepEqual(quotaOptions({}), { autoResume: false, graceMinutes: 2 });
  assert.deepEqual(quotaOptions({ quota: { autoResume: true } }), { autoResume: true, graceMinutes: 2 });
});

test('quota settings are validated', () => {
  assert.deepEqual(quotaProblems({}), []);
  assert.deepEqual(quotaProblems({ quota: { autoResume: true, graceMinutes: 5 } }), []);
  assert.equal(quotaProblems({ quota: { autoResume: 'yes', graceMinutes: -1 } }).length, 2);
  assert.match(quotaProblems({ quota: [] })[0], /quota must be an object/);
});
