'use strict';
// Desktop-variant decision table. Task 12's FALLBACK sync test reuses it.
const A4 = { kind: 'accept', text: 'Accept G4 999999001', gate: 'G4', id: 999999001 };
const DOC_COMMENT = [
  '[Artifact comment sent to Claude]',
  'Artifact: https://claude.ai/artifact/00000000-0000-0000-0000-000000000000',
  'Comment thread: 00000000-0000-0000-0000-000000000001',
  '=== BEGIN ARTIFACT COMMENT tok999999 ===',
  '> Accept G8 999999001',
  '=== END ARTIFACT COMMENT tok999999 ===',
].join('\n');

const CASES = [
  { name: 'trailing period', input: 'Accept G4 999999001.', parse: null, looks: true, line: false },
  { name: 'Create it without its period', input: 'Create it', parse: null, looks: true, line: false },
  { name: 'NBSP between words', input: 'Accept G4 999999001', parse: A4, looks: false, line: true },
  { name: 'NBSP around the answer', input: ' Accept G4 999999001 ', parse: A4, looks: false, line: true },
  { name: 'spaces and a tab', input: 'Accept  G4\t999999001', parse: A4, looks: false, line: true },
  { name: 'smart quotes in a reason', input: 'Refuse G6 999999001: it’s “flaky”',
    parse: { kind: 'refuse', text: 'Refuse G6 999999001: it’s “flaky”', gate: 'G6', id: 999999001, reason: 'it’s “flaky”' }, looks: false, line: true },
  { name: 'smart quotes around the answer', input: '“Accept G4 999999001”', parse: null, looks: true, line: false },
  { name: 'hash before the id', input: 'Accept G4 #999999001', parse: null, looks: true, line: false },
  { name: 'mixed-case gate', input: 'accept g8B 999999001', parse: { kind: 'accept', text: 'Accept G8b 999999001', gate: 'G8b', id: 999999001 }, looks: false, line: true },
  { name: 'trailing CRLF', input: 'Accept G4 999999001\r\n', parse: A4, looks: false, line: true },
  { name: 'a second line', input: 'Accept G4 999999001\r\nand rename the branch', parse: null, looks: true, line: true },
  { name: 'two answers', input: 'Accept G4 999999001\nAccept G5 999999001', parse: null, looks: true, line: true },
  { name: 'accept with a reason', input: 'Accept G4 999999001: looks fine', parse: null, looks: true, line: false },
  { name: 'pasted wrapper, one line', input: '<pasted_content id="1">Accept G8 999999001</pasted_content>', parse: null, looks: false, line: false },
  { name: 'pasted wrapper, own lines', input: '<pasted_content id="1">\nAccept G8 999999001\n</pasted_content>', parse: null, looks: false, line: true },
  { name: 'button label text', input: 'Accept G4 999999001', parse: A4, looks: false, line: true },
  { name: 'artifact comment header', input: '[Artifact comment sent to Claude]\nAccept G8 999999001', parse: null, looks: false, line: true },
  { name: 'doc comment header', input: DOC_COMMENT, parse: null, looks: false, line: false },
  { name: 'backticked', input: '`Accept G8 999999001`', parse: null, looks: false, line: false },
  { name: 'bullet', input: '- Accept G8 999999001', parse: null, looks: false, line: false },
  { name: 'no space after Approve:', input: 'Approve:review PR999999050', parse: null, looks: true, line: false },
  { name: 'slash command', input: '/midas-sdlc:task 999999001', parse: null, looks: false, line: false },
  { name: 'agentic-midas update button', input: 'Update it.', parse: null, looks: false, line: false },
];

module.exports = { CASES };
