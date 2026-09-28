// Helpers for the sessions `claude agents --json` reports. Background sessions carry a short `id`
// (what `claude attach`, `logs`, `stop`, `respawn` and `rm` accept) and a full `sessionId` UUID.

const ACTIVE_STATES = new Set(['working', 'blocked']);
const FINISHED_STATES = new Set(['done', 'failed', 'stopped']);

export function isBackground(session) {
  return Boolean(session?.id) && session.kind !== 'interactive';
}

// True when a session matches the saved last-session record. Missing values never match.
export function matchesRecord(session, record) {
  if (!session || !record) return false;
  return Boolean((record.id && session.id === record.id) || (record.sessionId && session.sessionId === record.sessionId));
}

// Finds one session by short id, full sessionId or exact name.
// Returns { session } or { error } with a message the user can act on.
export function findSession(sessions, ident) {
  const wanted = String(ident || '').trim();
  const key = wanted.toLowerCase();
  const byId = sessions.filter((item) => item.id && item.id.toLowerCase() === key);
  const bySessionId = sessions.filter((item) => item.sessionId && item.sessionId.toLowerCase() === key);
  const byName = sessions.filter((item) => item.name === wanted);
  const matches = byId.length ? byId : bySessionId.length ? bySessionId : byName;

  if (matches.length > 1) {
    const ids = matches.map((item) => item.id || item.sessionId).join(', ');
    return { error: `"${wanted}" matches more than one Claude session (${ids}). Use the short id from dev-autopilot status.` };
  }
  const [session] = matches;
  if (!session) {
    return {
      error: `No Claude background session matches "${wanted}". Use the "id" value from dev-autopilot status (a short id such as 7c5dcf5d); the full "sessionId" also works.`,
    };
  }
  if (!isBackground(session)) {
    return {
      error: `"${wanted}" is an interactive Claude Code session, not a background session. attach, logs, stop and resume only work with background sessions listed by dev-autopilot status.`,
    };
  }
  return { session };
}

const NAME_LIMIT = 64;
const HASH_DIGITS = 6;

// Claude session names are capped at 64 characters, so an over-long prefix is shortened rather than the hash.
function namePrefix(prefix) {
  return prefix.slice(0, NAME_LIMIT - HASH_DIGITS - 1);
}

// The name `run` gives a task's session: the configured prefix plus the first 6 hex digits of the task hash.
export function sessionName(prefix, taskHash) {
  return `${namePrefix(prefix)}-${taskHash.slice(0, HASH_DIGITS)}`;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Autopilot started a session if it has the exact generated name shape or is the recorded last session.
// A name that merely starts with the prefix (for example `autopilot-demo-investigation`) doesn't count.
export function isOwned(session, { prefix, record }) {
  const generated = prefix && new RegExp(`^${escapeRegExp(namePrefix(prefix))}-[0-9a-f]{${HASH_DIGITS}}$`).test(session.name || '');
  return Boolean(generated || matchesRecord(session, record));
}

// True when the session belongs to the task in the task file: it is the recorded session of this task, or it
// carries this task's generated name, which still works when .autopilot/runtime/ has been lost.
export function isCurrentTask(session, { prefix, record, taskHash }) {
  if (!taskHash) return false;
  if (record?.taskHash === taskHash && matchesRecord(session, record)) return true;
  return Boolean(prefix) && session.name === sessionName(prefix, taskHash);
}

// active: working or waiting for input.
// current: finished, but it belongs to the task in the task file, so `run` reports or respawns it.
// stale: finished, and it belongs to an earlier task (or wasn't started by Autopilot).
export function classifySession(session, context) {
  const owned = isOwned(session, context);
  const current = isCurrentTask(session, context);
  let lifecycle = 'unknown';
  if (ACTIVE_STATES.has(session.state)) lifecycle = 'active';
  else if (FINISHED_STATES.has(session.state)) lifecycle = current ? 'current' : 'stale';
  return { owned, current, lifecycle, useId: session.id };
}

// Decides which background sessions `cleanup` may remove. Only finished, Autopilot-owned sessions of an
// earlier task qualify; everything else is kept with a reason. Without a task file the current task can't be
// identified, so nothing is removed.
export function planCleanup(sessions, context) {
  const remove = [];
  const keep = [];
  for (const session of sessions.filter(isBackground)) {
    const info = classifySession(session, context);
    if (!context.taskHash) keep.push({ session, reason: 'task file not found, so the current task is unknown' });
    else if (!info.owned) keep.push({ session, reason: 'not started by Autopilot' });
    else if (info.lifecycle === 'active') keep.push({ session, reason: `still ${session.state}` });
    else if (info.lifecycle === 'current') keep.push({ session, reason: 'belongs to the current task' });
    else if (info.lifecycle === 'stale') remove.push({ session, reason: `${session.state}, earlier task` });
    else keep.push({ session, reason: `unknown state "${session.state}"` });
  }
  return { remove, keep };
}
