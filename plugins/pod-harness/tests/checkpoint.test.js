'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CHECKPOINTS, EXCEPTIONS, decide, question } = require('../scripts/lib/checkpoint.js');

const ON = { work_order: true, design: true, plan: true, review_result: true };
const OFF = { work_order: false, design: false, plan: false, review_result: false };
const at = (change = {}) => decide({ checkpoint: 'work_order', approvals: ON, mode: 'default', quiet: false, size: 'S', questions: 0, ...change });
const ask = (change) => at(change).ask;
const q = (change = {}) => question({
  checkpoint: 'review_result', id: '362525', headline: 'approved', ask: 'Close the task?', affects: ['app, branch task/362525'],
  next: 'The task closes. The work stays uncommitted on its branch.', questions: [], notes: 0, report: 'review/stage-report.md', ...change,
});

test('there are four pod checkpoints and four exceptions', () => {
  assert.deepEqual(CHECKPOINTS, ['work_order', 'design', 'plan', 'review_result', 'task_grew', 'budget_reached', 'policy_exception', 'needs_you']);
  assert.deepEqual(EXCEPTIONS, ['task_grew', 'budget_reached', 'policy_exception', 'needs_you']);
});

test('Manual and Accept edits ask every checkpoint the pod uses', () => {
  for (const mode of ['default', 'acceptEdits', 'plan']) {
    for (const checkpoint of CHECKPOINTS) assert.deepEqual(at({ mode, checkpoint }), { ask: true, reason: 'mode' }, `${mode} ${checkpoint}`);
  }
});

test('a checkpoint the pod switched off is not asked in any mode', () => {
  for (const mode of ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions', 'dontAsk', null]) {
    for (const checkpoint of ['work_order', 'design', 'plan', 'review_result']) {
      assert.deepEqual(at({ mode, checkpoint, approvals: OFF, questions: 3, size: 'L' }), { ask: false, reason: 'off' }, `${mode} ${checkpoint}`);
    }
  }
  assert.deepEqual(at({ approvals: { work_order: 'yes' } }), { ask: false, reason: 'off' });
  assert.deepEqual(at({ approvals: undefined }), { ask: false, reason: 'off' });
});

test('the exceptions cannot be switched off', () => {
  for (const checkpoint of EXCEPTIONS) assert.deepEqual(at({ checkpoint, approvals: OFF }), { ask: true, reason: 'mode' }, checkpoint);
});

test('Auto asks only on a question, an L task or an exception', () => {
  assert.deepEqual(at({ mode: 'auto' }), { ask: false, reason: 'auto-nothing-to-decide' });
  assert.deepEqual(at({ mode: 'auto', questions: 1 }), { ask: true, reason: 'auto-decision' });
  assert.deepEqual(at({ mode: 'auto', size: 'L' }), { ask: true, reason: 'auto-decision' });
  assert.equal(ask({ mode: 'auto', size: 'M' }), false);
  for (const checkpoint of EXCEPTIONS) assert.deepEqual(at({ mode: 'auto', checkpoint }), { ask: true, reason: 'auto-decision' }, checkpoint);
});

test('Bypass permissions and Don\'t ask never ask, exceptions included', () => {
  for (const checkpoint of CHECKPOINTS) {
    assert.deepEqual(at({ mode: 'bypassPermissions', checkpoint, questions: 5, size: 'L' }), { ask: false, reason: 'bypass' }, checkpoint);
    assert.deepEqual(at({ mode: 'dontAsk', checkpoint, questions: 5, size: 'L' }), { ask: false, reason: 'dont-ask' }, checkpoint);
  }
});

test('an unknown mode asks', () => {
  for (const mode of [null, undefined, 'something-new', '']) assert.deepEqual(at({ mode }), { ask: true, reason: 'mode-unknown' }, String(mode));
});

test('quiet asks nothing', () => {
  for (const mode of ['default', 'auto', null]) {
    for (const checkpoint of CHECKPOINTS) assert.deepEqual(at({ mode, checkpoint, quiet: true, questions: 2 }), { ask: false, reason: 'quiet' }, `${mode} ${checkpoint}`);
  }
});

test('the question is one line and the summary carries the rest', () => {
  const r = q({ questions: ['Should the index be unique?'], notes: 2 });
  assert.equal(r.question, 'Review result: approved, 1 question. Close the task?');
  assert.deepEqual(r.summary.split('\n'), [
    '### Review result: approved', 'Task 362525, app, branch task/362525', '',
    '**You decide**', '- Should the index be unique?', '',
    '**Next:** The task closes. The work stays uncommitted on its branch.', '2 notes for later are in review/stage-report.md',
  ]);
  assert.equal(q().question, 'Review result: approved. Close the task?');
  assert.equal(q().summary.includes('You decide'), false);
  assert.ok(q().summary.endsWith('The report: review/stage-report.md'));
  assert.ok(q({ notes: 1 }).summary.endsWith('1 note for later is in review/stage-report.md'));
  assert.equal(/[A-Za-z]:[\\/]/.test(JSON.stringify(q())), false);
});

test('a part with nothing to show is left out of the summary', () => {
  assert.deepEqual(q({ affects: [], report: undefined, next: undefined }).summary.split('\n'), ['### Review result: approved', 'Task 362525']);
});

test('at most five questions are listed', () => {
  const s = q({ questions: ['1', '2', '3', '4', '5', '6', '7'] }).summary;
  assert.ok(s.includes('- 5\n- and 2 more in the report'));
  assert.equal(q({ questions: ['1', '2'] }).question, 'Review result: approved, 2 questions. Close the task?');
});

test('needs_you has its own name, and its detail is shown under the title', () => {
  const r = q({ checkpoint: 'needs_you', headline: 'the tests still fail', ask: 'What should happen?', detail: 'The tests still fail after two returns to Build and a new plan.', again: 'Build runs' });
  assert.equal(r.header, 'Needs you');
  assert.equal(r.question, 'Needs you: the tests still fail. What should happen?');
  assert.deepEqual(r.summary.split('\n').slice(0, 3), ['### Needs you: the tests still fail', 'The tests still fail after two returns to Build and a new plan.', 'Task 362525, app, branch task/362525']);
  assert.equal(r.options[1].description, 'Build runs again with your answer.');
});

test('the choices can leave Continue out', () => {
  assert.deepEqual(q({ choices: ['change', 'stop'] }).options.map((o) => o.label), ['Continue with a change', 'Stop here']);
  assert.deepEqual(q().options.map((o) => o.label), ['Continue', 'Continue with a change', 'Stop here']);
  assert.ok(q().options.every((o) => typeof o.description === 'string' && o.description.length > 10));
  assert.equal(q().options[0].description, 'The task closes. The work stays uncommitted on its branch.');
});

test('the header fits the dialog', () => {
  for (const c of CHECKPOINTS) assert.ok(q({ checkpoint: c }).header.length <= 12, c);
  assert.deepEqual(CHECKPOINTS.map((c) => q({ checkpoint: c }).header), ['Work order', 'Design', 'Plan', 'Review', 'Task grew', 'Budget', 'Policy', 'Needs you']);
});

test('the change choice says who runs again', () => {
  assert.match(q({ checkpoint: 'work_order' }).options[1].description, /^The Orchestrator plans again with your answer\.$/);
  assert.match(q({ checkpoint: 'task_grew' }).options[1].description, /Orchestrator/);
  assert.match(q({ checkpoint: 'review_result' }).options[1].description, /^Build runs again/);
  assert.match(q({ checkpoint: 'policy_exception' }).options[1].description, /Build/);
  assert.match(q({ checkpoint: 'needs_you' }).options[1].description, /^The stage runs again/);
});

test('no text asks the developer to type anything', () => {
  for (const c of CHECKPOINTS) {
    const r = q({ checkpoint: c, questions: ['Which table?'], notes: 1, detail: 'Something stopped.' });
    assert.equal(/\btype\b|\bphrase\b|\benter\b/i.test(JSON.stringify(r)), false, c);
  }
});
