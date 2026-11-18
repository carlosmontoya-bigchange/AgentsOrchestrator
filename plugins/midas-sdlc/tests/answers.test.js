const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAnswer, looksLikeAnswer, hasAnswerLine, needs, ANSWER_FORMS } = require('../hooks/lib/answers');
const { CASES } = require('./fixtures/answer-cases');
const ID = 999999001, PR = 999999050;
const GATES = ['G0','G1','G2','G3','G4','G5','G6','G7','G8','G9','G10','G11','G12','G13','G8b','G9b'];

for (const g of GATES) test(`T13 Accept ${g} <id> parses`, () =>
  assert.deepEqual(parseAnswer(`Accept ${g} ${ID}`), { kind: 'accept', text: `Accept ${g} ${ID}`, gate: g, id: ID }));

const FORMS = [
  ['Accept G8b PR999999050', { kind: 'accept', text: 'Accept G8b PR999999050', gate: 'G8b', pr: PR }],
  ['Accept G11 PR999999050', { kind: 'accept', text: 'Accept G11 PR999999050', gate: 'G11', pr: PR }],
  ['Refuse G6 999999001', { kind: 'refuse', text: 'Refuse G6 999999001', gate: 'G6', id: ID }],
  ['Refuse G9b 999999001: not live yet', { kind: 'refuse', text: 'Refuse G9b 999999001: not live yet', gate: 'G9b', id: ID, reason: 'not live yet' }],
  ['Refuse G8b PR999999050', { kind: 'refuse', text: 'Refuse G8b PR999999050', gate: 'G8b', pr: PR }],
  ['Refuse G11 PR999999050: build stale', { kind: 'refuse', text: 'Refuse G11 PR999999050: build stale', gate: 'G11', pr: PR, reason: 'build stale' }],
  ['Skip G3 999999001: small change', { kind: 'skip', text: 'Skip G3 999999001: small change', gate: 'G3', id: ID, reason: 'small change' }],
  ['Skip G11 PR999999050: DBA completes it', { kind: 'skip', text: 'Skip G11 PR999999050: DBA completes it', gate: 'G11', pr: PR, reason: 'DBA completes it' }],
  ['Pause 999999001', { kind: 'pause', text: 'Pause 999999001', id: ID }],
  ['Pause 999999001: waiting for Alex', { kind: 'pause', text: 'Pause 999999001: waiting for Alex', id: ID, reason: 'waiting for Alex' }],
  ['Take 999999002', { kind: 'take', text: 'Take 999999002', id: 999999002 }],
  ['Tested 999999002', { kind: 'tested', text: 'Tested 999999002', id: 999999002 }],
  ['Approve: comment 999999001', { kind: 'approve', text: 'Approve: comment 999999001', verb: 'comment', id: ID }],
  ['Approve: update 999999001', { kind: 'approve', text: 'Approve: update 999999001', verb: 'update', id: ID }],
  ['Approve: create item', { kind: 'approve', text: 'Approve: create item', verb: 'create' }],
  ['Create it.', { kind: 'approve', text: 'Create it.', verb: 'create' }],
  ['Approve: review PR999999050', { kind: 'approve', text: 'Approve: review PR999999050', verb: 'review', pr: PR }],
  ['Approve: reply PR999999050', { kind: 'approve', text: 'Approve: reply PR999999050', verb: 'reply', pr: PR }],
  ['Approve: push feature/999999001-stock-line', { kind: 'approve', text: 'Approve: push feature/999999001-stock-line', verb: 'push', branch: 'feature/999999001-stock-line' }],
  ['Approve: pipeline 999999060', { kind: 'approve', text: 'Approve: pipeline 999999060', verb: 'pipeline', pipeline: 999999060 }],
  ['Approve: edit harness', { kind: 'approve', text: 'Approve: edit harness', verb: 'harness' }],
];
for (const [input, want] of FORMS) test(`T13 form parses: ${input}`, () => assert.deepEqual(parseAnswer(input), want));

test('T13 case, CRLF and surrounding whitespace', () => {
  assert.equal(parseAnswer('  ACCEPT g4 999999001 \r\n').text, 'Accept G4 999999001');
  assert.equal(parseAnswer('approve: REVIEW pr999999050').text, 'Approve: review PR999999050');
  assert.equal(parseAnswer('APPROVE: PUSH Feature/999999001-X').branch, 'Feature/999999001-X');
  assert.equal(parseAnswer('create IT.').text, 'Create it.');
});
test('T13 every parsed answer re-parses from its text', () => {
  for (const [input] of FORMS) { const a = parseAnswer(input); assert.deepEqual(parseAnswer(a.text), a); }
});

const NULLS = ["Approve: do whatever's needed", 'Update it.', 'Skip G3 999999001', 'Skip G3 999999001:',
  'Accept G14 999999001', 'Accept G08 999999001', 'Accept G8 PR999999050', 'Accept G9b PR999999050',
  'Take PR999999050', 'Accept G4', 'Accept G4 999999001 999999002', 'Approve: comment',
  'Approve: push HEAD', 'Approve: push refs/heads/x', 'Approve: push +feature/x',
  'Approve: push main:midas/dev', 'Approve: push a b', ''];
for (const input of NULLS) test(`T33 not an answer: ${JSON.stringify(input)}`, () => assert.equal(parseAnswer(input), null));

test("T33 'Approve: do whatever's needed' looks like an answer; 'Update it.' and prose do not", () => {
  assert.equal(looksLikeAnswer("Approve: do whatever's needed"), true);
  assert.equal(looksLikeAnswer('Update it.'), false);
  assert.equal(looksLikeAnswer('what next?'), false);
});
for (const c of CASES) test(`T33 decision table: ${c.name}`, () => {
  assert.deepEqual(parseAnswer(c.input), c.parse);
  assert.equal(looksLikeAnswer(c.input), c.looks);
  assert.equal(hasAnswerLine(c.input), c.line);
});
test('T33 whatever parses is also an answer line', () => {
  for (const c of CASES) if (c.parse) assert.equal(hasAnswerLine(c.input), true);
});
test('T33 needs() wording', () => assert.equal(
  needs('git push', 'nothing is armed for this message', 'Accept G8 <id>'),
  'midas-sdlc blocked git push: nothing is armed for this message. Needs: Accept G8 <id>. Stop and ask the developer; do not try another way.'));
test('T33 ANSWER_FORMS text', () => assert.equal(ANSWER_FORMS,
  'Answers are the whole message on one line: Accept G<n> <id>, where n is 0 to 13, 8b or 9b; Accept G8b PR<n>; Accept G11 PR<n>; ' +
  'Refuse G<n> <id>, optionally followed by : <reason>; Skip G<n> <id>: <reason>; Pause <id>, optionally followed by : <reason>; ' +
  'Take <id>; Tested <id>; Approve: comment <id>; Approve: update <id>; Approve: create item; Approve: review PR<n>; ' +
  'Approve: reply PR<n>; Approve: push <branch>; Approve: pipeline <definition id>; Approve: edit harness; or the button text Create it. ' +
  'Refuse and Skip also take G8b PR<n> and G11 PR<n>. Any other wording arms nothing.'));
