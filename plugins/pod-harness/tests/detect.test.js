'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, makeRepo } = require('./helpers');
const { run, runShell } = require('../scripts/lib/run.js');
const { normalizeRemote, detectRepos, matchRepos } = require('../scripts/lib/detect.js');

test('run and runShell report exit code, output and a timeout', () => {
  assert.equal(run('node', ['-e', 'process.exit(3)']).code, 3);
  assert.equal(runShell('node -e "console.log(41+1)"').stdout.trim(), '42');
  assert.equal(run('node', ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 200 }).timedOut, true);
  const missing = run('no-such-program-pod-harness', []);
  assert.notEqual(missing.code, 0);
  assert.equal(missing.timedOut, false);
});

test('normalizeRemote makes one id from every spelling', () => {
  for (const u of ['https://dev.azure.com/Org/Proj/_git/App', 'https://user@dev.azure.com/org/proj/_git/app.git', 'https://dev.azure.com/org/proj/_git/app/']) {
    assert.equal(normalizeRemote(u), 'dev.azure.com/org/proj/_git/app');
  }
  assert.equal(normalizeRemote('git@github.com:Org/Repo.git'), 'github.com/org/repo');
  assert.equal(normalizeRemote('ssh://git@github.com/Org/Repo.git'), 'github.com/org/repo');
});

test('finds child repos in a path with a space, their remote, trunk and dotnet commands', () => {
  const ws = tempDir();
  const app = makeRepo(ws, 'app', { remote: 'https://user@dev.azure.com/Org/Proj/_git/App.git', trunk: 'main', files: { 'App.slnx': '', 'App.sln': '', 'src/A.cs': '' } });
  fs.mkdirSync(path.join(ws, 'notes'));
  const repos = detectRepos(ws);
  assert.equal(repos.length, 1);
  assert.deepEqual(repos[0], {
    id: 'dev.azure.com/org/proj/_git/app', name: 'app', path: app, trunk: 'main',
    build: 'dotnet build App.slnx', test: 'dotnet test App.slnx',
    specialists: [{ glob: '**', agent: 'backend' }],
  });
});

test('proposes package manager commands and "none" for a missing script', () => {
  const ws = tempDir();
  makeRepo(ws, 'web', { files: { 'package.json': JSON.stringify({ scripts: { test: 'x' } }), 'pnpm-lock.yaml': '' } });
  makeRepo(ws, 'site', { files: { 'package.json': JSON.stringify({ scripts: { build: 'x', test: 'x' } }) } });
  const [site, web] = detectRepos(ws);
  assert.deepEqual([web.build, web.test], ['none', 'pnpm test']);
  assert.deepEqual([site.build, site.test], ['npm run build', 'npm test']);
});

test('a repo with no origin, no trunk and no build files is returned with nulls, not thrown', () => {
  const ws = tempDir();
  makeRepo(ws, 'bare');
  const [repo] = detectRepos(ws);
  assert.deepEqual([repo.id, repo.trunk, repo.build, repo.test], [null, null, null, null]);
});

test('a folder that is itself a repo returns that one repo', () => {
  const ws = tempDir();
  const dir = makeRepo(ws, 'solo', { remote: 'git@github.com:Org/Solo.git' });
  makeRepo(dir, 'nested');
  const repos = detectRepos(dir);
  assert.deepEqual(repos.map((r) => r.id), ['github.com/org/solo']);
});

test('specialists: sql, then frontend, then backend; frontend-only repos end with frontend', () => {
  const ws = tempDir();
  makeRepo(ws, 'full', { files: { 'db/a.sql': '', 'ui/b.tsx': '', 'api/c.cs': '', 'node_modules/x/y.sql': '' } });
  makeRepo(ws, 'ui', { files: { 'src/app.tsx': '', 'src/app.scss': '' } });
  makeRepo(ws, 'deps', { files: { 'node_modules/x/y.sql': '', 'main.go': '' } });
  const [deps, full, ui] = detectRepos(ws);
  assert.deepEqual(full.specialists, [
    { glob: '**/*.sql', agent: 'database' },
    { glob: '**/*.{tsx,jsx,vue,css,scss}', agent: 'frontend' },
    { glob: '**', agent: 'backend' },
  ]);
  assert.deepEqual(ui.specialists, [{ glob: '**', agent: 'frontend' }]);
  assert.deepEqual(deps.specialists, [{ glob: '**', agent: 'backend' }]);
});

test('matchRepos splits matched, not cloned and extra', () => {
  const m = matchRepos([{ id: 'h/a' }, { id: 'h/b' }], [{ id: 'h/a', path: 'C:/w s/a' }, { id: 'h/z', path: 'C:/w s/z' }, { id: null, path: 'C:/w s/n' }]);
  assert.deepEqual(m.matched, [{ id: 'h/a', path: 'C:/w s/a' }]);
  assert.deepEqual(m.notCloned, ['h/b']);
  assert.deepEqual(m.extra.map((r) => r.path), ['C:/w s/z', 'C:/w s/n']);
});
