const test = require('node:test');
const assert = require('node:assert/strict');
const { toLedger, reasonLine, verifiedLine, isOwnItem, takeOpen, closeAllowed, prsFor, itemForPr } = require('../hooks/lib/ledger');
const { parseAnswer } = require('../hooks/lib/answers');
const L = (kind, value, origin = 'human', prompt_id = 'p0') => ({ prompt_id, kind, value, origin });
const VALUES = [
  ['Accept G8 999999001', 'accept', 'G8 999999001'], ['Accept G8b PR999999050', 'accept', 'G8b PR999999050'],
  ['Accept G11 PR999999050', 'accept', 'G11 PR999999050'], ['Refuse G6 999999001: flaky', 'refuse', 'G6 999999001: flaky'],
  ['Skip G3 999999001: small change', 'skip', 'G3 999999001: small change'], ['Pause 999999001', 'pause', '999999001'],
  ['Pause 999999001: waiting', 'pause', '999999001: waiting'], ['Take 999999002', 'take', '999999002'],
  ['Tested 999999002', 'tested', '999999002'], ['Approve: comment 999999001', 'approve', 'comment 999999001'],
  ['Approve: update 999999001', 'approve', 'update 999999001'], ['Approve: create item', 'approve', 'create item'],
  ['Create it.', 'approve', 'create item'], ['Approve: review PR999999050', 'approve', 'review PR999999050'],
  ['Approve: reply PR999999050', 'approve', 'reply PR999999050'], ['Approve: push feature/999999001-x', 'approve', 'push feature/999999001-x'],
  ['Approve: pipeline 999999060', 'approve', 'pipeline 999999060'], ['Approve: edit harness', 'approve', 'edit harness'],
];
for (const [text, kind, value] of VALUES) test(`T13 toLedger: ${text}`, () => {
  const lines = toLedger(parseAnswer(text), 'p1', 'pending');
  assert.deepEqual(lines, [{ prompt_id: 'p1', kind, value, origin: 'pending' }]);
  assert.deepEqual(Object.keys(lines[0]), ['prompt_id', 'kind', 'value', 'origin']);
});
test('T13 reasonLine and verifiedLine', () => {
  assert.deepEqual(reasonLine({ answer: 'Refuse G6 999999001' }, 'flaky\r\non CI', 'p2', 'human'), { prompt_id: 'p2', kind: 'reason', value: 'G6 999999001: flaky on CI', origin: 'human' });
  assert.deepEqual(reasonLine({ answer: 'Pause 999999001' }, 'waiting', 'p3', 'other'), { prompt_id: 'p3', kind: 'reason', value: '999999001: waiting', origin: 'other' });
  assert.deepEqual(verifiedLine('p1'), { prompt_id: 'p1', kind: 'verified', value: 'p1', origin: 'human' });
});
test('T50 isOwnItem counts every origin and matches the exact id token', () => {
  for (const o of ['human', 'other', 'pending']) assert.equal(isOwnItem([L('accept', 'G4 999999001', o)], 999999001), true);
  assert.equal(isOwnItem([L('refuse', 'G6 999999001: flaky')], 999999001), true);
  assert.equal(isOwnItem([L('skip', 'G8b 999999001: away')], 999999001), true);
  assert.equal(isOwnItem([L('accept', 'G4 999999001')], 99999900), false);
  assert.equal(isOwnItem([L('accept', 'G4 999999001')], 9999990010), false);
  assert.equal(isOwnItem([L('accept', 'G8b PR999999001')], 999999001), false);
  assert.equal(isOwnItem([L('take', '999999001'), L('pause', '999999001'), L('approve', 'update 999999001')], 999999001), false);
});
test('T74 takeOpen ignores other and unverified pending takes, and own items', () => {
  assert.equal(takeOpen([], 999999002), false);
  assert.equal(takeOpen([L('take', '999999002', 'other')], 999999002), false);
  assert.equal(takeOpen([L('take', '999999002', 'pending', 'p1')], 999999002), false);
  assert.equal(takeOpen([L('take', '999999002'), L('accept', 'G4 999999002', 'other')], 999999002), false);
});
test('T75 takeOpen with a human or verified take', () => {
  assert.equal(takeOpen([L('take', '999999002')], 999999002), true);
  assert.equal(takeOpen([L('take', '999999002', 'pending', 'p1'), L('verified', 'p1', 'human', 'p1')], 999999002), true);
});
const close = (lines) => closeAllowed(lines, 999999001);
test('T51 no G10 answer blocks close', () => {
  assert.deepEqual(close([]), { ok: false, why: 'no G10 answer for 999999001' });
  assert.deepEqual(close([L('accept', 'G8 999999001')]), { ok: false, why: 'no G10 answer for 999999001' });
});
test('RW:An item is closed while its work was never built: G13 alone does not allow close', () =>
  assert.equal(close([L('accept', 'G13 999999001')]).ok, false));
test('T52 a G9 accept after G10 blocks close', () => assert.deepEqual(
  close([L('accept', 'G8 999999001'), L('accept', 'G10 999999001'), L('accept', 'G9 999999001')]),
  { ok: false, why: 'the G10 answer for 999999001 comes before the latest push or deploy (accept G9 999999001)' }));
test('T52 Approve: push of the id branch, or a G9b accept, after G10 blocks close', () => {
  for (const ev of [L('approve', 'push feature/999999001-fix'), L('approve', 'push 999999001'), L('accept', 'G9b 999999001')])
    assert.equal(close([L('accept', 'G10 999999001'), ev]).ok, false);
});
test('T52 other items, other origins and Approve: pipeline are not events', () => assert.equal(close([L('accept', 'G10 999999001'),
  L('approve', 'push feature/9999990010-x'), L('accept', 'G9 999999002'), L('accept', 'G9 999999001', 'other'), L('approve', 'pipeline 999999060')]).ok, true));
test('T52 a later G10 refuse blocks close', () => assert.deepEqual(close([L('accept', 'G10 999999001'), L('refuse', 'G10 999999001: failed')]),
  { ok: false, why: 'the latest G10 answer for 999999001 is not an accept or a skip with a reason' }));
test('T52 a pending G10 verified later keeps its own position', () => assert.equal(close([L('accept', 'G10 999999001', 'pending', 'p6'),
  L('accept', 'G9 999999001'), L('verified', 'p6', 'human', 'p6')]).ok, false));
test('T53 a human G10 skip with a reason after the last push allows close', () =>
  assert.deepEqual(close([L('accept', 'G8 999999001'), L('skip', 'G10 999999001: tested in production')]), { ok: true, why: '' }));
test('T53 the same skip counts only when human or verified', () => {
  const skip = (o) => L('skip', 'G10 999999001: tested in production', o, 'p5');
  assert.equal(close([L('accept', 'G8 999999001'), skip('other')]).ok, false);
  assert.equal(close([L('accept', 'G8 999999001'), skip('pending')]).ok, false);
  assert.equal(close([L('accept', 'G8 999999001'), skip('pending'), L('verified', 'p5', 'human', 'p5')]).ok, true);
});
test('T28 prsFor and itemForPr read created lines', () => {
  const led = [L('created', 'pr 999999050 999999001'), L('created', 'pr 999999051 999999001'), L('created', 'pr 999999052 999999003'), L('created', 'item 999999070')];
  assert.deepEqual(prsFor(led, 999999001), [999999050, 999999051]);
  assert.equal(itemForPr(led, 999999051), 999999001);
  assert.equal(itemForPr(led, 999999099), null);
});
test('T53 a verified line with a non-human origin verifies nothing', () => {
  const v = L('verified', 'p1', 'other', 'p1');
  assert.equal(close([L('accept', 'G10 999999001', 'pending', 'p1'), v]).ok, false);
  assert.equal(takeOpen([L('take', '999999002', 'pending', 'p1'), v], 999999002), false);
});
test('T53 malformed lines are ignored and nothing throws', () => {
  const bad = [null, undefined, 5, 'x', L('approve', null), L('accept', 7), L('take', null), L('created', null), L('accept', 'G10 999999001', 'human', 'p0')];
  bad.push(L('verified', null), { kind: 'accept' });
  assert.equal(close(bad.concat([L('approve', null)])).ok, true);
  assert.equal(takeOpen(bad, 999999002), false);
  assert.deepEqual(prsFor(bad, 999999001), []);
  assert.equal(itemForPr(bad, 999999050), null);
  assert.equal(isOwnItem(bad, 999999002), false);
});
test('T53 toLedger and reasonLine fail closed on a missing answer', () => {
  assert.deepEqual(toLedger(null, 'p1', 'human'), []);
  assert.equal(reasonLine({}, 'why', 'p1', 'human'), null);
  assert.equal(reasonLine(null, 'why', 'p1', 'human'), null);
});
test('T53 G10 for a longer id, and a whitespace-only skip reason, do not allow close', () => {
  assert.equal(close([L('accept', 'G10 9999990010')]).ok, false);
  assert.equal(close([L('skip', 'G10 999999001:   ')]).ok, false);
});
test('T53 reasonLine returns null for an unparseable pending answer', () => {
  for (const answer of ['zzz', '']) assert.equal(reasonLine({ answer }, 'why', 'p1', 'human'), null);
});
test('T53 a null or undefined ledger fails closed', () => {
  for (const led of [null, undefined]) {
    assert.deepEqual(close(led), { ok: false, why: 'no G10 answer for 999999001' });
    assert.equal(takeOpen(led, 999999002), false);
    assert.deepEqual(prsFor(led, 999999001), []);
    assert.equal(itemForPr(led, 999999050), null);
    assert.equal(isOwnItem(led, 999999001), false);
  }
});
