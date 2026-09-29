import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exists, git, normalizePathForCompare } from './lib.js';

export const CONFIG_FILE = '.autopilot/config.json';
export const RUNTIME_DIR = '.autopilot/runtime';

export function runtimePath(root, ...parts) {
  return path.join(root, RUNTIME_DIR, ...parts);
}

// The first 12 hex digits of a task hash name that task's runtime files.
export function taskKey(taskHash) {
  return taskHash ? taskHash.slice(0, 12) : 'no-task';
}

export function samePath(a, b) {
  return normalizePathForCompare(a) === normalizePathForCompare(b);
}

// Like samePath, but also follows symlinks (macOS temp folders live under /private, for example).
export async function sameFolder(a, b) {
  if (samePath(a, b)) return true;
  const real = async (value) => fs.realpath(value).catch(() => path.resolve(value));
  return samePath(await real(a), await real(b));
}

// Finds the checkout a command works in (workRoot) and the checkout that keeps Autopilot's runtime state
// (stateRoot). A Claude Code background session works in a linked worktree under .claude/worktrees/, so the
// checks, Codex runs and task state it records land in the main checkout, where `dev-autopilot status` looks.
// A path that holds its own .autopilot/config.json is used as given, as in earlier versions.
export async function resolveRoots(start, runGit = git) {
  const given = path.resolve(start || process.cwd());
  let workRoot = given;
  if (!(await exists(path.join(given, CONFIG_FILE)))) {
    const top = await runGit(given, ['rev-parse', '--show-toplevel']).catch(() => null);
    if (top?.code === 0 && top.stdout.trim()) workRoot = path.resolve(top.stdout.trim());
  }
  let stateRoot = workRoot;
  const common = await runGit(workRoot, ['rev-parse', '--git-common-dir']).catch(() => null);
  if (common?.code === 0 && common.stdout.trim()) {
    const gitDir = path.resolve(workRoot, common.stdout.trim());
    const main = path.dirname(gitDir);
    if (path.basename(gitDir) === '.git' && !samePath(main, workRoot) && (await exists(path.join(main, CONFIG_FILE)))) {
      stateRoot = main;
    }
  }
  return { workRoot, stateRoot };
}
