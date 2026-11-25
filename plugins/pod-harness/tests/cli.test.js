'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tempDir, tempHome, fixture, makeRepo } = require('./helpers');
const { readLayer } = require('../scripts/lib/store.js');
const { COMMANDS, main } = require('../scripts/cli.js');

const SOLO = 'github.com/org/solo';

// Runs one CLI command against a temp home and returns its exit code and parsed output.
async function cli(h, ...argv) {
  let text = '';
  const code = await main(argv, { env: h.env, stdout: { write: (s) => { text += s; } }, cwd: h.dir });
  return { code, out: JSON.parse(text) };
}

const POD = JSON.stringify({ name: 'example', tracker: { type: 'none' } });
const repo = (extra = {}) => JSON.stringify([{ id: SOLO, name: 'Solo', trunk: 'main', build: 'none', test: 'none', ...extra }]);

async function ready() {
  const h = tempHome();
  await cli(h, 'init', 'example');
  await cli(h, 'set', 'base', 'Pod', POD);
  await cli(h, 'set', 'base', 'Repos', repo());
  return h;
}

test('COMMANDS lists the eleven commands', async () => {
  assert.deepEqual(COMMANDS, ['env-check', 'init', 'detect', 'match', 'import', 'export', 'show', 'set', 'prove', 'doctor', 'trivial-count']);
});

test('init, set, show round trip', async () => {
  const h = tempHome();
  assert.deepEqual((await cli(h, 'init', 'example')), { code: 0, out: { pod: 'example', home: h.dir } });
  assert.deepEqual((await cli(h, 'set', 'base', 'Pod', POD)), { code: 0, out: { ok: true, problems: [] } });
  const shown = (await cli(h, 'show')).out;
  assert.equal(shown.pod, 'example');
  assert.equal(shown.config.pod.name, 'example');
  assert.equal(shown.config.approvals.plan, true);
});

test('set reports the problems of the section it changed', async () => {
  const h = await ready();
  const { out } = await cli(h, 'set', 'personal', 'Approvals', '{"plan":"yes"}');
  assert.deepEqual(out.problems.map((p) => p.path), ['approvals.plan']);
});

test('set reads the patch from a file when the argument starts with @', async () => {
  const h = await ready();
  const file = path.join(tempDir(), 'patch.json');
  fs.writeFileSync(file, '{"plan":false}');
  assert.equal((await cli(h, 'set', 'personal', 'Approvals', `@${file}`)).code, 0);
  assert.equal((await cli(h, 'show')).out.config.approvals.plan, false);
});

test('set base with a personal-only key prints error personal-only and returns 1', async () => {
  const h = await ready();
  const r = await cli(h, 'set', 'base', 'Repos', repo({ path: 'C:/src/solo' }));
  assert.equal(r.code, 1);
  assert.equal(r.out.error.code, 'personal-only');
});

test('broken JSON, an unknown heading and an unknown command are errors, not crashes', async () => {
  const h = await ready();
  assert.equal((await cli(h, 'set', 'personal', 'Approvals', '{plan}')).out.error.code, 'bad-json');
  assert.equal((await cli(h, 'set', 'personal', 'Budgets', '{}')).out.error.code, 'unknown-heading');
  const r = await cli(h, 'explode');
  assert.deepEqual([r.code, r.out.error.code], [1, 'unknown-command']);
});

test('a command with no active pod prints error no-pod', async () => {
  const h = tempHome();
  for (const command of ['show', 'doctor', 'match', 'export', 'set', 'prove']) {
    const r = await cli(h, command, 'x', 'y', '{}');
    assert.deepEqual([command, r.code, r.out.error.code], [command, 1, 'no-pod']);
  }
  assert.equal((await cli(h, 'env-check')).code, 0);
});

test('detect and match find a cloned repo by its remote', async () => {
  const h = await ready();
  const ws = tempDir();
  const dir = makeRepo(ws, 'solo', { remote: 'git@github.com:Org/Solo.git' });
  makeRepo(ws, 'other', { remote: 'git@github.com:Org/Other.git' });
  assert.deepEqual((await cli(h, 'detect', ws)).out.repos.map((r) => r.id), ['github.com/org/other', SOLO]);
  const m = (await cli(h, 'match', ws)).out;
  assert.deepEqual(m.matched, [{ id: SOLO, path: dir }]);
  assert.deepEqual(m.notCloned, []);
  assert.deepEqual(m.extra.map((r) => r.id), ['github.com/org/other']);
});

test('import through the CLI makes the pod active, and export writes the base back out', async () => {
  const h = tempHome();
  const file = path.join(tempDir(), 'base.md');
  fs.writeFileSync(file, fixture('base-example.md'));
  assert.deepEqual((await cli(h, 'import', file)).out, { pod: 'example', problems: [] });
  const out = path.join(tempDir(), 'out.md');
  assert.deepEqual((await cli(h, 'export', out)), { code: 0, out: { path: out } });
  assert.equal(fs.readFileSync(out, 'utf8'), fixture('base-example.md'));
});

test('prove stores the proof in the personal layer', async () => {
  const h = await ready();
  await cli(h, 'set', 'personal', 'Repos', JSON.stringify([{ id: SOLO, path: tempDir() }]));
  const r = await cli(h, 'prove', SOLO);
  assert.deepEqual([r.code, r.out.build, r.out.test], [0, 'none', 'none']);
  const proof = readLayer('example', 'personal', h.env).sections.Repos[0].proof;
  assert.deepEqual([proof.build, proof.test, proof.at], ['none', 'none', r.out.at]);
  assert.equal((await cli(h, 'prove', 'no/such/repo')).out.error.code, 'no-repo');
});

test('show says whether this machine wrote the base or imported it', async () => {
  assert.equal((await cli((await ready()), 'show')).out.role, 'author');
  const h = tempHome();
  const file = path.join(tempDir(), 'base.md');
  fs.writeFileSync(file, fixture('base-example.md'));
  await cli(h, 'import', file);
  assert.equal((await cli(h, 'show')).out.role, 'member');
});

test('set refuses a webhook URL and stores nothing', async () => {
  const h = await ready();
  const r = await cli(h, 'set', 'base', 'Delivery', '{"webhooks":[{"id":"teams","env":"https://example.invalid/SECRET"}]}');
  assert.deepEqual([r.code, r.out.error.code], [1, 'secret']);
  assert.equal(readLayer('example', 'base', h.env).sections.Delivery, undefined);
});

test('set reads an @file that starts with a byte-order mark', async () => {
  const h = await ready();
  const file = path.join(tempDir(), 'patch.json');
  fs.writeFileSync(file, '﻿{"plan":false}');
  assert.equal((await cli(h, 'set', 'personal', 'Approvals', `@${file}`)).code, 0);
});

test('a leftover personal repo is reported once and used by nothing', async () => {
  const h = await ready();
  await cli(h, 'set', 'personal', 'Repos', JSON.stringify([{ id: 'h/gone', path: tempDir() }]));
  const { out } = await cli(h, 'doctor');
  assert.deepEqual(out.problems.map((p) => [p.path, p.level]), [['repos[h/gone]', 'info'], [`repos[${SOLO}].path`, 'info']]); // Solo is set up but not cloned here
  assert.deepEqual(out.access, []);
  assert.deepEqual((await cli(h, 'show')).out.config.repos.map((r) => r.id), [SOLO]);
  assert.deepEqual((await cli(h, 'match', tempDir())).out.notCloned, [SOLO]);
  assert.equal((await cli(h, 'prove', 'h/gone')).out.error.code, 'no-repo');
});

test('a personal file with wrongly shaped settings is reported by doctor, not a crash', async () => {
  const h = await ready();
  const file = path.join(h.dir, 'example', 'personal.md');
  fs.appendFileSync(file, '\n# Repos\n\n```json\n{}\n```\n\n# Approvals\n\n```json\n[]\n```\n');
  const r = await cli(h, 'doctor');
  assert.equal(r.code, 0);
  assert.deepEqual(r.out.problems.filter((p) => p.level === 'error').map((p) => p.path).slice(0, 2), ['repos', 'approvals']);
});

test('detect reports two folders with the same remote', async () => {
  const h = await ready();
  const ws = tempDir();
  const a = makeRepo(ws, 'a', { remote: 'git@github.com:Org/Solo.git' });
  const b = makeRepo(ws, 'b', { remote: 'git@github.com:Org/Solo.git' });
  const { out } = await cli(h, 'detect', ws);
  assert.deepEqual(out.repos.map((r) => r.path), [a]);
  assert.deepEqual(out.duplicates, [{ id: SOLO, kept: a, ignored: [b] }]);
});

test('doctor lists what differs from the base and never lists a local path', async () => {
  const h = await ready();
  await cli(h, 'set', 'personal', 'Repos', JSON.stringify([{ id: SOLO, path: tempDir() }]));
  await cli(h, 'set', 'personal', 'Reports', '{"work_dir":"C:/w s/work"}');
  await cli(h, 'set', 'personal', 'Approvals', '{"plan":false}');
  const { code, out } = await cli(h, 'doctor');
  assert.equal(code, 0);
  assert.deepEqual(out.differs, [{ path: 'approvals.plan', from: true, to: false }]);
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.environment.map((c) => c.name), ['node', 'git', 'spawn-depth', 'subagent-model', 'claude-code']);
  assert.deepEqual(out.access.map((c) => c.name), ['remote:Solo']);
});

test('trivial-count counts tracked files per glob without regard to case', async () => {
  const h = await ready();
  const dir = makeRepo(tempDir(), 'solo', { files: { 'db/Migrations/1.sql': 'select 1;', 'src/a.cs': '', 'untracked.sql': '' } });
  execFileSync('git', ['add', 'db', 'src'], { cwd: dir });
  await cli(h, 'set', 'personal', 'Repos', JSON.stringify([{ id: SOLO, path: dir }]));
  await cli(h, 'set', 'personal', 'Trivial', '{"never":["**/migrations/**","**/*.SQL","**/*.tf"]}');
  assert.deepEqual((await cli(h, 'trivial-count')).out, { counts: [
    { glob: '**/migrations/**', repo: 'Solo', files: 1 },
    { glob: '**/*.SQL', repo: 'Solo', files: 1 },
    { glob: '**/*.tf', repo: 'Solo', files: 0 },
  ] });
});

test('main returns a promise of the exit code', async () => {
  const pending = main(['env-check'], { env: {}, stdout: { write: () => {} }, cwd: '.' });
  assert.ok(pending instanceof Promise);
  assert.equal(await pending, 0);
});

test('a broken personal.md is named in the error', async () => {
  const h = await ready();
  fs.writeFileSync(path.join(h.dir, 'example', 'personal.md'), 'not a settings file');
  const r = await cli(h, 'show');
  assert.deepEqual([r.code, r.out.error.code, r.out.error.file], [1, 'no-frontmatter', 'personal.md']);
  assert.ok(r.out.error.message.startsWith('personal.md: '));
});

test('export refuses to overwrite, and --force overwrites', async () => {
  const h = await ready();
  const out = path.join(tempDir(), 'out.md');
  fs.writeFileSync(out, 'mine');
  const r = await cli(h, 'export', out);
  assert.deepEqual([r.code, r.out.error.code], [1, 'exists']);
  assert.equal(fs.readFileSync(out, 'utf8'), 'mine');
  assert.equal((await cli(h, 'export', out, '--force')).code, 0);
  assert.notEqual(fs.readFileSync(out, 'utf8'), 'mine');
});

test('differs shows a personal-only repo without its path', async () => {
  const h = await ready();
  await cli(h, 'set', 'personal', 'Repos', JSON.stringify([{ id: 'h/gone', path: tempDir(), proof: { build: 'pass' }, trunk: 'main' }]));
  const { out } = await cli(h, 'doctor');
  assert.deepEqual(out.differs, [{ path: 'repos[h/gone]', to: { id: 'h/gone', trunk: 'main' } }]);
});
