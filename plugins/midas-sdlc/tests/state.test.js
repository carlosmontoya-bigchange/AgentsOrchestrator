'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'midas-st-')).replace(/\\/g, '/');
let tmp, tmp2, work, emptyDir;
beforeEach(() => { tmp = mk(); tmp2 = mk(); work = mk(); emptyDir = mk(); });
const ARM = { session_id: 's1', prompt_id: 'p1', answer: 'Accept G8 999999001', gate: 'G8', target: { id: 999999001 },
  classes: ['push', 'pr', 'link'], origin: 'human', created: { pr: [], item: [], testcase: [] } };
const LINE = { prompt_id: 'p1', kind: 'accept', value: 'G8 999999001', origin: 'human' };
const LINE2 = { prompt_id: 'p2', kind: 'take', value: '999999002', origin: 'human' };
const LINE3 = { prompt_id: 'p3', kind: 'skip', value: 'G3 999999003: small change', origin: 'human' };

const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const S = require('../hooks/lib/state');
const STATE = require.resolve('../hooks/lib/state');
const { readStdin } = require('../hooks/lib/stdin');
const { liveArm } = require('../hooks/lib/live');
const { userPrompt, writeTranscript } = require('./fixtures/transcript');
const { STDIN_CASES } = require('./fixtures/stdin-cases');
const home = os.homedir().replace(/\\/g, '/');

for (const c of STDIN_CASES) test(`T27 readStdin: ${c.name}`, async () => {
  const s = new PassThrough(), t0 = Date.now(), p = readStdin(s, c.capMs);
  for (const ch of c.chunks) s.write(ch);
  if (c.end) s.end();
  assert.equal(await p, c.expect);
  const ms = Date.now() - t0;
  assert.ok(ms <= c.maxMs && ms >= (c.minMs ?? 0), `${ms} ms`);
});
test('T27 envFrom fields, and a throw without CLAUDE_PLUGIN_DATA', () => {
  assert.deepEqual(S.envFrom({ CLAUDE_PLUGIN_DATA: tmp, MIDAS_SDLC_WORKROOT: work }, { scratchpad_dir: 'C:/s' }),
    { dataDir: tmp, workspace: 'C:/dev/Projects/BigChange', workRoot: work, harness: 'C:/dev/Projects/BigChange/midas-harness', home, scratchpad: 'C:/s' });
  assert.equal(S.envFrom({ CLAUDE_PLUGIN_DATA: tmp }, {}).workRoot, 'C:/dev/Projects/BigChange/work');
  assert.equal(S.envFrom({ CLAUDE_PLUGIN_DATA: tmp }, {}).scratchpad, null);
  assert.throws(() => S.envFrom({}, {}), /CLAUDE_PLUGIN_DATA/);
});
test('T27 envFrom refuses the real data folder under NODE_TEST_CONTEXT', () => {
  for (const d of [`${home}/.claude/plugins/data/midas-sdlc-midas-harness`, `${home}/.claude/plugins/data/x`.replace(/\//g, '\\').toUpperCase()])
    assert.throws(() => S.envFrom({ CLAUDE_PLUGIN_DATA: d, NODE_TEST_CONTEXT: 'child' }, {}), /real plugin data/);
});
test('T27 writeArm renames atomically; readArm and deleteArm', () => {
  S.writeArm(tmp, ARM); S.writeArm(tmp, { ...ARM, prompt_id: 'p2' });
  assert.deepEqual(fs.readdirSync(tmp), ['arm-s1.json']);
  assert.equal(S.readArm(tmp, 's1').prompt_id, 'p2');
  fs.writeFileSync(path.join(tmp, 'arm-s3.json'), '{');
  assert.equal(S.readArm(tmp, 's3'), null); assert.equal(S.readArm(tmp, 's4'), null);
  S.deleteArm(tmp, 's1'); S.deleteArm(tmp, 's1');
  assert.equal(S.readArm(tmp, 's1'), null);
});
test('T27 an arm from writeArm is live through live.liveArm', () => {
  S.writeArm(tmp, ARM);
  assert.deepEqual(liveArm({ session_id: 's1', prompt_id: 'p1', transcript_path: writeTranscript(tmp2, [userPrompt('p1', ARM.answer)]) }, { dataDir: tmp }), ARM);
});
test('T13 readLedger ignores a torn final line and throws on a bad complete line', () => {
  fs.writeFileSync(path.join(tmp, 'ledger.jsonl'), JSON.stringify(LINE) + '\n{"prompt_id":"p');
  assert.deepEqual(S.readLedger(tmp), [LINE]);
  fs.writeFileSync(path.join(tmp, 'ledger.jsonl'), JSON.stringify(LINE) + '\nnot json\n');
  assert.throws(() => S.readLedger(tmp), /ledger\.jsonl line 2/);
  assert.deepEqual(S.readLedger(emptyDir), []);
});
test('T13 appendLedger dedupes on the exact line and never joins a torn line', () => {
  assert.deepEqual(S.appendLedger(tmp, [LINE, LINE2]), [LINE, LINE2]);
  assert.deepEqual(S.appendLedger(tmp, [LINE, LINE2]), []);
  fs.appendFileSync(path.join(tmp, 'ledger.jsonl'), '{"torn');
  S.appendLedger(tmp, [LINE3]);
  assert.throws(() => S.readLedger(tmp), /ledger\.jsonl line 3/);
});
test('T13 two writers append the same lines without corruption', async () => {
  const lines = Array.from({ length: 100 }, (_, i) => ({ prompt_id: `p${i}`, kind: 'take', value: '999999002', origin: 'human' }));
  const code = 'require(process.argv[1]).appendLedger(process.argv[2], JSON.parse(process.argv[3]))';
  const env = { CLAUDE_PLUGIN_DATA: tmp, MIDAS_SDLC_WORKROOT: work, SystemRoot: process.env.SystemRoot };
  const one = () => new Promise((r) => spawn(process.execPath, ['-e', code, STATE, tmp, JSON.stringify(lines)], { env }).on('exit', r));
  assert.deepEqual(await Promise.all([one(), one()]), [0, 0]);
  const got = S.readLedger(tmp).map((l) => JSON.stringify(l));
  for (const l of lines) assert.ok(got.includes(JSON.stringify(l)));
  assert.deepEqual(S.appendLedger(tmp, lines), []);
});
test('T13 appendGatesLog refuses the real work folder under NODE_TEST_CONTEXT', () => {
  // fs is stubbed so a regression of the check can never touch the real folder.
  const mkdir = fs.mkdirSync, app = fs.appendFileSync; let writes = 0;
  fs.mkdirSync = () => { writes++; }; fs.appendFileSync = () => { writes++; };
  try {
    for (const root of ['C:\\DEV\\Projects\\BigChange\\work', 'C:/dev/Projects/BigChange/work//', 'C:/dev/Projects/BigChange/work/.', 'C:/dev/Projects/BigChange/./work'])
      assert.throws(() => S.appendGatesLog(root, '999999001', [LINE]), /real work folder/, root);
  } finally { fs.mkdirSync = mkdir; fs.appendFileSync = app; }
  assert.equal(writes, 0);
});
test('T27 readLast and writeLast round-trip, and a bad session_id throws', () => {
  assert.equal(S.readLast(tmp, 's1'), null);
  S.writeLast(tmp, 's1', 'p9'); assert.equal(S.readLast(tmp, 's1'), 'p9');
  assert.deepEqual(fs.readdirSync(tmp), ['last-s1.txt']);
  assert.throws(() => S.writeLast(tmp, '../x', 'p'));
  fs.writeFileSync(path.join(tmp, 'last-s2.txt'), 'p7\n'); assert.equal(S.readLast(tmp, 's2'), 'p7');
  fs.mkdirSync(path.join(tmp, 'last-s3.txt')); assert.throws(() => S.readLast(tmp, 's3'));
});
test('T13 appendGatesLog format', () => {
  S.appendGatesLog(work, '999999001', [{ prompt_id: 'p1', kind: 'skip', value: 'G3 999999001: small change', origin: 'human' }], new Date('2026-11-12T09:00:00Z'));
  assert.equal(fs.readFileSync(path.join(work, '999999001', 'gates.log'), 'utf8'), '2026-11-12T09:00:00.000Z skip G3 999999001: small change (human)\n');
});
