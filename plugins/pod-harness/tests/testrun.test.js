'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./helpers');
const { runTests, isRunning } = require('../scripts/lib/testrun.js');

const PASS = 'node -e "process.exit(0)"';
const FAIL = 'node -e "console.log(\'boom\'); process.exit(1)"';
const SLEEP = 'node -e "setTimeout(() => {}, 20000)"';
const now = () => new Date('2026-11-24T10:00:00.000Z');

// A configuration with one repo per entry of "repos", each in its own folder.
function setup(...repos) {
  const dir = path.join(tempDir(), 'task');
  const config = { repos: repos.map((r, i) => ({ id: `h/r${i}`, name: `Repo${i}`, path: tempDir(), build: PASS, test: PASS, ...r })) };
  return { dir, config, ids: config.repos.map((r) => r.id) };
}
const statuses = (result) => result.repos.map((r) => [r.build, r.test]);

test('build and test both pass', async () => {
  const s = setup({});
  const result = await runTests(s.config, s.dir, s.ids, 1, { env: process.env, now });
  assert.deepEqual([result.result, result.round, result.at, result.open], ['pass', 1, now().toISOString(), []]);
  assert.deepEqual(result.repos.map((r) => [r.id, r.name, r.build, r.test, r.output]), [['h/r0', 'Repo0', 'pass', 'pass', undefined]]);
  assert.equal(typeof result.repos[0].seconds, 'number');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dir, 'test', 'result.json'), 'utf8')), result);
  assert.deepEqual(fs.readdirSync(path.join(s.dir, 'test')), ['result.json']);
});

test('a failing test fails the run and keeps its output in a file', async () => {
  const s = setup({ test: FAIL }, {});
  const result = await runTests(s.config, s.dir, s.ids, 1, { env: process.env, now });
  assert.equal(result.result, 'fail');
  assert.deepEqual(statuses(result), [['pass', 'fail'], ['pass', 'pass']]);
  assert.equal(result.repos[0].output, path.join(s.dir, 'test', 'Repo0.txt'));
  const kept = fs.readFileSync(result.repos[0].output, 'utf8');
  assert.ok(kept.includes('boom') && kept.includes(FAIL));
  assert.equal(result.repos[1].output, undefined);
});

test('a failing build leaves the tests not-run', async () => {
  const s = setup({ build: FAIL });
  const result = await runTests(s.config, s.dir, s.ids, 1, { env: process.env, now });
  assert.deepEqual([result.result, statuses(result)], ['fail', [['fail', 'not-run']]]);
});

test('"none" is not a failure', async () => {
  const s = setup({ build: 'none', test: 'none' });
  const result = await runTests(s.config, s.dir, s.ids, 1, { env: process.env, now });
  assert.deepEqual([result.result, statuses(result), result.open], ['pass', [['none', 'none']], []]);
});

test('a command recorded as not run at set-up is skipped and listed as open', async () => {
  const s = setup({ build: FAIL, proof: { build: 'not-here', test: 'pass' } });
  const result = await runTests(s.config, s.dir, s.ids, 1, { env: process.env, now });
  assert.deepEqual([result.result, statuses(result)], ['pass', [['skipped', 'pass']]]);
  assert.deepEqual(result.open, ['Repo0: the build command is recorded as not run on this machine.']);
});

test('the command for this platform is the one that runs', async () => {
  const s = setup({ test: { win32: process.platform === 'win32' ? PASS : FAIL, linux: process.platform === 'win32' ? FAIL : PASS, darwin: process.platform === 'win32' ? FAIL : PASS } });
  assert.equal((await runTests(s.config, s.dir, s.ids, 1, { env: process.env, now })).result, 'pass');
});

test('a missing environment variable fails the run and is named', async () => {
  const s = setup({ env: ['NUGET_TOKEN', 'SET_ONE'] });
  const result = await runTests(s.config, s.dir, s.ids, 1, { env: { ...process.env, NUGET_TOKEN: '', SET_ONE: 'secret-value' }, now });
  assert.deepEqual([result.result, statuses(result), result.repos[0].missing_env], ['fail', [['not-run', 'not-run']], ['NUGET_TOKEN']]);
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
});

test('a timeout fails the run', async () => {
  const s = setup({ test: SLEEP });
  const started = Date.now();
  const result = await runTests(s.config, s.dir, s.ids, 1, { env: process.env, now, timeoutMs: 1500 });
  assert.deepEqual([result.result, statuses(result)], ['fail', [['pass', 'timeout']]]);
  assert.ok(Date.now() - started < 15000);
  assert.ok(fs.existsSync(result.repos[0].output));
});

test('round 2 writes its own result and output files', async () => {
  const s = setup({ name: 'My App: v2', test: FAIL });
  const result = await runTests(s.config, s.dir, s.ids, 2, { env: process.env, now });
  assert.equal(result.repos[0].output, path.join(s.dir, 'test', 'My_App__v2-r2.txt'));
  assert.deepEqual(fs.readdirSync(path.join(s.dir, 'test')).sort(), ['My_App__v2-r2.txt', 'result-r2.json']);
});

test('running.json exists during the run and is gone after it, also after a crash', async () => {
  const s = setup({});
  const seen = [];
  const runShell = async () => {
    seen.push(isRunning(s.dir, new Date()));
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  };
  assert.equal(isRunning(s.dir, new Date()), false);
  await runTests(s.config, s.dir, s.ids, 1, { env: {}, runShell });
  assert.deepEqual(seen, [true, true]);
  assert.equal(isRunning(s.dir, new Date()), false);
  assert.equal(fs.existsSync(path.join(s.dir, 'test', 'running.json')), false);

  await assert.rejects(runTests(s.config, s.dir, s.ids, 2, { env: {}, runShell: async () => { throw new Error('the shell broke'); } }), /the shell broke/);
  assert.equal(fs.existsSync(path.join(s.dir, 'test', 'running.json')), false);
});

test('a run file that is old, or whose process is gone, does not count as running', () => {
  const dir = tempDir();
  const write = (value) => {
    fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test', 'running.json'), JSON.stringify(value));
  };
  const at = new Date('2026-11-24T10:00:00.000Z');
  write({ pid: process.pid, at: at.toISOString() });
  assert.equal(isRunning(dir, new Date(at.getTime() + 69 * 60000)), true);
  assert.equal(isRunning(dir, new Date(at.getTime() + 71 * 60000)), false);
  write({ pid: 2 ** 22 + 12345, at: at.toISOString() }); // no process has this id
  assert.equal(isRunning(dir, at), false);
  fs.writeFileSync(path.join(dir, 'test', 'running.json'), 'half a fi');
  assert.equal(isRunning(dir, at), false);
});

test('a command the set-up itself left as not-run is run, not skipped', async () => {
  // prove writes not-run for the tests when the build failed at set-up. That is not the developer's choice.
  const s = setup({ test: FAIL, proof: { build: 'fail', test: 'not-run' } });
  const result = await runTests(s.config, s.dir, s.ids, 1, { env: process.env, now });
  assert.deepEqual([result.result, statuses(result), result.open], ['fail', [['pass', 'fail']], []]);
});
