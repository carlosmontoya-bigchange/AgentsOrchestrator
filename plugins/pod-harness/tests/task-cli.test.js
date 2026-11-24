'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { APP, WEB, podHome, taskCli } = require('./helpers');
const store = require('../scripts/lib/store.js');
const { readState, sessionTask } = require('../scripts/lib/taskstore.js');
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
