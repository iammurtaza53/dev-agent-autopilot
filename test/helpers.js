import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../src/lib.js';
import { setProcessRunner } from '../src/cli.js';

export async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-autopilot-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// Runs git in a throwaway repo, isolated from the developer's global excludes file and from GIT_* hook variables.
export async function gitIn(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const config = [
    '-c', `core.excludesFile=${path.join(root, '.git', 'no-global-excludes')}`,
    '-c', 'user.name=Autopilot Test',
    '-c', 'user.email=autopilot-test@example.invalid',
    '-c', 'commit.gpgsign=false',
    '-c', 'core.autocrlf=false',
  ];
  const result = await runProcess('git', [...config, ...args], { cwd: root, env });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false });

// A stand-in for the claude, codex and gh CLIs. git still runs for real.
// - state.agents: what `claude agents --json` returns
// - state.plugins: what `claude plugin list --json` returns
// - state.missing: commands that are not installed (spawn fails with ENOENT)
// - state.results: { 'command args prefix': { code, stdout, stderr } } overrides
export function fakeCli(state = {}) {
  const calls = [];
  const s = { agents: [], plugins: [], missing: [], results: {}, ...state };
  const runner = async (command, args = [], options = {}) => {
    calls.push({ command, args: [...args], options, line: [command, ...args].join(' ') });
    if (command === 'git') return runProcess(command, args, options);
    if (s.missing.includes(command)) {
      const error = new Error(`spawn ${command} ENOENT`);
      error.code = 'ENOENT';
      throw error;
    }
    const line = [command, ...args].join(' ');
    const override = Object.entries(s.results).find(([prefix]) => line.startsWith(prefix));
    if (override) return { code: 0, stdout: '', stderr: '', ...override[1] };
    if (command === 'claude' && args[0] === 'agents' && args.includes('--json')) {
      const all = args.includes('--all');
      return ok(JSON.stringify(s.agents.filter((item) => all || item.kind === 'interactive' || ['working', 'blocked'].includes(item.state))));
    }
    if (command === 'claude' && args[0] === 'plugin' && args[1] === 'list') return ok(JSON.stringify(s.plugins));
    if (command === 'claude' && args[0] === '--bg') return ok('backgrounded · 7c5dcf5d · autopilot-demo\n  claude attach 7c5dcf5d\n');
    if (args[0] === '--version') return ok(`${command} 1.0.0\n`);
    return ok('');
  };
  return { runner, calls, state: s };
}

// Installs a fake CLI and captures console output for one test; restores everything afterwards.
export function useFakeCli(t, state) {
  const fake = fakeCli(state);
  const output = [];
  const previousExitCode = process.exitCode;
  setProcessRunner(fake.runner);
  t.mock.method(console, 'log', (...parts) => output.push(parts.join(' ')));
  t.after(() => {
    setProcessRunner(null);
    process.exitCode = previousExitCode;
  });
  return { ...fake, output, text: () => output.join('\n') };
}

export async function readConfig(root) {
  return JSON.parse(await fs.readFile(path.join(root, '.autopilot', 'config.json'), 'utf8'));
}

export async function writeConfig(root, config) {
  await fs.mkdir(path.join(root, '.autopilot'), { recursive: true });
  await fs.writeFile(path.join(root, '.autopilot', 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

// The exact config `dev-autopilot init` wrote in v0.3.1 (a project named "legacy-app", checks filled in).
export async function v031Config() {
  return JSON.parse(await fs.readFile(new URL('./fixtures/v0.3.1-config.json', import.meta.url), 'utf8'));
}
