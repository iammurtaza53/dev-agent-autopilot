// The compact, machine-readable orchestration state of the current task, kept in .autopilot/runtime/ so the
// conversation is not the only place it exists. It never holds prompts, responses or transcripts.
import { readJsonSafe, writeJsonAtomic } from './lib.js';
import { runtimePath } from './runtime.js';

export const TASK_STATE_VERSION = 1;

export function taskStatePath(root) {
  return runtimePath(root, 'task-state.json');
}

export async function readTaskState(root) {
  const state = await readJsonSafe(taskStatePath(root));
  return state && state.version === TASK_STATE_VERSION && typeof state.taskHash === 'string' ? state : null;
}

// The record of this task, or null when there is none or it belongs to another task.
export async function stateForTask(root, taskHash) {
  const state = await readTaskState(root);
  return state && taskHash && state.taskHash === taskHash ? state : null;
}

// Applies a patch object or function to this task's record. A record of an earlier task is replaced, never
// merged into, so stale orchestration state can't leak into a new task.
export async function updateTaskState(root, taskHash, patch, now = new Date()) {
  if (!taskHash) return null;
  const existing = await stateForTask(root, taskHash);
  const base = existing || { version: TASK_STATE_VERSION, taskHash, createdAt: now.toISOString() };
  const next = typeof patch === 'function' ? patch({ ...base }) : { ...base, ...patch };
  next.version = TASK_STATE_VERSION;
  next.taskHash = taskHash;
  next.updatedAt = now.toISOString();
  for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key];
  await writeJsonAtomic(taskStatePath(root), next);
  return next;
}
