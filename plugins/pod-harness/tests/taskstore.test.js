'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, tempHome, APP, WEB, podHome, podConfig } = require('./helpers');
const store = require('../scripts/lib/taskstore.js');

const now = new Date('2026-11-24T10:00:00.000Z');
const fields = (id) => ({ id, pod: 'example', created: now.toISOString(), item: null, predicted: 'small', forced: false, path: 'full', size: null, orchestrator: 'orchestrator_small', stage: 'understand' });

test('an item id is the task id; a name gets the date and a slug', () => {
  assert.equal(store.taskId({ item: '362525', now }), '362525');
  assert.equal(store.taskId({ name: 'Fix the VAT label!', now }), '2026-11-24-fix-the-vat-label');
  assert.equal(store.taskId({ name: 'x'.repeat(60), now }), `2026-11-24-${'x'.repeat(40)}`);
  assert.throws(() => store.taskId({ name: '!!!', now }), (e) => e.code === 'bad-task-name');
  assert.throws(() => store.taskId({ now }), (e) => e.code === 'bad-task-name');
});

test('an id that climbs out of the work folder is refused', () => {
  const config = { reports: { work_dir: 'C:/w s/work' } };
  assert.equal(store.taskDir(config, '362525'), path.join('C:/w s/work', '362525'));
  for (const id of ['../x', 'a/b', 'a\\b', '', '.hidden', 7]) {
    assert.throws(() => store.taskDir(config, id), (e) => e.code === 'bad-task-id', String(id));
  }
  assert.throws(() => store.taskDir({ reports: {} }, '1'), (e) => e.code === 'no-work-dir');
});

test('a task cannot be created twice, and an existing notes folder is kept', () => {
  const dir = path.join(tempDir(), '362525');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'task.md'), 'my notes');
  const state = store.createTask(dir, fields('362525'));
  assert.deepEqual([state.status, state.step, state.round.build, state.returns.test, state.redo, state.quiet, state.asking], ['running', 'ready', 0, 0, 0, false, null]);
  assert.deepEqual(store.readState(dir), state);
  assert.equal(fs.readFileSync(path.join(dir, 'task.md'), 'utf8'), 'my notes');
  assert.throws(() => store.createTask(dir, fields('362525')), (e) => e.code === 'task-exists');
});

test('a folder without a task, or with a broken state file, is an error and not a crash', () => {
  const dir = tempDir();
  assert.throws(() => store.readState(dir), (e) => e.code === 'no-task');
  fs.writeFileSync(path.join(dir, 'state.json'), '{ broken');
  assert.throws(() => store.readState(dir), (e) => e.code === 'bad-state');
});

test('stageFile adds -rN from round 2', () => {
  assert.equal(store.stageFile('d', 'build', 'backend', 1, 'md'), path.join('d', 'build', 'backend.md'));
  assert.equal(store.stageFile('d', 'build', 'backend', 2, 'md'), path.join('d', 'build', 'backend-r2.md'));
  assert.equal(store.stageFile('d', 'test', 'result', 3, 'json'), path.join('d', 'test', 'result-r3.json'));
  assert.equal(store.stageFile('d', 'build', 'backend', 2, 'brief.md'), path.join('d', 'build', 'backend-r2.brief.md'));
});

test('state and mode are written whole or not at all', () => {
  const dir = path.join(tempDir(), 't1');
  const state = store.createTask(dir, fields('t1'));
  store.writeState(dir, { ...state, stage: 'build' });
  assert.equal(store.readMode(dir), null);
  store.writeMode(dir, { value: 'acceptEdits', at: now.toISOString(), event: 'UserPromptSubmit' });
  assert.deepEqual(store.readMode(dir), { value: 'acceptEdits', at: now.toISOString(), event: 'UserPromptSubmit' });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['mode.json', 'state.json']);
  fs.writeFileSync(path.join(dir, 'mode.json'), 'half a fi');
  assert.equal(store.readMode(dir), null);
  fs.writeFileSync(path.join(dir, 'mode.json'), '{"value":7}');
  assert.equal(store.readMode(dir), null);
});

test('the approvals log keeps one JSON line per entry, in order', () => {
  const dir = tempDir();
  assert.deepEqual(store.readApprovals(dir), []);
  store.logApproval(dir, { at: 'a', checkpoint: 'work_order', mode: 'default', outcome: 'asked', reason: 'mode' });
  store.logApproval(dir, { at: 'b', checkpoint: 'work_order', mode: 'default', outcome: 'asked', reason: 'mode', answer: 'continue' });
  const text = fs.readFileSync(path.join(dir, 'approvals.log'), 'utf8');
  assert.equal(text.split('\n').length, 3);
  assert.deepEqual(store.readApprovals(dir).map((e) => [e.at, e.answer]), [['a', undefined], ['b', 'continue']]);
});

test('a session finds its task, and unregisterTask removes every session of that task', () => {
  const h = tempHome();
  const [one, two] = [path.join(h.dir, 'w', '1'), path.join(h.dir, 'w', '2')];
  assert.equal(store.sessionTask(h.env, 'abc-1'), null);
  store.registerSession(h.env, 'abc-1', one);
  store.registerSession(h.env, 'abc-2', one);
  store.registerSession(h.env, 'abc-3', two);
  assert.equal(store.sessionTask(h.env, 'abc-1'), one);
  store.unregisterTask(h.env, one);
  assert.deepEqual([store.sessionTask(h.env, 'abc-1'), store.sessionTask(h.env, 'abc-2'), store.sessionTask(h.env, 'abc-3')], [null, null, two]);
});

test('a session id that is not a plain id is ignored', () => {
  const h = tempHome();
  for (const id of ['../../evil', 'a/b', '', undefined]) {
    store.registerSession(h.env, id, 'C:/x');
    assert.equal(store.sessionTask(h.env, id), null);
  }
  assert.equal(fs.existsSync(path.join(h.dir, 'sessions')), false);
});

test('listTasks reads the tasks of the work folder and skips other folders', () => {
  const h = podHome();
  const config = podConfig(h);
  assert.deepEqual(store.listTasks(config), []);
  store.createTask(store.taskDir(config, 'b-task'), { ...fields('b-task'), stage: 'build' });
  store.createTask(store.taskDir(config, 'a-task'), fields('a-task'));
  fs.mkdirSync(path.join(h.work, 'notes only'));
  assert.deepEqual(store.listTasks(config), [
    { id: 'a-task', stage: 'understand', step: 'ready', status: 'running' },
    { id: 'b-task', stage: 'build', step: 'ready', status: 'running' },
  ]);
});

test('appendTaskNote starts task.md with the task id and then only appends', () => {
  const dir = path.join(tempDir(), '362525');
  store.appendTaskNote(dir, '- one');
  store.appendTaskNote(dir, '- two');
  assert.equal(fs.readFileSync(path.join(dir, 'task.md'), 'utf8'), '# Task 362525\n\n- one\n- two\n');
});

test('preflight names a repo without a folder and a variable that is not set', () => {
  const h = podHome();
  const config = podConfig(h);
  assert.deepEqual(store.preflight(config, [APP, WEB], 'win32', {}), []);
  config.repos[0].env = ['NUGET_TOKEN'];
  config.repos[0].test = { linux: 'make test' };
  config.repos[1].path = path.join(h.ws, 'missing');
  const problems = store.preflight(config, [APP, WEB, 'h/unknown'], 'win32', { OTHER: 'secret-value' });
  assert.deepEqual(problems.map((p) => p.message), [
    'App has no test command for win32.',
    'App needs the environment variable NUGET_TOKEN, which is not set.',
    `Web has no folder on this machine: ${path.join(h.ws, 'missing')}`,
    'The repo h/unknown is not set up.',
  ]);
  assert.ok(problems.every((p) => p.fix.length > 0));
  assert.equal(JSON.stringify(problems).includes('secret-value'), false);
  assert.deepEqual(store.preflight(config, [APP], 'win32', { NUGET_TOKEN: 'x' }).map((p) => p.message), ['App has no test command for win32.']);
});
