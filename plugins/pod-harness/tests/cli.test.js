'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, tempHome, fixture, makeRepo } = require('./helpers');
const { readLayer } = require('../scripts/lib/store.js');
const { COMMANDS, main } = require('../scripts/cli.js');

const SOLO = 'github.com/org/solo';

// Runs one CLI command against a temp home and returns its exit code and parsed output.
function cli(h, ...argv) {
  let text = '';
  const code = main(argv, { env: h.env, stdout: { write: (s) => { text += s; } }, cwd: h.dir });
  return { code, out: JSON.parse(text) };
}

const POD = JSON.stringify({ name: 'example', tracker: { type: 'none' } });
const repo = (extra = {}) => JSON.stringify([{ id: SOLO, name: 'Solo', trunk: 'main', build: 'none', test: 'none', ...extra }]);

function ready() {
  const h = tempHome();
  cli(h, 'init', 'example');
  cli(h, 'set', 'base', 'Pod', POD);
  cli(h, 'set', 'base', 'Repos', repo());
  return h;
}

test('COMMANDS lists the ten commands', () => {
  assert.deepEqual(COMMANDS, ['env-check', 'init', 'detect', 'match', 'import', 'export', 'show', 'set', 'prove', 'doctor']);
});

test('init, set, show round trip', () => {
  const h = tempHome();
  assert.deepEqual(cli(h, 'init', 'example'), { code: 0, out: { pod: 'example', home: h.dir } });
  assert.deepEqual(cli(h, 'set', 'base', 'Pod', POD), { code: 0, out: { ok: true, problems: [] } });
  const shown = cli(h, 'show').out;
  assert.equal(shown.pod, 'example');
  assert.equal(shown.config.pod.name, 'example');
  assert.equal(shown.config.approvals.plan, true);
});

test('set reports the problems of the section it changed', () => {
  const h = ready();
  const { out } = cli(h, 'set', 'personal', 'Approvals', '{"plan":"yes"}');
  assert.deepEqual(out.problems.map((p) => p.path), ['approvals.plan']);
});

test('set reads the patch from a file when the argument starts with @', () => {
  const h = ready();
  const file = path.join(tempDir(), 'patch.json');
  fs.writeFileSync(file, '{"plan":false}');
  assert.equal(cli(h, 'set', 'personal', 'Approvals', `@${file}`).code, 0);
  assert.equal(cli(h, 'show').out.config.approvals.plan, false);
});

test('set base with a personal-only key prints error personal-only and returns 1', () => {
  const h = ready();
  const r = cli(h, 'set', 'base', 'Repos', repo({ path: 'C:/src/solo' }));
  assert.equal(r.code, 1);
  assert.equal(r.out.error.code, 'personal-only');
});

test('broken JSON, an unknown heading and an unknown command are errors, not crashes', () => {
  const h = ready();
  assert.equal(cli(h, 'set', 'personal', 'Approvals', '{plan}').out.error.code, 'bad-json');
  assert.equal(cli(h, 'set', 'personal', 'Budgets', '{}').out.error.code, 'unknown-heading');
  const r = cli(h, 'explode');
  assert.deepEqual([r.code, r.out.error.code], [1, 'unknown-command']);
});

test('a command with no active pod prints error no-pod', () => {
  const h = tempHome();
  for (const command of ['show', 'doctor', 'match', 'export', 'set', 'prove']) {
    const r = cli(h, command, 'x', 'y', '{}');
    assert.deepEqual([command, r.code, r.out.error.code], [command, 1, 'no-pod']);
  }
  assert.equal(cli(h, 'env-check').code, 0);
});

test('detect and match find a cloned repo by its remote', () => {
  const h = ready();
  const ws = tempDir();
  const dir = makeRepo(ws, 'solo', { remote: 'git@github.com:Org/Solo.git' });
  makeRepo(ws, 'other', { remote: 'git@github.com:Org/Other.git' });
  assert.deepEqual(cli(h, 'detect', ws).out.repos.map((r) => r.id), ['github.com/org/other', SOLO]);
  const m = cli(h, 'match', ws).out;
  assert.deepEqual(m.matched, [{ id: SOLO, path: dir }]);
  assert.deepEqual(m.notCloned, []);
  assert.deepEqual(m.extra.map((r) => r.id), ['github.com/org/other']);
});

test('import through the CLI makes the pod active, and export writes the base back out', () => {
  const h = tempHome();
  const file = path.join(tempDir(), 'base.md');
  fs.writeFileSync(file, fixture('base-example.md'));
  assert.deepEqual(cli(h, 'import', file).out, { pod: 'example', problems: [] });
  const out = path.join(tempDir(), 'out.md');
  assert.deepEqual(cli(h, 'export', out), { code: 0, out: { path: out } });
  assert.equal(fs.readFileSync(out, 'utf8'), fixture('base-example.md'));
});

test('prove stores the proof in the personal layer', () => {
  const h = ready();
  cli(h, 'set', 'personal', 'Repos', JSON.stringify([{ id: SOLO, path: tempDir() }]));
  const r = cli(h, 'prove', SOLO);
  assert.deepEqual([r.code, r.out.build, r.out.test], [0, 'none', 'none']);
  const proof = readLayer('example', 'personal', h.env).sections.Repos[0].proof;
  assert.deepEqual([proof.build, proof.test, proof.at], ['none', 'none', r.out.at]);
  assert.equal(cli(h, 'prove', 'no/such/repo').out.error.code, 'no-repo');
});

test('doctor lists what differs from the base and never lists a local path', () => {
  const h = ready();
  cli(h, 'set', 'personal', 'Repos', JSON.stringify([{ id: SOLO, path: tempDir() }]));
  cli(h, 'set', 'personal', 'Reports', '{"work_dir":"C:/w s/work"}');
  cli(h, 'set', 'personal', 'Approvals', '{"plan":false}');
  const { code, out } = cli(h, 'doctor');
  assert.equal(code, 0);
  assert.deepEqual(out.differs, [{ path: 'approvals.plan', from: true, to: false }]);
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.environment.map((c) => c.name), ['node', 'git', 'spawn-depth', 'subagent-model']);
  assert.deepEqual(out.access.map((c) => c.name), ['remote:Solo']);
});
