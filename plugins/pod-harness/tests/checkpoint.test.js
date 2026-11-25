'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CHECKPOINTS, EXCEPTIONS, decide, question } = require('../scripts/lib/checkpoint.js');

const ON = { work_order: true, design: true, plan: true, review_result: true };
const OFF = { work_order: false, design: false, plan: false, review_result: false };
const at = (change = {}) => decide({ checkpoint: 'work_order', approvals: ON, mode: 'default', quiet: false, size: 'S', openPoints: 0, ...change });
const ask = (change) => at(change).ask;
const q = (change = {}) => question({
  checkpoint: 'work_order', id: '362525', produced: 'The task is sized S: one backend agent in App.', report: 'C:/w/362525/understand/stage-report.md',
  affects: ['item 362525', 'App'], next: 'Build starts with one agent.', openPoints: [], ...change,
});

test('there are four pod checkpoints and three exceptions', () => {
  assert.deepEqual(CHECKPOINTS, ['work_order', 'design', 'plan', 'review_result', 'task_grew', 'budget_reached', 'policy_exception']);
  assert.deepEqual(EXCEPTIONS, ['task_grew', 'budget_reached', 'policy_exception']);
});

test('Manual and Accept edits ask every checkpoint the pod uses', () => {
  for (const mode of ['default', 'acceptEdits', 'plan']) {
    for (const checkpoint of CHECKPOINTS) assert.deepEqual(at({ mode, checkpoint }), { ask: true, reason: 'mode' }, `${mode} ${checkpoint}`);
  }
});

test('a checkpoint the pod switched off is not asked in any mode', () => {
  for (const mode of ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions', 'dontAsk', null]) {
    for (const checkpoint of ['work_order', 'design', 'plan', 'review_result']) {
      assert.deepEqual(at({ mode, checkpoint, approvals: OFF, openPoints: 3, size: 'L' }), { ask: false, reason: 'off' }, `${mode} ${checkpoint}`);
    }
  }
  assert.deepEqual(at({ approvals: { work_order: 'yes' } }), { ask: false, reason: 'off' });
  assert.deepEqual(at({ approvals: undefined }), { ask: false, reason: 'off' });
});

test('the three exceptions cannot be switched off', () => {
  for (const checkpoint of EXCEPTIONS) assert.deepEqual(at({ checkpoint, approvals: OFF }), { ask: true, reason: 'mode' }, checkpoint);
});

test('Auto asks only on open points, an L task or an exception', () => {
  assert.deepEqual(at({ mode: 'auto' }), { ask: false, reason: 'auto-nothing-to-decide' });
  assert.deepEqual(at({ mode: 'auto', openPoints: 1 }), { ask: true, reason: 'auto-decision' });
  assert.deepEqual(at({ mode: 'auto', size: 'L' }), { ask: true, reason: 'auto-decision' });
  assert.equal(ask({ mode: 'auto', size: 'M' }), false);
  for (const checkpoint of EXCEPTIONS) assert.deepEqual(at({ mode: 'auto', checkpoint }), { ask: true, reason: 'auto-decision' }, checkpoint);
});

test('Bypass permissions and Don\'t ask never ask, exceptions included', () => {
  for (const checkpoint of CHECKPOINTS) {
    assert.deepEqual(at({ mode: 'bypassPermissions', checkpoint, openPoints: 5, size: 'L' }), { ask: false, reason: 'bypass' }, checkpoint);
    assert.deepEqual(at({ mode: 'dontAsk', checkpoint, openPoints: 5, size: 'L' }), { ask: false, reason: 'dont-ask' }, checkpoint);
  }
});

test('an unknown mode asks', () => {
  for (const mode of [null, undefined, 'something-new', '']) assert.deepEqual(at({ mode }), { ask: true, reason: 'mode-unknown' }, String(mode));
});

test('quiet asks nothing', () => {
  for (const mode of ['default', 'auto', null]) {
    for (const checkpoint of CHECKPOINTS) assert.deepEqual(at({ mode, checkpoint, quiet: true, openPoints: 2 }), { ask: false, reason: 'quiet' }, `${mode} ${checkpoint}`);
  }
});

test('the question has the fields in the design\'s order and exactly three choices', () => {
  const r = q({ openPoints: ['The label text is not agreed.', 'Rounding is not decided.'] });
  assert.deepEqual(r.question.split('\n'), [
    'Work order, task 362525.',
    'The task is sized S: one backend agent in App. Report: C:/w/362525/understand/stage-report.md',
    'Affects: item 362525; App.',
    'Next: Build starts with one agent.',
    'Open points: The label text is not agreed.; Rounding is not decided.',
    'How do you want to go on?',
  ]);
  assert.deepEqual(r.options.map((o) => o.label), ['Continue', 'Continue with a change', 'Stop here']);
  assert.ok(r.options.every((o) => typeof o.description === 'string' && o.description.length > 10));
  assert.equal(r.options[0].description, 'Build starts with one agent.');
});

test('open points are left out when there are none, and cut to five', () => {
  assert.equal(q().question.includes('Open points'), false);
  const many = q({ openPoints: ['1', '2', '3', '4', '5', '6', '7'] }).question;
  assert.ok(many.includes('Open points: 1; 2; 3; 4; 5; and 2 more in the report'));
  assert.equal(q({ affects: [] }).question.includes('Affects'), false);
});

test('the header fits the dialog', () => {
  for (const c of CHECKPOINTS) assert.ok(question({ checkpoint: c, id: '1', produced: 'x', report: 'r', affects: [], next: 'n', openPoints: [] }).header.length <= 12);
  assert.deepEqual(CHECKPOINTS.map((c) => q({ checkpoint: c }).header), ['Work order', 'Design', 'Plan', 'Review', 'Task grew', 'Budget', 'Policy']);
});

test('the change choice says who runs again', () => {
  assert.match(q({ checkpoint: 'work_order' }).options[1].description, /Orchestrator/);
  assert.match(q({ checkpoint: 'task_grew' }).options[1].description, /Orchestrator/);
  assert.match(q({ checkpoint: 'review_result' }).options[1].description, /Build/);
  assert.match(q({ checkpoint: 'policy_exception' }).options[1].description, /Build/);
});

test('no text asks the developer to type anything', () => {
  for (const c of CHECKPOINTS) {
    const r = q({ checkpoint: c });
    assert.equal(/\btype\b|\bphrase\b|\benter\b/i.test(JSON.stringify(r)), false, c);
  }
});
