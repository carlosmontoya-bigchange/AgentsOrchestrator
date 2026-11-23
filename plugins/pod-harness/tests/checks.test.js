'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkEnvironment, checkAccess, proveRepo } = require('../scripts/lib/checks.js');

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false });
const failed = (stdout = '') => ({ code: 1, stdout, stderr: '', timedOut: false });
const now = () => '2026-11-23T10:00:00.000Z';

// A fake shell: answers[command] is the result; every command run is recorded.
function shell(answers) {
  const ran = [];
  const runShell = (command, opts) => {
    ran.push({ command, cwd: opts.cwd });
    return answers[command] || ok();
  };
  return { ran, runShell };
}

test('environment: an old node and a forced subagent model fail with a fix', () => {
  const c = checkEnvironment({ nodeVersion: 'v18.19.0', env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' }, run: () => ok('git version 2.47') });
  assert.deepEqual(c.map((x) => [x.name, x.ok]), [['node', false], ['git', true], ['spawn-depth', true], ['subagent-model', false]]);
  assert.ok(c.every((x) => x.ok || x.fix.length > 0));
});

test('environment: all four pass on a clean machine, and a missing git fails', () => {
  assert.ok(checkEnvironment({ nodeVersion: 'v24.21.0', env: {}, run: () => ok() }).every((x) => x.ok));
  const c = checkEnvironment({ nodeVersion: 'v20.0.0', env: {}, run: () => failed() });
  assert.deepEqual(c.filter((x) => !x.ok).map((x) => x.name), ['git']);
});

test('environment: spawn depth 1 fails, 2 passes', () => {
  const depth = (v) => checkEnvironment({ nodeVersion: 'v24.0.0', env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: v }, run: () => ok() }).find((x) => x.name === 'spawn-depth').ok;
  assert.equal(depth('1'), false);
  assert.equal(depth('2'), true);
});

test('access: one check per cloned repo, a failed ls-remote is not ok', () => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    return args.includes('C:/w s/b') ? failed() : ok();
  };
  const config = { repos: [{ id: 'a', name: 'A', path: 'C:/w s/a' }, { id: 'b', name: 'B', path: 'C:/w s/b' }, { id: 'c', name: 'C' }] };
  const c = checkAccess(config, { run });
  assert.deepEqual(c.map((x) => [x.name, x.ok]), [['remote:A', true], ['remote:B', false]]);
  assert.equal(calls[0], 'git -C C:/w s/a ls-remote --exit-code origin HEAD');
  assert.ok(c[1].fix.length > 0);
});

test('prove: an unset variable is named and nothing runs', () => {
  const s = shell({});
  const r = proveRepo({ path: 'C:/x', build: 'b', test: 't', env: ['NUGET_TOKEN'] }, { env: {}, runShell: s.runShell, now });
  assert.deepEqual([r.build, r.test, r.missing_env, s.ran.length, r.at], ['not-run', 'not-run', ['NUGET_TOKEN'], 0, now()]);
});

test('prove: pass and pass, run in the repo folder, build first', () => {
  const s = shell({});
  const r = proveRepo({ path: 'C:/w s/app', build: 'b', test: 't', env: ['NUGET_TOKEN'] }, { env: { NUGET_TOKEN: 'x' }, runShell: s.runShell, now });
  assert.deepEqual([r.build, r.test, r.missing_env, r.tail], ['pass', 'pass', [], '']);
  assert.deepEqual(s.ran, [{ command: 'b', cwd: 'C:/w s/app' }, { command: 't', cwd: 'C:/w s/app' }]);
});

test('prove: a failed build skips the test and keeps the last 2000 characters', () => {
  const s = shell({ b: failed('x'.repeat(2999) + 'E') });
  const r = proveRepo({ path: 'C:/x', build: 'b', test: 't' }, { env: {}, runShell: s.runShell, now });
  assert.deepEqual([r.build, r.test, s.ran.length], ['fail', 'not-run', 1]);
  assert.equal(r.tail.length, 2000);
  assert.ok(r.tail.endsWith('E'));
});

test('prove: a failed test is fail with its output', () => {
  const s = shell({ t: failed('1 test failed') });
  const r = proveRepo({ path: 'C:/x', build: 'b', test: 't' }, { env: {}, runShell: s.runShell, now });
  assert.deepEqual([r.build, r.test, r.tail], ['pass', 'fail', '1 test failed']);
});

test('prove: a timeout is not-run, and "none" is none', () => {
  const s = shell({ t: { code: 1, stdout: '', stderr: '', timedOut: true } });
  const r = proveRepo({ path: 'C:/x', build: 'none', test: 't' }, { env: {}, runShell: s.runShell, now });
  assert.deepEqual([r.build, r.test, s.ran.length], ['none', 'not-run', 1]);
});

test('prove: picks the per-platform command, and no command for the platform is not-run', () => {
  const s = shell({});
  const repo = { path: 'C:/x', build: 'none', test: { win32: 'w', linux: 'l' } };
  assert.equal(proveRepo(repo, { platform: 'linux', env: {}, runShell: s.runShell, now }).test, 'pass');
  assert.equal(s.ran[0].command, 'l');
  assert.equal(proveRepo(repo, { platform: 'darwin', env: {}, runShell: s.runShell, now }).test, 'not-run');
});

test('prove: a repo with no folder on this machine runs nothing', () => {
  const s = shell({});
  const r = proveRepo({ build: 'b', test: 't' }, { env: {}, runShell: s.runShell, now });
  assert.deepEqual([r.build, r.test, s.ran.length], ['not-run', 'not-run', 0]);
});
