'use strict';
// A checkpoint is a question with buttons, raised between stages. How many are asked follows the permission
// mode the developer chose in Claude. Nothing here blocks anything, and nothing is ever typed as an approval.

// The first four are the pod's choice. The last four are exceptions and always exist. "needs_you" is raised
// where the task cannot go on by itself.
const CHECKPOINTS = ['work_order', 'design', 'plan', 'review_result', 'task_grew', 'budget_reached', 'policy_exception', 'needs_you'];
const EXCEPTIONS = CHECKPOINTS.slice(4);
const CHOICES = ['continue', 'change', 'stop'];

const NAMES = {
  work_order: ['Work order', 'Work order'], design: ['Design', 'Design'], plan: ['Plan', 'Plan'], review_result: ['Review result', 'Review'],
  task_grew: ['Task grew', 'Task grew'], budget_reached: ['Budget reached', 'Budget'], policy_exception: ['Policy exception', 'Policy'],
  needs_you: ['Needs you', 'Needs you'],
};
const RUNS_AGAIN = { work_order: 'The Orchestrator plans', task_grew: 'The Orchestrator plans', review_result: 'Build runs', policy_exception: 'Build runs' };
const MAX_QUESTIONS = 5;

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// mode: what the hook last recorded, or null. size: the task's size. questions: how many the stage leaves for
// the developer. Notes never count.
function decide({ checkpoint, approvals, mode, quiet, size, questions }) {
  const exception = EXCEPTIONS.includes(checkpoint);
  if (!exception && (approvals || {})[checkpoint] !== true) return { ask: false, reason: 'off' };
  if (quiet) return { ask: false, reason: 'quiet' };
  if (mode === 'bypassPermissions') return { ask: false, reason: 'bypass' };
  if (mode === 'dontAsk') return { ask: false, reason: 'dont-ask' };
  if (mode === 'auto') {
    return exception || size === 'L' || questions > 0 ? { ask: true, reason: 'auto-decision' } : { ask: false, reason: 'auto-nothing-to-decide' };
  }
  if (mode === 'default' || mode === 'acceptEdits' || mode === 'plan') return { ask: true, reason: 'mode' };
  return { ask: true, reason: 'mode-unknown' }; // a mode that cannot be read is treated as the most careful one
}

// The dialog carries one line. The rest is a short markdown summary the main session prints first.
// headline: a few words on what the stage produced. ask: the closing question. detail: one sentence, optional.
// report: a path inside the task folder. notes: how many notes the stage report holds. choices: which of the
// three answers are offered. again: who runs again on "Continue with a change", when the checkpoint does not say.
function question({ checkpoint, id, headline, ask, detail, affects = [], next, questions = [], notes = 0, report, choices = CHOICES, again }) {
  const [name, header] = NAMES[checkpoint];
  const summary = [`### ${name}: ${headline}`];
  // A detail that only repeats the title is not shown twice.
  if (detail && detail.replace(/\.$/, '').toLowerCase() !== headline.toLowerCase()) summary.push(detail);
  summary.push([`Task ${id}`, ...affects].join(', '));
  if (questions.length) {
    const more = questions.length - MAX_QUESTIONS;
    summary.push('', '**You decide**', ...questions.slice(0, MAX_QUESTIONS).map((q) => `- ${q}`), ...(more > 0 ? [`- and ${more} more in the report`] : []));
  }
  const last = [];
  if (next) last.push(`**Next:** ${next}`);
  if (report) last.push(notes > 0 ? `${count(notes, 'note for later is', 'notes for later are')} in ${report}` : `The report: ${report}`);
  if (last.length) summary.push('', ...last);

  const options = {
    continue: { label: 'Continue', description: next },
    change: { label: 'Continue with a change', description: `${again || RUNS_AGAIN[checkpoint] || 'The stage runs'} again with your answer.` },
    stop: { label: 'Stop here', description: 'The task keeps everything. /pod-harness:resume continues it.' },
  };
  return {
    header,
    question: `${name}: ${headline}${questions.length ? `, ${count(questions.length, 'question', 'questions')}` : ''}. ${ask}`,
    summary: summary.join('\n'),
    options: CHOICES.filter((c) => choices.includes(c)).map((c) => options[c]),
  };
}

module.exports = { CHECKPOINTS, EXCEPTIONS, CHOICES, decide, question };
