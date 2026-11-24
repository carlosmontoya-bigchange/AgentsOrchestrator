'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HEADINGS, parseReport, lineLimit, joinStageReport } = require('../scripts/lib/report.js');

// A report with every heading. parts replaces the body of a heading.
function report(parts = {}) {
  const body = {
    Summary: 'Added the line type.\nTests pass.', Did: '- Edited QuoteExport.', Found: 'Nothing unexpected.',
    'Changed files': '- src/Quotes/QuoteExport.cs', Evidence: 'dotnet test: 12 passed.', 'Open points': 'None', Next: 'Test.', ...parts,
  };
  return HEADINGS.map((h) => `## ${h}\n\n${body[h]}\n`).join('\n');
}

test('there are seven headings, in the order the design gives', () => {
  assert.deepEqual(HEADINGS, ['Summary', 'Did', 'Found', 'Changed files', 'Evidence', 'Open points', 'Next']);
});

test('a full report parses: summary, open points and the three markers', () => {
  const r = parseReport(report({
    Evidence: 'Sensitive change: no\nResult: pass\nVerdict: approve',
    'Open points': '- The label text is not agreed.\n- Ask the product owner about rounding.',
  }));
  assert.deepEqual(r.summary, ['Added the line type.', 'Tests pass.']);
  assert.deepEqual(r.openPoints, ['The label text is not agreed.', 'Ask the product owner about rounding.']);
  assert.deepEqual(r.markers, { sensitive: 'no', result: 'pass', verdict: 'approve', exceptions: [] });
  assert.deepEqual(r.problems, []);
  assert.equal(r.lines, report({ Evidence: 'a\nb\nc', 'Open points': 'a\nb' }).trimEnd().split('\n').length);
});

test('markers are read without regard to case and only at the start of a line', () => {
  assert.equal(parseReport(report({ Evidence: 'verdict: APPROVE' })).markers.verdict, 'approve');
  assert.equal(parseReport(report({ Evidence: 'The Verdict: approve' })).markers.verdict, undefined);
  assert.equal(parseReport(report({ Evidence: '- **Result:** fail' })).markers.result, 'fail');
  assert.equal(parseReport(report({ Evidence: 'Sensitive change: maybe' })).markers.sensitive, undefined);
  assert.deepEqual(parseReport(report()).markers, { exceptions: [] });
});

test('a marker written twice with two answers is read as the careful one', () => {
  assert.equal(parseReport(report({ Did: 'Verdict: approve', Evidence: 'Verdict: changes' })).markers.verdict, 'changes');
  assert.equal(parseReport(report({ Did: 'Result: fail', Evidence: 'Result: pass' })).markers.result, 'fail');
  assert.equal(parseReport(report({ Did: 'Sensitive change: no', Evidence: 'Sensitive change: yes' })).markers.sensitive, 'yes');
});

test('two policy exceptions are both collected', () => {
  const r = parseReport(report({ 'Open points': '- Policy exception: pod-db - the migration needs a full table scan\nPolicy exception: pod-flags - a flag is removed' }));
  assert.deepEqual(r.markers.exceptions, ['pod-db - the migration needs a full table scan', 'pod-flags - a flag is removed']);
  assert.equal(r.openPoints.length, 2);
});

test('a missing heading and a six-line summary are problems', () => {
  const text = report({ Summary: '1\n2\n3\n4\n5\n6' }).replace('## Evidence', '## Proof');
  assert.deepEqual(parseReport(text).problems, ['The report has no "## Evidence" heading.', 'The Summary has 6 lines. Five at most.']);
  assert.equal(parseReport('just some text').problems.length, 7);
  assert.deepEqual(parseReport('').summary, []);
});

test('"None" under Open points means no open point', () => {
  for (const none of ['None', 'none.', '-', 'n/a', '- None', '']) assert.deepEqual(parseReport(report({ 'Open points': none })).openPoints, [], none);
});

test('headings are found whatever their case, and text under an unknown heading is not lost into the next', () => {
  const r = parseReport('## SUMMARY\nShort.\n## Notes\nLong text.\n## open points\n- One.\n');
  assert.deepEqual([r.summary, r.openPoints], [['Short.'], ['One.']]);
});

test('the stage report lists agents, open points with their agent, report problems and what is next', () => {
  const good = parseReport(report({ 'Open points': '- The label text is not agreed.' }));
  const long = parseReport(report() + '\nextra\n'.repeat(60));
  const text = joinStageReport({
    id: '362525', stage: 'build', round: 2,
    entries: [
      { key: 'backend', agent: 'backend', model: 'sonnet', path: 'C:/w/362525/build/backend-r2.md', limit: 40, report: good },
      { key: 'backend-2', agent: 'backend', model: 'sonnet', path: 'C:/w/362525/build/backend-2-r2.md', limit: 40, report: null },
      { key: 'database', agent: 'database', model: 'opus', path: 'C:/w/362525/build/database-r2.md', limit: 80, report: long },
    ],
    facts: ['App: 2 product files, 30 lines.'], open: ['The Test stage is switched off.'], next: 'Test.',
  });
  const lines = text.split('\n');
  assert.equal(lines[0], '# Build report, task 362525');
  assert.ok(text.includes('Round 2. Agents: backend (sonnet), backend-2 (sonnet), database (opus).'));
  assert.ok(text.includes('Tokens: not measured in this version.'));
  assert.ok(text.includes('- App: 2 product files, 30 lines.'));
  assert.ok(text.includes('### backend\n\nAdded the line type.\nTests pass.\n\nReport: [backend-r2.md](backend-r2.md)'));
  assert.ok(text.includes('- backend-2 wrote no report.'));
  assert.match(text, /- database: the report has \d+ lines\. The limit is 80\./);
  assert.ok(text.includes('- backend: The label text is not agreed.\n- The Test stage is switched off.'));
  assert.ok(text.endsWith('## Next\n\nTest.\n'));
  const order = ['## Agents', '## Report problems', '## Open points', '## Next'].map((h) => text.indexOf(h));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(order.every((at) => at > 0));
});

test('a stage report with no agent and nothing open says so, and has no problems section', () => {
  const text = joinStageReport({ id: '1', stage: 'test', round: 1, entries: [], facts: ['App: build pass, test pass.'], open: [], next: 'Review.' });
  assert.ok(text.includes('Round 1. Agents: none.'));
  assert.ok(text.includes('## Open points\n\nNone.'));
  assert.equal(text.includes('## Report problems'), false);
});

test('the line limit is opus_lines for opus and sonnet_lines otherwise', () => {
  const config = { reports: { sonnet_lines: 40, opus_lines: 80 } };
  assert.deepEqual([lineLimit(config, 'opus'), lineLimit(config, 'sonnet'), lineLimit(config, 'haiku')], [80, 40, 40]);
});
