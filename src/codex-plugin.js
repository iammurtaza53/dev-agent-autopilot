// Support for OpenAI's official Codex plugin for Claude Code (github.com/openai/codex-plugin-cc).
// Only its public names are used here: the plugin id from its install instructions and the command and
// subagent names from its README. Autopilot never reads the plugin's files, state or private scripts.

export const PLUGIN_ID = 'codex@openai-codex';
export const PLUGIN_MARKETPLACE = 'openai/codex-plugin-cc';

export const PLUGIN_SETUP_IN_CLAUDE = [
  `/plugin marketplace add ${PLUGIN_MARKETPLACE}`,
  `/plugin install ${PLUGIN_ID}`,
  '/reload-plugins',
  '/codex:setup',
];

export const PLUGIN_INSTALL_COMMANDS = [
  ['plugin', 'marketplace', 'add', PLUGIN_MARKETPLACE],
  ['plugin', 'install', PLUGIN_ID],
];

// Always denied in Autopilot sessions, even when the plugin is loaded there: codex:codex-rescue and
// /codex:rescue hand work to Codex with write access by default, and /codex:setup can switch on the
// plugin's Stop-time review gate. Codex must stay a read-only planner and reviewer.
export const PLUGIN_SESSION_DENY = ['Agent(codex:codex-rescue)', 'Skill(codex:rescue)', 'Skill(codex:setup)'];

export function loadPluginInSessions(config) {
  return config.codexPlugin?.loadInAutopilotSessions === true;
}

// The part of an Autopilot session's --settings that concerns the plugin. `--settings` outranks user,
// project and local settings key by key, so this switches the plugin off for that session only.
export function pluginSessionSettings(config) {
  return loadPluginInSessions(config)
    ? { deny: [...PLUGIN_SESSION_DENY] }
    : { enabledPlugins: { [PLUGIN_ID]: false }, deny: [...PLUGIN_SESSION_DENY] };
}

// Reads `claude plugin list --json`. Returns { detection: 'ok', installed, enabled, version, scopes }
// or { detection: 'unavailable', reason } when the output can't be used.
export function parsePluginList(stdout) {
  let list;
  try {
    list = JSON.parse(stdout || '');
  } catch (error) {
    return { detection: 'unavailable', reason: `could not parse claude plugin list output: ${error.message}` };
  }
  if (!Array.isArray(list)) return { detection: 'unavailable', reason: 'claude plugin list did not return a list' };
  const entries = list.filter((item) => item?.id === PLUGIN_ID);
  const enabled = entries.find((item) => item.enabled === true);
  return {
    detection: 'ok',
    installed: entries.length > 0,
    enabled: Boolean(enabled),
    version: (enabled || entries[0])?.version || null,
    scopes: [...new Set(entries.map((item) => item.scope).filter(Boolean))],
  };
}

export async function detectPlugin(exec, root) {
  const result = await exec('claude', ['plugin', 'list', '--json'], { cwd: root, timeoutMs: 30000 })
    .catch((error) => ({ code: 1, stdout: '', stderr: error.message }));
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split(/\r?\n/)[0];
    return { detection: 'unavailable', reason: `claude plugin list --json failed${detail ? `: ${detail}` : ''}` };
  }
  return parsePluginList(result.stdout);
}

export function describePlugin(plugin) {
  if (plugin.detection !== 'ok') return `detection unavailable (${plugin.reason})`;
  if (!plugin.installed) return 'not installed';
  const version = plugin.version ? ` v${plugin.version}` : '';
  return plugin.enabled ? `installed${version}, enabled` : `installed${version}, not enabled for this project`;
}
