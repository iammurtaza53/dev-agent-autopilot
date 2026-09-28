import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describePlugin,
  detectPlugin,
  loadPluginInSessions,
  parsePluginList,
  PLUGIN_ID,
  PLUGIN_SESSION_DENY,
  pluginSessionSettings,
} from '../src/codex-plugin.js';

const installed = { id: PLUGIN_ID, version: '1.0.6', scope: 'user', enabled: true, installPath: '/cache/codex/1.0.6' };

test('parsePluginList finds the official plugin by its public id', () => {
  const plugin = parsePluginList(JSON.stringify([{ id: 'expo@claude-plugins-official', enabled: false }, installed]));
  assert.deepEqual(plugin, { detection: 'ok', installed: true, enabled: true, version: '1.0.6', scopes: ['user'] });
  assert.equal(describePlugin(plugin), 'installed v1.0.6, enabled');
});

test('parsePluginList reports the plugin as absent when it is not listed', () => {
  const plugin = parsePluginList('[]');
  assert.equal(plugin.detection, 'ok');
  assert.equal(plugin.installed, false);
  assert.equal(describePlugin(plugin), 'not installed');
});

test('parsePluginList ignores look-alike plugins from other marketplaces', () => {
  const plugin = parsePluginList(JSON.stringify([{ id: 'codex@someone-else', enabled: true }]));
  assert.equal(plugin.installed, false);
});

test('parsePluginList reports an installed plugin that is disabled for this project', () => {
  const plugin = parsePluginList(JSON.stringify([{ ...installed, scope: 'project', enabled: false }]));
  assert.equal(plugin.installed, true);
  assert.equal(plugin.enabled, false);
  assert.equal(describePlugin(plugin), 'installed v1.0.6, not enabled for this project');
});

test('parsePluginList says detection is unavailable for unusable output', () => {
  assert.equal(parsePluginList('not json').detection, 'unavailable');
  assert.equal(parsePluginList('{"plugins":[]}').detection, 'unavailable');
  assert.match(describePlugin(parsePluginList('')), /^detection unavailable/);
});

test('detectPlugin uses the documented claude plugin list --json command only', async () => {
  const calls = [];
  const plugin = await detectPlugin(async (command, args) => {
    calls.push([command, ...args].join(' '));
    return { code: 0, stdout: JSON.stringify([installed]), stderr: '' };
  }, '/work/app');
  assert.deepEqual(calls, ['claude plugin list --json']);
  assert.equal(plugin.enabled, true);
});

test('detectPlugin reports "unavailable" instead of failing when the command fails or is missing', async () => {
  const failed = await detectPlugin(async () => ({ code: 1, stdout: '', stderr: "error: unknown command 'plugin'\nmore" }), '/w');
  assert.deepEqual(failed, { detection: 'unavailable', reason: "claude plugin list --json failed: error: unknown command 'plugin'" });

  const missing = await detectPlugin(async () => { throw new Error('spawn claude ENOENT'); }, '/w');
  assert.equal(missing.detection, 'unavailable');
  assert.match(missing.reason, /ENOENT/);
});

test('the plugin is switched off inside Autopilot sessions unless the project opts in', () => {
  assert.equal(loadPluginInSessions({}), false);
  assert.equal(loadPluginInSessions({ codexPlugin: { loadInAutopilotSessions: 'yes' } }), false);
  assert.deepEqual(pluginSessionSettings({}), {
    enabledPlugins: { [PLUGIN_ID]: false },
    deny: ['Agent(codex:codex-rescue)', 'Skill(codex:rescue)', 'Skill(codex:setup)'],
  });
});

test('opting in loads the plugin but still denies its write delegation and setup', () => {
  const settings = pluginSessionSettings({ codexPlugin: { loadInAutopilotSessions: true } });
  assert.equal('enabledPlugins' in settings, false);
  assert.deepEqual(settings.deny, PLUGIN_SESSION_DENY);
});
