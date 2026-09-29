#!/usr/bin/env node
// Detached waiter for a quota resume ticket: node resume-helper.js <projectRoot> <ticketId>.
// It sleeps in short steps (so a cancelled ticket or a changed clock is noticed), then runs the same checked
// resume path as `dev-autopilot run`. It never resumes a ticket that was cancelled, replaced or completed.
import { appendFile, mkdir } from 'node:fs/promises';
import { resumeFromTicket } from './cli.js';
import { runtimePath } from './runtime.js';
import { readTicket } from './tickets.js';

const STEP_MS = 5 * 60 * 1000;
const [root, ticketId] = process.argv.slice(2);

async function log(message) {
  try {
    await mkdir(runtimePath(root), { recursive: true });
    await appendFile(runtimePath(root, 'resume-helper.log'), `${new Date().toISOString()} [${ticketId}] ${message}\n`, 'utf8');
  } catch {}
}

async function main() {
  if (!root || !ticketId) return;
  await log('waiting');
  for (;;) {
    const ticket = await readTicket(root);
    if (!ticket || ticket.id !== ticketId || ticket.status !== 'pending') {
      await log(`stopping: ticket is ${ticket?.id === ticketId ? ticket.status : 'gone or replaced'}`);
      return;
    }
    const wait = new Date(ticket.resumeAt).getTime() - Date.now();
    if (wait <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(wait, STEP_MS)));
  }
  const result = await resumeFromTicket(root, { ticketId, source: 'helper' });
  await log(`${result.status}: ${result.message || ''}`);
}

main().catch((error) => log(`failed: ${error?.message || error}`));
