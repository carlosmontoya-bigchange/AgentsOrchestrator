'use strict';
// What each answer arms (guard design, "What each answer arms"). Pure: no I/O.
const { parseAnswer } = require('./answers');
const { isOwnItem, takeOpen } = require('./ledger');

const GATES = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12', 'G13', 'G8b', 'G9b'];
const G9_PIPELINES = [429, 504, 522, 515, 447];
const PROTECTED = /^(webrelease2|main|master|develop|legacy|midas\/dev|release\/.+)$/i;

const GATE_CLASSES = {
  G0: ['item'], G1: ['item', 'comments'], G2: ['item', 'comments'], G4: ['item'],
  G8: ['push', 'pr', 'link'], G9: ['deploy', 'pipeline'], G9b: ['item', 'comments', 'testcase'],
  G12: ['item', 'create'], G13: ['item', 'comments', 'create', 'close'],
};

function armFor(a, ledger) {
  if (!a || typeof a !== 'object') return { gate: null, target: {}, classes: [] };
  const target = {};
  if (a.id !== undefined) target.id = a.id;
  if (a.pr !== undefined) target.pr = a.pr;
  if (a.branch !== undefined) target.branch = a.branch;
  if (a.pipeline !== undefined) target.pipeline = a.pipeline;
  let gate = null;
  let classes = [];
  switch (a.kind) {
    case 'accept':
      gate = a.gate;
      if (gate === 'G8b') classes = a.pr !== undefined ? ['pr'] : ['pr', 'item'];
      else if (gate === 'G11') classes = a.pr !== undefined ? ['merge'] : [];
      else classes = (Object.hasOwn(GATE_CLASSES, gate) ? GATE_CLASSES[gate] : []);
      break;
    case 'refuse': case 'skip': gate = a.gate; break;
    case 'take': if (!isOwnItem(ledger, a.id)) classes = ['take']; break;
    case 'tested': if (takeOpen(ledger, a.id)) classes = ['tested']; break;
    case 'approve':
      if (a.verb === 'comment') classes = ['comments'];
      else if (a.verb === 'update') classes = ['item'];
      else if (a.verb === 'create') classes = ['create'];
      else if (a.verb === 'review' || a.verb === 'reply') classes = ['pr'];
      else if (a.verb === 'push') classes = PROTECTED.test(a.branch) ? [] : ['push'];
      else if (a.verb === 'pipeline') classes = ['pipeline'];
      else if (a.verb === 'harness') classes = ['harness'];
      break;
  }
  return { gate, target, classes: [...classes] };
}

const NONE = () => ({ assign: false, states: [], columns: [], any: false });
function itemMoves(arm) {
  const m = NONE();
  const has = (c) => arm.classes.includes(c);
  if (has('take')) return { ...m, states: ['Approval'], columns: ['Testing'] };
  if (has('tested')) return { ...m, states: ['Approved', 'Approval', 'Implementation'], columns: ['Closing', 'Ready for testing', 'Implementing'] };
  if (arm.gate === null && has('item')) return { ...m, any: true };
  if (arm.gate === 'G13') return { ...m, any: true };
  if (arm.gate === 'G0') return { ...m, assign: true, states: ['Active'] };
  if (arm.gate === 'G4') return { ...m, assign: true, states: ['Implementation'], columns: ['Implementing'] };
  if (arm.gate === 'G8b' && arm.target.id !== undefined) return { ...m, states: ['Approval'], columns: ['Reviewing'] };
  if (arm.gate === 'G9b') return { ...m, states: ['Approval'], columns: ['Ready for testing'] };
  return m;
}

function targetText(t) {
  if (t.id !== undefined) return `item ${t.id}`;
  if (t.pr !== undefined) return `PR${t.pr}`;
  if (t.branch !== undefined) return `branch ${t.branch}`;
  if (t.pipeline !== undefined) return `pipeline ${t.pipeline}`;
  return '';
}

function describeArm(arm) {
  const p = 'midas-sdlc:';
  const q = `"${arm.answer}"`;
  if (arm.classes.length) {
    const t = targetText(arm.target);
    return `${p} armed ${arm.classes.join(', ')}${t ? ` for ${t}` : ''}, until the next message (${q}).`;
  }
  const a = parseAnswer(arm.answer) || {};
  const nothing = `${p} recorded ${q}; nothing armed.`;
  if ((a.kind === 'refuse' || a.kind === 'pause') && a.reason === undefined) {
    return `${p} recorded ${q}; reason needed. Ask the developer why; their next message is recorded as the reason.`;
  }
  if (a.kind === 'accept' && a.gate === 'G11') return `${nothing} A merge needs Accept G11 PR<n>.`;
  if (a.kind === 'take') return `${nothing} ${a.id} has gate answers, so it is the developer's own item.`;
  if (a.kind === 'tested') return `${nothing} There is no open Take for ${a.id}.`;
  if (a.kind === 'approve' && a.verb === 'push') return `${nothing} ${a.branch} is protected or midas/dev.`;
  return nothing;
}

module.exports = { armFor, itemMoves, describeArm, GATES, G9_PIPELINES };
