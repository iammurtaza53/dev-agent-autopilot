// Quota resume tickets. A ticket records that a task stopped on an exhausted usage limit with a stated reset
// time, and when Autopilot may resume it. A small detached helper waits for that time; if the helper doesn't
// survive (for example a reboot), the next dev-autopilot command re-arms it from the ticket.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readJsonSafe, writeJsonAtomic } from './lib.js';
import { runtimePath } from './runtime.js';

export const TICKET_VERSION = 1;
const LOCK_STALE_MS = 10 * 60 * 1000;
// A ticket that is still pending this long after its resume time is not acted on any more.
export const TICKET_EXPIRY_MS = 3 * 24 * 60 * 60 * 1000;

export function ticketPath(root) {
  return runtimePath(root, 'resume-ticket.json');
}

export async function readTicket(root) {
  const ticket = await readJsonSafe(ticketPath(root));
  return ticket && ticket.version === TICKET_VERSION && ticket.id && ticket.taskHash && ticket.resumeAt ? ticket : null;
}

export async function writeTicket(root, ticket) {
  await writeJsonAtomic(ticketPath(root), ticket);
}

export function newTicket({ root, taskHash, taskFile, session, provider, reason, resetAt, resumeAt, evidence, now }) {
  return {
    version: TICKET_VERSION,
    id: crypto.randomBytes(6).toString('hex'),
    status: 'pending',
    projectRoot: root,
    taskHash,
    taskFile,
    session: { id: session?.id || null, sessionId: session?.sessionId || null, name: session?.name || null },
    provider,
    reason,
    resetAt: resetAt.toISOString(),
    resumeAt: resumeAt.toISOString(),
    createdAt: now.toISOString(),
    evidence: String(evidence || '').slice(0, 240),
    helper: null,
  };
}

export async function closeTicket(root, ticket, status, detail, now = new Date()) {
  const closed = { ...ticket, status, closedAt: now.toISOString(), closeReason: detail };
  await writeTicket(root, closed);
  return closed;
}

export function isDue(ticket, now = new Date()) {
  return new Date(ticket.resumeAt).getTime() <= now.getTime();
}

export function isExpired(ticket, now = new Date()) {
  return now.getTime() - new Date(ticket.resumeAt).getTime() > TICKET_EXPIRY_MS;
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

// One resumer at a time: the helper and a manual `run` can't both resume the same ticket.
export async function acquireLock(root, now = new Date()) {
  const file = runtimePath(root, 'resume.lock');
  await fs.mkdir(runtimePath(root), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(file, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: now.toISOString() }));
      await handle.close();
      return async () => {
        await fs.rm(file, { force: true });
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const held = await readJsonSafe(file);
      const age = held?.at ? now.getTime() - new Date(held.at).getTime() : Infinity;
      if (age < LOCK_STALE_MS && processAlive(held?.pid)) return null;
      await fs.rm(file, { force: true });
    }
  }
  return null;
}

export const HELPER_SCRIPT = fileURLToPath(new URL('./resume-helper.js', import.meta.url));

// Starts the waiter as its own detached process, so it outlives this command, the terminal and the editor. It
// works in the temp folder: on Windows a folder that is a process's working directory can't be moved or deleted,
// and the wait can last hours.
export function launchDetachedHelper(root, ticket) {
  const child = spawn(process.execPath, [HELPER_SCRIPT, root, ticket.id], {
    cwd: os.tmpdir(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
  return child.pid || null;
}
