'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const FX = path.join(__dirname, 'fixtures');
const files = (d) => fs.readdirSync(path.join(FX, d)).map((f) => path.join(FX, d, f));
const T = ['typed-then-tools', 'newer-prompt', 'background-notification', 'pasted', 'slash-command', 'artifact-comment',
  'doc-comment', 'subagent', 'wrong-platform', 'partial-last-line'];
const I = ['ups-typed', 'pre-bash', 'pre-bash-subagent', 'pre-powershell', 'pre-run-in-terminal', 'pre-ado-read',
  'post-wit-read', 'post-pr-create', 'post-wit-create', 'post-testcase-create', 'post-create-error'];

test('check3: the named fixtures exist', () => {
  for (const n of T) assert.ok(fs.existsSync(path.join(FX, 'transcripts', `${n}.jsonl`)), n);
  for (const n of I) assert.ok(fs.existsSync(path.join(FX, 'inputs', `${n}.json`)), n);
});
test('check3: every transcript line parses, except the last line of partial-last-line', () => {
  for (const f of files('transcripts')) {
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    const torn = path.basename(f) === 'partial-last-line.jsonl';
    lines.slice(0, torn ? -1 : undefined).forEach((l, i) => assert.doesNotThrow(() => JSON.parse(l), `${f}:${i + 1}`));
    if (torn) assert.throws(() => JSON.parse(lines.at(-1)));
  }
});
test('check2: every input fixture has session_id and hook_event_name', () => {
  for (const f of files('inputs')) { const j = JSON.parse(fs.readFileSync(f, 'utf8')); assert.ok(j.session_id && j.hook_event_name, f); }
});
test('R49: fixtures hold only fake uuids and fake item ids', () => {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  for (const f of [...files('transcripts'), ...files('inputs')]) {
    const s = fs.readFileSync(f, 'utf8');
    for (const [m] of s.matchAll(UUID)) assert.ok(m.startsWith('00000000-0000-4000-8000-'), `${f}: ${m}`);
    for (const [m] of s.replace(UUID, '').matchAll(/\b\d{6,9}\b/g)) assert.ok(+m >= 999999000 && +m <= 999999099, `${f}: ${m}`);
  }
});
