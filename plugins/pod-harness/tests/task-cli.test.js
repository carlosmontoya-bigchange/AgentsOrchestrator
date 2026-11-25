'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { APP, WEB, podHome, taskCli } = require('./helpers');
const store = require('../scripts/lib/store.js');
const { readState, writeState, sessionTask } = require('../scripts/lib/taskstore.js');
const { TASK_COMMANDS } = require('../scripts/task.js');

test('start creates the folder, the state and the session entry', async () => {
  const h = podHome();
  const { code, out } = await taskCli(h, 'start', '--item', '362525', '--predict', 'small', '--repo', 'app', '--session', 'sess-1');
  const dir = path.join(h.work, '362525');
  assert.deepEqual([code, out], [0, { id: '362525', dir, request_file: path.join(dir, 'request.md'), item_file: path.join(dir, 'item.md'), predicted: 'small' }]);
  const state = readState(dir);
  assert.deepEqual([state.id, state.pod, state.item, state.predicted, state.path, state.size, state.orchestrator, state.stage, state.step, state.created],
    ['362525', 'example', '362525', 'small', 'full', null, 'orchestrator_small', 'understand', 'ready', '2026-11-24T10:00:00.000Z']);
  assert.equal(sessionTask(h.env, 'sess-1'), dir);
});

test('a named task gets the date in its id, and full runs the full Orchestrator', async () => {
  const h = podHome();
  const { out } = await taskCli(h, 'start', '--name', 'Tidy the export', '--predict', 'full');
  assert.equal(out.id, '2026-11-24-tidy-the-export');
  const state = readState(out.dir);
  assert.deepEqual([state.item, state.orchestrator, state.path], [null, 'orchestrator', 'full']);
});

test('the session comes from the environment when it is not given', async () => {
  const h = podHome();
  h.env.CLAUDE_CODE_SESSION_ID = 'env-session';
  const { out } = await taskCli(h, 'start', '--item', '1', '--predict', 'full');
  assert.equal(sessionTask(h.env, 'env-session'), out.dir);
});

test('a trivial task starts at Build on the fast path', async () => {
  const h = podHome();
  const { out } = await taskCli(h, 'start', '--item', '7', '--predict', 'trivial', '--repo', APP, '--place', 'src/Greeting.cs');
  assert.equal(out.predicted, 'trivial');
  const state = readState(out.dir);
  assert.deepEqual([state.path, state.size, state.stage, state.forced], ['fast', 'trivial', 'build', false]);
});

test('trivial with a place on a never-trivial path becomes small, with the glob in the reason', async () => {
  const h = podHome();
  const { out } = await taskCli(h, 'start', '--item', '7', '--predict', 'trivial', '--repo', 'App', '--place', 'db/Migrations/1.sql');
  assert.equal(out.predicted, 'small');
  assert.match(out.reason, /db\/Migrations\/1\.sql/);
  assert.match(out.reason, /\*\*\/migrations\/\*\*/);
  const state = readState(out.dir);
  assert.deepEqual([state.predicted, state.path, state.stage, state.orchestrator], ['small', 'full', 'understand', 'orchestrator_small']);
});

test('--force keeps trivial on a never-trivial path', async () => {
  const h = podHome();
  const { out } = await taskCli(h, 'start', '--item', '7', '--predict', 'trivial', '--repo', 'App', '--place', 'db/Migrations/1.sql', '--force');
  assert.deepEqual([out.predicted, out.reason], ['trivial', undefined]);
  assert.deepEqual([readState(out.dir).path, readState(out.dir).forced], ['fast', true]);
});

test('trivial with two repos or no place becomes small', async () => {
  const h = podHome();
  const two = await taskCli(h, 'start', '--item', '1', '--predict', 'trivial', '--repo', 'App', '--repo', 'Web', '--place', 'a.cs');
  assert.deepEqual([two.out.predicted, typeof two.out.reason], ['small', 'string']);
  const none = await taskCli(h, 'start', '--item', '2', '--predict', 'trivial', '--repo', 'App');
  assert.deepEqual([none.out.predicted, typeof none.out.reason], ['small', 'string']);
});

test('start with a repo that has no folder prints the problem and creates nothing', async () => {
  const h = podHome();
  store.patchLayer('example', 'personal', 'Repos', [{ id: WEB, path: path.join(h.ws, 'missing') }], h.env);
  const { code, out } = await taskCli(h, 'start', '--item', '9', '--predict', 'small', '--repo', 'web', '--session', 'sess-9');
  assert.equal(code, 1);
  assert.deepEqual(Object.keys(out), ['problems']);
  assert.match(out.problems[0].message, /^Web has no folder on this machine/);
  assert.match(out.problems[0].fix, /\/pod-harness:setup repo/);
  assert.equal(fs.existsSync(path.join(h.work, '9')), false);
  assert.equal(sessionTask(h.env, 'sess-9'), null);
});

test('start refuses a repo the pod does not have, a second start and a missing argument', async () => {
  const h = podHome();
  assert.equal((await taskCli(h, 'start', '--item', '1', '--predict', 'small', '--repo', 'nope')).out.error.code, 'no-repo');
  assert.equal((await taskCli(h, 'start', '--predict', 'small')).out.error.code, 'missing-argument');
  assert.equal((await taskCli(h, 'start', '--item', '1', '--predict', 'huge')).out.error.code, 'bad-argument');
  assert.equal((await taskCli(h, 'start', '--item', '1', '--predict', 'small', '--colour', 'red')).out.error.code, 'bad-argument');
  assert.equal((await taskCli(h, 'start', '--item', '../x', '--predict', 'small')).out.error.code, 'bad-task-id');
  assert.equal((await taskCli(h, 'start', '--item', '1', '--predict', 'small')).code, 0);
  const again = await taskCli(h, 'start', '--item', '1', '--predict', 'small');
  assert.deepEqual([again.code, again.out.error.code], [1, 'task-exists']);
});

test('start on a machine with no work folder says how to set one', async () => {
  const h = podHome();
  store.patchLayer('example', 'personal', 'Reports', { work_dir: null }, h.env);
  const r = await taskCli(h, 'start', '--item', '1', '--predict', 'small');
  assert.deepEqual([r.code, r.out.error.code], [1, 'no-work-dir']);
});

test('status lists the tasks of the work folder', async () => {
  const h = podHome();
  assert.deepEqual((await taskCli(h, 'status')).out, { tasks: [] });
  await taskCli(h, 'start', '--item', '5', '--predict', 'full');
  assert.deepEqual((await taskCli(h, 'status')).out, { tasks: [{ id: '5', stage: 'understand', step: 'ready', status: 'running' }] });
});

test('quiet switches the task to ask nothing, and back', async () => {
  const h = podHome();
  const { out } = await taskCli(h, 'start', '--item', '5', '--predict', 'full');
  assert.deepEqual((await taskCli(h, 'quiet', '5', 'on')).out, { id: '5', quiet: true });
  assert.equal(readState(out.dir).quiet, true);
  assert.deepEqual((await taskCli(h, 'quiet', '5', 'off')).out, { id: '5', quiet: false });
  assert.equal((await taskCli(h, 'quiet', '5', 'maybe')).out.error.code, 'bad-argument');
  assert.equal((await taskCli(h, 'quiet', 'no-such-task', 'on')).out.error.code, 'no-task');
});

test('an unknown command and a machine with no pod are errors, not crashes', async () => {
  const h = podHome();
  assert.equal((await taskCli(h, 'explode')).out.error.code, 'unknown-command');
  assert.equal((await taskCli({ env: { POD_HARNESS_HOME: path.join(h.ws, 'empty home') }, dir: h.ws }, 'status')).out.error.code, 'no-pod');
  for (const command of ['start', 'status', 'quiet']) assert.ok(TASK_COMMANDS.includes(command), command);
});

test('a trivial start writes the work order for one specialist', async () => {
  const h = podHome();
  const { out } = await taskCli(h, 'start', '--item', '8', '--predict', 'trivial', '--repo', 'App', '--place', 'src/Greeting.cs');
  const order = JSON.parse(fs.readFileSync(path.join(out.dir, 'work-order.json'), 'utf8'));
  assert.deepEqual([order.size, order.repos, order.agents.map((a) => a.agent)], ['trivial', [APP], ['backend']]);
  const small = await taskCli(h, 'start', '--item', '9', '--predict', 'small', '--repo', 'App');
  assert.equal(fs.existsSync(path.join(small.out.dir, 'work-order.json')), false);
});

// A task waiting for its tests: Build round 1 changed a file in App and nothing in Web.
async function atTestReady(h, id, commands = {}) {
  store.patchLayer('example', 'base', 'Repos', [{ id: APP, build: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"', ...commands }], h.env);
  const { out } = await taskCli(h, 'start', '--item', id, '--predict', 'small', '--repo', 'App');
  const state = readState(out.dir);
  writeState(out.dir, { ...state, stage: 'test', step: 'ready', round: { ...state.round, build: 1 } });
  fs.mkdirSync(path.join(out.dir, 'build'), { recursive: true });
  fs.writeFileSync(path.join(out.dir, 'build', 'diff.json'), JSON.stringify({ repos: [
    { id: APP, name: 'App', files: [{ path: 'src/a.cs', added: 1, removed: 0, kind: 'product' }] },
    { id: WEB, name: 'Web', files: [] },
  ], trivial: null }));
  return out.dir;
}

test('the test command refuses to run outside test.ready', async () => {
  const h = podHome();
  await taskCli(h, 'start', '--item', '3', '--predict', 'small');
  const r = await taskCli(h, 'test', '3');
  assert.deepEqual([r.code, r.out.error.code], [1, 'not-testing']);
  assert.equal((await taskCli(h, 'test', 'no-such-task')).out.error.code, 'no-task');
});

test('the test command sets test.ran and writes the result of its round', async () => {
  const h = podHome();
  const dir = await atTestReady(h, '4');
  const { code, out } = await taskCli(h, 'test', '4');
  assert.deepEqual([code, out.result, out.round, out.repos.map((r) => [r.name, r.build, r.test])], [0, 'pass', 1, [['App', 'pass', 'pass']]]);
  const state = readState(dir);
  assert.deepEqual([state.stage, state.step, state.round.test], ['test', 'ran', 1]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'test', 'result.json'), 'utf8')).result, 'pass');
  assert.equal((await taskCli(h, 'test', '4')).out.error.code, 'not-testing');
});

test('failing tests still set test.ran, and exit 0: the result is in the output', async () => {
  const h = podHome();
  const dir = await atTestReady(h, '5', { test: 'node -e "process.exit(1)"' });
  const { code, out } = await taskCli(h, 'test', '5');
  assert.deepEqual([code, out.result, readState(dir).step], [0, 'fail', 'ran']);
});

test('the test command does not start while a run is in flight', async () => {
  const h = podHome();
  const dir = await atTestReady(h, '6');
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test', 'running.json'), JSON.stringify({ pid: process.pid, at: '2026-11-24T09:59:00.000Z' }));
  const r = await taskCli(h, 'test', '6');
  assert.deepEqual([r.code, r.out.error.code, readState(dir).round.test], [1, 'tests-running', 0]);
});

test('start refuses words left over from a name that was not quoted', async () => {
  const h = podHome();
  const r = await taskCli(h, 'start', '--name', 'fix', 'the', 'vat', 'label', '--predict', 'small');
  assert.deepEqual([r.code, r.out.error.code], [1, 'bad-argument']);
  assert.match(r.out.error.message, /quotes/);
  assert.deepEqual((await taskCli(h, 'status')).out, { tasks: [] });
  assert.equal((await taskCli(h, 'start', '--name', 'fix the vat label', '--predict', 'small')).out.id, '2026-11-24-fix-the-vat-label');
});

test('the test command keeps what another command wrote to the state while the tests ran', async () => {
  const h = podHome();
  const state = path.join(h.work, '7', 'state.json').replace(/\\/g, '/');
  // The repo's own test command switches the task to quiet, as "quiet on" in another window would.
  const flip = `node -e "const f='${state}';const fs=require('fs');const s=JSON.parse(fs.readFileSync(f));s.quiet=true;fs.writeFileSync(f,JSON.stringify(s))"`;
  const dir = await atTestReady(h, '7', { test: flip });
  assert.equal((await taskCli(h, 'test', '7')).out.result, 'pass');
  assert.deepEqual([readState(dir).quiet, readState(dir).step, readState(dir).round.test], [true, 'ran', 1]);
});
