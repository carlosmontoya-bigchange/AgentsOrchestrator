'use strict';
// Rows for state.test.js's readStdin table. expect = chunks joined without a BOM.
const big = JSON.stringify({ a: 'x'.repeat(5 * 1024 * 1024) });
const row = (name, chunks, o = {}) => ({ name, chunks, end: false, capMs: 1000, expect: chunks.join('').replace(/^\uFEFF/, ''), maxMs: 150, ...o });
const STDIN_CASES = [
  row('complete JSON held open', ['{"a":1}']),
  row('BOM stripped', ['\uFEFF{"a":1}']),
  row('JSON split across chunks', ['{"a":', '"b"}']),
  row('partial JSON held open', ['{"a":'], { capMs: 300, minMs: 250, maxMs: 600 }),
  row('empty and ended', [], { end: true }),
  row('empty and never ended', [], { capMs: 300, minMs: 250, maxMs: 600 }),
  row('garbage then end', ['not json'], { end: true }),
  row('5 MB JSON in 64 KB chunks, held open', big.match(/[^]{1,65536}/g), { maxMs: 300 }),
];
module.exports = { STDIN_CASES };
