const test = require('node:test');
const assert = require('node:assert/strict');
const { armFor, itemMoves, describeArm, GATES, G9_PIPELINES } = require('../hooks/lib/gates');
const { parseAnswer } = require('../hooks/lib/answers');
const L = (kind, value, origin = 'human', prompt_id = 'p0') => ({ prompt_id, kind, value, origin });
const arm = (text, ledger = []) => { const a = parseAnswer(text); return { answer: a.text, ...armFor(a, ledger) }; };
const ID = 999999001, PR = 999999050;
const ROWS = [
  ['Accept G0 999999001', 'G0', { id: ID }, ['item']],
  ['Accept G1 999999001', 'G1', { id: ID }, ['item', 'comments']],
  ['Accept G2 999999001', 'G2', { id: ID }, ['item', 'comments']],
  ['Accept G3 999999001', 'G3', { id: ID }, []], ['Accept G5 999999001', 'G5', { id: ID }, []],
  ['Accept G6 999999001', 'G6', { id: ID }, []], ['Accept G7 999999001', 'G7', { id: ID }, []],
  ['Accept G10 999999001', 'G10', { id: ID }, []],
  ['Accept G4 999999001', 'G4', { id: ID }, ['item']],
  ['Accept G8 999999001', 'G8', { id: ID }, ['push', 'pr', 'link']],
  ['Accept G8b 999999001', 'G8b', { id: ID }, ['pr', 'item']],
  ['Accept G8b PR999999050', 'G8b', { pr: PR }, ['pr']],
  ['Accept G9 999999001', 'G9', { id: ID }, ['deploy', 'pipeline']],
  ['Accept G9b 999999001', 'G9b', { id: ID }, ['item', 'comments', 'testcase']],
  ['Accept G11 PR999999050', 'G11', { pr: PR }, ['merge']],
  ['Accept G11 999999001', 'G11', { id: ID }, []],
  ['Accept G12 999999001', 'G12', { id: ID }, ['item', 'create']],
  ['Accept G13 999999001', 'G13', { id: ID }, ['item', 'comments', 'create', 'close']],
  ['Refuse G6 999999001', 'G6', { id: ID }, []],
  ['Skip G3 999999001: small change', 'G3', { id: ID }, []],
  ['Pause 999999001', null, { id: ID }, []],
  ['Approve: comment 999999001', null, { id: ID }, ['comments']],
  ['Approve: update 999999001', null, { id: ID }, ['item']],
  ['Approve: create item', null, {}, ['create']], ['Create it.', null, {}, ['create']],
  ['Approve: review PR999999050', null, { pr: PR }, ['pr']],
  ['Approve: reply PR999999050', null, { pr: PR }, ['pr']],
  ['Approve: push feature/999999001-x', null, { branch: 'feature/999999001-x' }, ['push']],
  ['Approve: pipeline 999999060', null, { pipeline: 999999060 }, ['pipeline']],
];
for (const [text, gate, target, classes] of ROWS) test(`T28 ${text} arms ${classes.join(', ') || 'nothing'}`, () =>
  assert.deepEqual(armFor(parseAnswer(text), []), { gate, target, classes }));

test('T45 Approve: edit harness arms only harness, never gate state', () =>
  assert.deepEqual(armFor(parseAnswer('Approve: edit harness'), []), { gate: null, target: {}, classes: ['harness'] }));
for (const b of ['main', 'MAIN', 'WebRelease2', 'legacy', 'master', 'develop', 'midas/dev', 'Release/26.11', 'release/999999001-hotfix'])
  test(`T28 Approve: push ${b} arms nothing`, () => assert.deepEqual(armFor(parseAnswer(`Approve: push ${b}`), []).classes, []));
test('T50 Take on an own item arms nothing, whatever the origin of its gate answer', () => {
  for (const o of ['human', 'other', 'pending'])
    assert.deepEqual(armFor(parseAnswer('Take 999999001'), [L('accept', 'G4 999999001', o)]).classes, []);
});
test('T73 Take on a teammate item arms take', () =>
  assert.deepEqual(armFor(parseAnswer('Take 999999002'), [L('accept', 'G4 999999001')]), { gate: null, target: { id: 999999002 }, classes: ['take'] }));
test('T74 Tested without an open human take arms nothing', () => {
  for (const ledger of [[], [L('take', '999999002', 'other')], [L('take', '999999002', 'pending', 'p1')],
    [L('take', '999999002'), L('accept', 'G4 999999002')]])
    assert.deepEqual(armFor(parseAnswer('Tested 999999002'), ledger).classes, []);
});
test('T75 Tested after a human or verified take arms tested', () => {
  for (const ledger of [[L('take', '999999002')], [L('take', '999999002', 'pending', 'p1'), L('verified', 'p1', 'human', 'p1')]])
    assert.deepEqual(armFor(parseAnswer('Tested 999999002'), ledger).classes, ['tested']);
});

const NONE = { assign: false, states: [], columns: [], any: false };
const MOVES = [
  ['Accept G0 999999001', { assign: true, states: ['Active'], columns: [], any: false }],
  ['Accept G1 999999001', NONE], ['Accept G2 999999001', NONE], ['Accept G12 999999001', NONE],
  ['Accept G4 999999001', { assign: true, states: ['Implementation'], columns: ['Implementing'], any: false }],
  ['Accept G8b 999999001', { assign: false, states: ['Approval'], columns: ['Reviewing'], any: false }],
  ['Accept G8b PR999999050', NONE],
  ['Accept G9b 999999001', { assign: false, states: ['Approval'], columns: ['Ready for testing'], any: false }],
  ['Take 999999002', { assign: false, states: ['Approval'], columns: ['Testing'], any: false }],
  ['Accept G13 999999001', { ...NONE, any: true }], ['Approve: update 999999001', { ...NONE, any: true }],
  ['Approve: comment 999999001', NONE],
];
for (const [text, want] of MOVES) test(`T28 itemMoves: ${text}`, () => assert.deepEqual(itemMoves(arm(text)), want));
test('T75 itemMoves: Tested', () => assert.deepEqual(itemMoves(arm('Tested 999999002', [L('take', '999999002')])),
  { assign: false, states: ['Approved', 'Approval', 'Implementation'], columns: ['Closing', 'Ready for testing', 'Implementing'], any: false }));

test('T28 describeArm for an armed answer', () => {
  assert.equal(describeArm(arm('Accept G8 999999001')), 'midas-sdlc: armed push, pr, link for item 999999001, until the next message ("Accept G8 999999001").');
  assert.equal(describeArm(arm('Approve: review PR999999050')), 'midas-sdlc: armed pr for PR999999050, until the next message ("Approve: review PR999999050").');
  assert.equal(describeArm(arm('Create it.')), 'midas-sdlc: armed create, until the next message ("Create it.").');
});
test('T28 describeArm for answers that arm nothing', () => {
  const need = (t) => `midas-sdlc: recorded "${t}"; reason needed. Ask the developer why; their next message is recorded as the reason.`;
  assert.equal(describeArm(arm('Refuse G6 999999001')), need('Refuse G6 999999001'));
  assert.equal(describeArm(arm('Pause 999999001')), need('Pause 999999001'));
  assert.equal(describeArm(arm('Accept G11 999999001')), 'midas-sdlc: recorded "Accept G11 999999001"; nothing armed. A merge needs Accept G11 PR<n>.');
  assert.equal(describeArm(arm('Take 999999001', [L('accept', 'G4 999999001')])), 'midas-sdlc: recorded "Take 999999001"; nothing armed. 999999001 has gate answers, so it is the developer\'s own item.');
  assert.equal(describeArm(arm('Tested 999999002')), 'midas-sdlc: recorded "Tested 999999002"; nothing armed. There is no open Take for 999999002.');
  assert.equal(describeArm(arm('Approve: push main')), 'midas-sdlc: recorded "Approve: push main"; nothing armed. main is protected or midas/dev.');
  assert.equal(describeArm(arm('Skip G3 999999001: small change')), 'midas-sdlc: recorded "Skip G3 999999001: small change"; nothing armed.');
});
test('T28 GATES and G9_PIPELINES', () => {
  assert.deepEqual(GATES, ['G0','G1','G2','G3','G4','G5','G6','G7','G8','G9','G10','G11','G12','G13','G8b','G9b']);
  assert.deepEqual(G9_PIPELINES, [429, 504, 522, 515, 447]);
});
test('T28 Approve: push Release/x arms nothing', () => assert.deepEqual(armFor(parseAnswer('Approve: push Release/x'), []).classes, []));
test('T28 armFor fails closed on a missing or odd answer', () => {
  assert.deepEqual(armFor(null, []), { gate: null, target: {}, classes: [] });
  for (const g of ['constructor', 'toString']) assert.deepEqual(armFor({ kind: 'accept', gate: g, id: 1 }, []).classes, []);
});
test('T28 armFor with a null or undefined ledger arms no take or tested', () => {
  for (const led of [null, undefined]) {
    assert.deepEqual(armFor(parseAnswer('Tested 999999002'), led).classes, []);
    assert.deepEqual(armFor(parseAnswer('Take 999999002'), led).classes, ['take']);
  }
});
