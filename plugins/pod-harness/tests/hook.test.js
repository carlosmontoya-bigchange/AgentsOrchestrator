'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pluginRoot, tempDir, tempHome } = require('./helpers');
const { createTask, readMode, registerSession, writeState, readState } = require('../scripts/lib/taskstore.js');

const HOOK = path.join(pluginRoot, 'scripts', 'hook.js');

// Runs hook.js as Claude Code does: one JSON document on stdin.
function hook(h, input) {
  const r = spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), env: { ...process.env, ...h.env }, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const QUIET = { code: 0, stdout: '', stderr: '' };

// A running task registered for the session "sess-1".
function running(change = {}) {
  const h = tempHome();
  const dir = path.join(tempDir(), '362525');
  createTask(dir, { id: '362525', pod: 'example', stage: 'build', step: 'waiting', ...change });
  registerSession(h.env, 'sess-1', dir);
  return { h, dir };
}
const event = (name, extra = {}) => ({ session_id: 'sess-1', hook_event_name: name, cwd: 'C:/x', permission_mode: 'acceptEdits', ...extra });
const files = (dir) => fs.readdirSync(dir).sort();

test('a session with no task: exit 0, no output, nothing written', () => {
  const h = tempHome();
  assert.deepEqual(hook(h, event('UserPromptSubmit', { prompt: 'hello' })), QUIET);
  assert.deepEqual(files(h.dir), []);
  assert.deepEqual(hook(h, event('SessionStart', { source: 'compact' })), QUIET);
  assert.deepEqual(files(h.dir), []);
});

test('stdin that is not JSON: exit 0, no output', () => {
  const { h, dir } = running();
  for (const input of ['', 'not json', '[1,2]', 'null', '{"session_id":7}', '{"session_id":"../../x","permission_mode":"auto"}']) {
    assert.deepEqual(hook(h, input), QUIET, input);
  }
  assert.deepEqual(files(dir), ['state.json']);
});

test('a user prompt records the mode for the session\'s task', () => {
  const { h, dir } = running();
  assert.deepEqual(hook(h, event('UserPromptSubmit', { prompt: 'continue' })), QUIET);
  const mode = readMode(dir);
  assert.deepEqual([mode.value, mode.event], ['acceptEdits', 'UserPromptSubmit']);
  assert.ok(Math.abs(Date.now() - new Date(mode.at)) < 60000);
});

test('an agent dispatch and an agent finishing record the mode too', () => {
  const { h, dir } = running();
  hook(h, event('PreToolUse', { tool_name: 'Agent', permission_mode: 'auto' }));
  assert.deepEqual([readMode(dir).value, readMode(dir).event], ['auto', 'PreToolUse']);
  hook(h, event('SubagentStop', { permission_mode: 'bypassPermissions' }));
  assert.deepEqual([readMode(dir).value, readMode(dir).event], ['bypassPermissions', 'SubagentStop']);
});

test('an event without permission_mode writes nothing', () => {
  const { h, dir } = running();
  assert.deepEqual(hook(h, { session_id: 'sess-1', hook_event_name: 'PreToolUse', tool_name: 'Agent' }), QUIET);
  assert.deepEqual(hook(h, event('PreToolUse', { permission_mode: 7 })), QUIET);
  assert.deepEqual(hook(h, event('Stop')), QUIET, 'an event the hook is not for');
  assert.deepEqual(files(dir), ['state.json']);
});

test('the hook never changes state.json', () => {
  const { h, dir } = running();
  const before = fs.readFileSync(path.join(dir, 'state.json'));
  for (const name of ['UserPromptSubmit', 'PreToolUse', 'SubagentStop']) hook(h, event(name));
  hook(h, event('SessionStart', { source: 'compact' }));
  assert.equal(readMode(dir).value, 'acceptEdits', 'the hook ran and recorded the mode');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'state.json')), before);
});

test('a finished task is left alone', () => {
  for (const status of ['done', 'blocked', 'stopped']) {
    const { h, dir } = running();
    writeState(dir, { ...readState(dir), status });
    assert.deepEqual(hook(h, event('UserPromptSubmit')), QUIET, status);
    assert.deepEqual(hook(h, event('SessionStart', { source: 'compact' })), QUIET, status);
    assert.deepEqual(files(dir), ['state.json'], status);
  }
});

test('a registered folder with no readable task is left alone', () => {
  const { h, dir } = running();
  fs.writeFileSync(path.join(dir, 'state.json'), '{ broken');
  assert.deepEqual(hook(h, event('UserPromptSubmit')), QUIET);
  assert.deepEqual(files(dir), ['state.json']);
});

test('after compaction the stage line is printed as additionalContext, and nothing else', () => {
  const { h, dir } = running();
  const r = hook(h, event('SessionStart', { source: 'compact' }));
  assert.deepEqual([r.code, r.stderr], [0, '']);
  assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'pod-harness task 362525 is at stage build. Continue with /pod-harness:resume 362525.' } });
  assert.deepEqual(hook(h, event('SessionStart', { source: 'startup' })), QUIET, 'only after compaction');
  assert.deepEqual(files(dir), ['state.json'], 'SessionStart records no mode');
});

test('hooks.json names the four events and calls hook.js through the plugin root', () => {
  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
  assert.equal(typeof config.description, 'string');
  assert.deepEqual(Object.keys(config.hooks).sort(), ['PreToolUse', 'SessionStart', 'SubagentStop', 'UserPromptSubmit']);
  for (const [name, groups] of Object.entries(config.hooks)) {
    assert.equal(groups.length, 1, name);
    const [handler] = groups[0].hooks;
    assert.deepEqual([groups[0].hooks.length, handler.type, handler.command, handler.args], [1, 'command', 'node', ['${CLAUDE_PLUGIN_ROOT}/scripts/hook.js']], name);
  }
  assert.equal(config.hooks.SessionStart[0].matcher, 'compact');
  assert.ok(new RegExp(`^(${config.hooks.PreToolUse[0].matcher})$`).test('Agent'));
  assert.equal(new RegExp(`^(${config.hooks.PreToolUse[0].matcher})$`).test('Bash'), false);
  for (const name of ['UserPromptSubmit', 'SubagentStop']) assert.equal(config.hooks[name][0].matcher, undefined, name);
});
