'use strict';
// A checkpoint is a question with buttons, raised between stages. How many are asked follows the permission
// mode the developer chose in Claude. Nothing here blocks anything, and nothing is ever typed as an approval.

// The first four are the pod's choice. The last three are exceptions and always exist.
const CHECKPOINTS = ['work_order', 'design', 'plan', 'review_result', 'task_grew', 'budget_reached', 'policy_exception'];
const EXCEPTIONS = CHECKPOINTS.slice(4);

const NAMES = {
  work_order: ['Work order', 'Work order'], design: ['Design', 'Design'], plan: ['Plan', 'Plan'], review_result: ['Review result', 'Review'],
  task_grew: ['Task grew', 'Task grew'], budget_reached: ['Budget reached', 'Budget'], policy_exception: ['Policy exception', 'Policy'],
};
const RUNS_AGAIN = { work_order: 'The Orchestrator plans', task_grew: 'The Orchestrator plans', review_result: 'Build runs', policy_exception: 'Build runs' };
const MAX_OPEN_POINTS = 5;

// mode: what the hook last recorded, or null. size: the task's size. openPoints: how many the stage report lists.
function decide({ checkpoint, approvals, mode, quiet, size, openPoints }) {
  const exception = EXCEPTIONS.includes(checkpoint);
  if (!exception && (approvals || {})[checkpoint] !== true) return { ask: false, reason: 'off' };
  if (quiet) return { ask: false, reason: 'quiet' };
  if (mode === 'bypassPermissions') return { ask: false, reason: 'bypass' };
  if (mode === 'dontAsk') return { ask: false, reason: 'dont-ask' };
  if (mode === 'auto') {
    return exception || size === 'L' || openPoints > 0 ? { ask: true, reason: 'auto-decision' } : { ask: false, reason: 'auto-nothing-to-decide' };
  }
  if (mode === 'default' || mode === 'acceptEdits' || mode === 'plan') return { ask: true, reason: 'mode' };
  return { ask: true, reason: 'mode-unknown' }; // a mode that cannot be read is treated as the most careful one
}

// The same fields in the same order at every checkpoint, and the same three choices.
function question({ checkpoint, id, produced, report, affects, next, openPoints }) {
  const [name, header] = NAMES[checkpoint];
  const lines = [`${name}, task ${id}.`, `${produced} Report: ${report}`];
  if (affects.length) lines.push(`Affects: ${affects.join('; ')}.`);
  lines.push(`Next: ${next}`);
  if (openPoints.length) {
    const more = openPoints.length - MAX_OPEN_POINTS;
    lines.push(`Open points: ${openPoints.slice(0, MAX_OPEN_POINTS).join('; ')}${more > 0 ? `; and ${more} more in the report` : ''}`);
  }
  lines.push('How do you want to go on?');
  return {
    header,
    question: lines.join('\n'),
    options: [
      { label: 'Continue', description: next },
      { label: 'Continue with a change', description: `You say what to change. ${RUNS_AGAIN[checkpoint] || 'The stage runs'} again with your note.` },
      { label: 'Stop here', description: 'The task stops and keeps everything. /pod-harness:resume continues it.' },
    ],
  };
}

module.exports = { CHECKPOINTS, EXCEPTIONS, decide, question };
