// Classifies a failed Claude or Codex command from its own output, and reads a usage-limit reset time only when
// the output states one explicitly. Nothing is inferred from plan types, and nothing is guessed.
import { stripAnsi } from './lib.js';

export const DEFAULT_QUOTA = Object.freeze({ autoResume: false, graceMinutes: 2 });
const MAX_HORIZON_MS = 8 * 24 * 60 * 60 * 1000;

export function quotaOptions(config) {
  const custom = config?.quota || {};
  return {
    autoResume: custom.autoResume === true,
    graceMinutes: custom.graceMinutes === undefined ? DEFAULT_QUOTA.graceMinutes : custom.graceMinutes,
  };
}

export function quotaProblems(config) {
  const quota = config?.quota;
  if (quota === undefined) return [];
  if (!quota || typeof quota !== 'object' || Array.isArray(quota)) return ['quota must be an object.'];
  const problems = [];
  if (quota.autoResume !== undefined && typeof quota.autoResume !== 'boolean') problems.push(`quota.autoResume must be true or false (found ${JSON.stringify(quota.autoResume)}).`);
  if (quota.graceMinutes !== undefined && !(Number.isInteger(quota.graceMinutes) && quota.graceMinutes >= 0 && quota.graceMinutes <= 120)) {
    problems.push(`quota.graceMinutes must be a whole number from 0 to 120 (found ${JSON.stringify(quota.graceMinutes)}).`);
  }
  return problems;
}

// Checked in this order, so a usage-limit message that also carries a 429 status counts as quota exhaustion.
const PATTERNS = [
  ['quota', [
    /\busage limit\b/i,
    /\bout of credits\b/i,
    /\binsufficient[_ ]quota\b/i,
    /\bquota (?:has been )?(?:exceeded|exhausted|reached)\b/i,
    /\bexceeded your (?:current )?quota\b/i,
    /\bcredit balance is too low\b/i,
    /\b(?:5-hour|five-hour|weekly|daily|monthly|session|opus|sonnet) limit reached\b/i,
    /\busage[_ ]limit[_ ]reached\b/i,
    /\byou(?:'|’)ve (?:hit|reached) your (?:usage )?limit\b/i,
    /\blimit will reset\b/i,
    /\bno (?:remaining )?credits\b/i,
  ]],
  ['auth', [
    /\bnot (?:logged|signed) in\b/i,
    /\bplease (?:log|sign) in\b/i,
    /\b(?:unauthori[sz]ed|401)\b/i,
    /\binvalid (?:api key|token|credentials|x-api-key)\b/i,
    /\bauthentication (?:failed|required|error)\b/i,
    /\blogin required\b/i,
    /\btoken (?:has )?expired\b/i,
    /\brun `?(?:codex|claude) (?:login|auth)/i,
  ]],
  ['rate-limit', [
    /\brate[ _-]?limit/i,
    /\btoo many requests\b/i,
    /\b429\b/,
    /\boverloaded\b/i,
    /\b529\b/,
    /\bthrottl/i,
    /\bslow down\b/i,
  ]],
  ['network', [
    /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b/,
    /\bnetwork (?:error|is unreachable)\b/i,
    /\bcould not resolve host\b/i,
    /\bstream disconnected\b/i,
    /\bconnection (?:reset|refused|closed|timed out)\b/i,
    /\bsocket hang up\b/i,
    /\bgetaddrinfo\b/i,
  ]],
  ['refusal', [
    /\bcontent (?:policy|filter|management policy)\b/i,
    /\bsafety (?:system|policy|filter)\b/i,
    /\b(?:refused|refusal)\b/i,
    /\bcannot (?:help|assist) with\b/i,
    /\bviolat(?:es|ion of) (?:our |the )?(?:usage )?polic/i,
  ]],
  ['usage-error', [
    /\bunknown (?:option|argument|command|subcommand)\b/i,
    /\bunexpected argument\b/i,
    /\bunrecognized (?:option|argument)\b/i,
    /\binvalid value '.*' for\b/i,
    /\brequired arguments were not provided\b/i,
  ]],
];

export function classifyFailure(text) {
  const clean = stripAnsi(text);
  const lines = clean.split('\n');
  for (const [kind, patterns] of PATTERNS) {
    for (const pattern of patterns) {
      const line = lines.find((item) => pattern.test(item));
      if (line) return { kind, evidence: line.trim().slice(0, 240) };
    }
  }
  return { kind: 'other', evidence: (lines.find((item) => item.trim()) || '').trim().slice(0, 240) };
}

// ---------------------------------------------------------------- reset times

const UNIT_MS = { d: 86400000, h: 3600000, m: 60000, s: 1000 };
function unitOf(word) {
  const lower = word.toLowerCase();
  if (/^d(ays?)?$/.test(lower)) return 'd';
  if (/^h((ou)?rs?|ours?)?$/.test(lower)) return 'h';
  if (/^m(in(ute)?s?)?$/.test(lower)) return 'm';
  if (/^s(ec(ond)?s?)?$/.test(lower)) return 's';
  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ANCHOR = /\b(?:resets?|resetting|reset time|try again|retry|available again|available|renews?|limit will reset)\b/i;

function validTimeZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function zoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute'), second: get('second') };
}

// The UTC instant of a wall-clock time in an IANA time zone (two passes settle daylight-saving offsets).
export function zonedTimeToUtc({ year, month, day, hour, minute }, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let utc = wall;
  for (let pass = 0; pass < 3; pass += 1) {
    const seen = zoneParts(new Date(utc), timeZone);
    const offset = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second) - utc;
    utc = wall - offset;
  }
  return new Date(utc);
}

function parseClock(hourText, minuteText, meridiem) {
  let hour = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    const pm = /^p/i.test(meridiem);
    hour = (hour % 12) + (pm ? 12 : 0);
  } else if (minuteText === undefined || hour > 23) return null; // a bare "5" is not a time
  return { hour, minute };
}

// Collects every reset time the text states near a reset phrase. Each candidate is { at, source } or
// { ambiguous: reason } when a time is given without a date/zone that makes it unambiguous.
const EPOCH = /(?:\blimit reached\|\s*|\breset(?:s_at|_at|sAt|At|s)?["']?\s*[:=]\s*)(\d{10}|\d{13})\b/i;
const ISO = /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?(?![\d:])/g;
const RELATIVE = /\b(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b[\s,]*(?:and\s+)?)+)/gi;
const CLOCK = /(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?,?\s+(?:at\s+)?)?\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?![\w:])\s*(?:\(([A-Za-z_]+\/[A-Za-z_/+-]+|UTC|GMT)\)|\b(UTC|GMT|Z)\b|([+-]\d{2}:?\d{2})\b)?/gi;

function blank(text, start, length) {
  return text.slice(0, start) + ' '.repeat(length) + text.slice(start + length);
}

function candidatesIn(line, now) {
  const found = [];
  // Unix epoch seconds or milliseconds, e.g. "usage limit reached|1759352400" or "resets_at": 1759352400.
  const epoch = EPOCH.exec(line);
  if (epoch) {
    const value = Number(epoch[1]);
    found.push({ at: new Date(epoch[1].length === 13 ? value : value * 1000), source: `epoch: ${epoch[1]}` });
  }
  const anchor = ANCHOR.exec(line);
  if (!anchor) return found;
  let tail = line.slice(anchor.index).replace(/https?:\/\/\S+/g, (url) => ' '.repeat(url.length));
  if (epoch) tail = tail.replace(epoch[1], ' '.repeat(epoch[1].length));

  // ISO 8601 with an explicit offset or Z. Without one the local zone is unknown, so it is ambiguous.
  for (const iso of [...tail.matchAll(ISO)]) {
    tail = blank(tail, iso.index, iso[0].length);
    if (!iso[2]) {
      found.push({ ambiguous: `"${iso[0]}" has no time zone` });
      continue;
    }
    const zone = iso[2].length === 5 ? `${iso[2].slice(0, 3)}:${iso[2].slice(3)}` : iso[2];
    const at = new Date(`${iso[1].replace(' ', 'T')}${zone}`);
    if (!Number.isNaN(at.getTime())) found.push({ at, source: `timestamp: ${iso[0]}` });
  }

  // Relative: "in 4 days 21 hours 35 minutes", "in 2h 15m", "after 3600 seconds".
  for (const relative of [...tail.matchAll(RELATIVE)]) {
    let ms = 0;
    for (const part of relative[1].matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
      const unit = unitOf(part[2]);
      if (unit) ms += Number(part[1]) * UNIT_MS[unit];
    }
    if (ms > 0) found.push({ at: new Date(now.getTime() + ms), source: `relative: ${relative[0].trim()}` });
    tail = blank(tail, relative.index, relative[0].length);
  }

  // Clock times such as "resets 3pm (Europe/London)", "at 5:30 PM UTC" or "Oct 6, 5pm (America/New_York)".
  for (const match of tail.matchAll(CLOCK)) {
    const [text, monthName, dayText, yearText, hourText, minuteText, meridiem, zoneParen, zoneWord, offset] = match;
    if (!meridiem && minuteText === undefined) continue;
    const time = parseClock(hourText, minuteText, meridiem);
    if (!time) continue;
    const zone = zoneParen || zoneWord || null;
    if (!zone && !offset) {
      found.push({ ambiguous: `"${text.trim()}" has no time zone` });
      continue;
    }
    const timeZone = offset ? null : /^(utc|gmt|z)$/i.test(zone) ? 'UTC' : zone;
    if (timeZone && !validTimeZone(timeZone)) {
      found.push({ ambiguous: `unknown time zone "${zone}"` });
      continue;
    }
    const offsetMs = offset ? (offset[0] === '-' ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.replace(':', '').slice(3, 5))) * 60000 : 0;
    const today = timeZone ? zoneParts(now, timeZone) : zoneParts(new Date(now.getTime() + offsetMs), 'UTC');
    const toInstant = (year, month, day) => (timeZone
      ? zonedTimeToUtc({ year, month, day, hour: time.hour, minute: time.minute }, timeZone)
      : new Date(Date.UTC(year, month - 1, day, time.hour, time.minute) - offsetMs));
    let at;
    if (monthName) {
      const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase()) + 1;
      const day = Number(dayText);
      let year = yearText ? Number(yearText) : today.year;
      at = toInstant(year, month, day);
      if (!yearText && at.getTime() < now.getTime() - 86400000) at = toInstant((year += 1), month, day);
    } else {
      at = toInstant(today.year, today.month, today.day);
      if (at.getTime() <= now.getTime()) at = new Date(at.getTime() + 86400000);
    }
    found.push({ at, source: `clock: ${text.trim()}` });
  }
  return found;
}

// Returns { resetAt, source } for exactly one unambiguous stated reset time, or { resetAt: null, reason }.
export function parseResetTime(text, { now = new Date() } = {}) {
  const lines = stripAnsi(text).split('\n');
  const candidates = lines.flatMap((line) => candidatesIn(line, now));
  const ambiguous = candidates.filter((item) => item.ambiguous);
  const times = candidates.filter((item) => item.at && !Number.isNaN(item.at.getTime()));
  if (ambiguous.length) return { resetAt: null, reason: `ambiguous reset time: ${ambiguous[0].ambiguous}` };
  if (!times.length) return { resetAt: null, reason: 'the output states no reset time' };
  const distinct = [];
  for (const item of times) if (!distinct.some((other) => Math.abs(other.at - item.at) <= 60000)) distinct.push(item);
  if (distinct.length > 1) return { resetAt: null, reason: `ambiguous reset time: the output states ${distinct.length} different times` };
  const [only] = distinct;
  if (only.at.getTime() > now.getTime() + MAX_HORIZON_MS) return { resetAt: null, reason: `the stated reset time ${only.at.toISOString()} is more than 8 days away` };
  return { resetAt: only.at, source: only.source, inPast: only.at.getTime() <= now.getTime() };
}

export function resumeAtFor(resetAt, graceMinutes = DEFAULT_QUOTA.graceMinutes) {
  return new Date(resetAt.getTime() + graceMinutes * 60000);
}

// The complete verdict for a failed command's output.
export function assessFailure(text, { now = new Date() } = {}) {
  const failure = classifyFailure(text);
  if (failure.kind !== 'quota') return { ...failure, resetAt: null };
  const reset = parseResetTime(text, { now });
  return { ...failure, ...reset };
}
