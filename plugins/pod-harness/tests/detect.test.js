'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tempDir, makeRepo } = require('./helpers');
const { run, runShell } = require('../scripts/lib/run.js');
const { normalizeRemote, detectRepos, dedupeRepos, matchRepos } = require('../scripts/lib/detect.js');

test('run and runShell report exit code, output and a timeout', async () => {
  assert.equal(run('node', ['-e', 'process.exit(3)']).code, 3);
  assert.equal((await runShell('node -e "console.log(41+1)"')).stdout.trim(), '42');
  assert.equal(run('node', ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 200 }).timedOut, true);
  const missing = run('no-such-program-pod-harness', []);
  assert.notEqual(missing.code, 0);
  assert.equal(missing.timedOut, false);
});

test('normalizeRemote makes one id from every spelling', async () => {
  for (const u of ['https://dev.azure.com/Org/Proj/_git/App', 'https://user@dev.azure.com/org/proj/_git/app.git', 'https://dev.azure.com/org/proj/_git/app/']) {
    assert.equal(normalizeRemote(u), 'dev.azure.com/org/proj/_git/app');
  }
  assert.equal(normalizeRemote('git@github.com:Org/Repo.git'), 'github.com/org/repo');
  assert.equal(normalizeRemote('ssh://git@github.com/Org/Repo.git'), 'github.com/org/repo');
});

test('normalizeRemote makes one id from every Azure DevOps spelling', async () => {
  for (const u of [
    'git@ssh.dev.azure.com:v3/Org/Proj/App',
    'ssh://git@ssh.dev.azure.com:22/v3/Org/Proj/App',
    'Org@vs-ssh.visualstudio.com:v3/Org/Proj/App',
    'https://org.visualstudio.com/Proj/_git/App',
    'https://org.visualstudio.com/DefaultCollection/Proj/_git/App',
    'https://dev.azure.com:443/Org/Proj/_git/App',
  ]) assert.equal(normalizeRemote(u), 'dev.azure.com/org/proj/_git/app', u);
});

test('two folders with the same remote: the main clone is kept, the linked worktree is reported', async () => {
  const ws = tempDir();
  const main = makeRepo(ws, 'zmain', { remote: 'git@github.com:Org/Solo.git' });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: main, stdio: 'pipe' });
  execFileSync('git', ['worktree', 'add', '-q', path.join(ws, 'awt')], { cwd: main, stdio: 'pipe' });
  const detected = detectRepos(ws);
  assert.deepEqual(detected.map((r) => [r.name, r.linked]), [['awt', true], ['zmain', false]]);
  const { repos, duplicates } = dedupeRepos(detected);
  assert.deepEqual(repos.map((r) => r.path), [main]);
  assert.deepEqual(duplicates, [{ id: 'github.com/org/solo', kept: main, ignored: [path.join(ws, 'awt')] }]);
  const m = matchRepos([{ id: 'github.com/org/solo' }], detected);
  assert.deepEqual([m.matched, m.duplicates], [[{ id: 'github.com/org/solo', path: main }], duplicates]);
});

test('two full clones of one remote: the first by name is kept', async () => {
  const ws = tempDir();
  const a = makeRepo(ws, 'a', { remote: 'git@github.com:Org/Solo.git' });
  const b = makeRepo(ws, 'b', { remote: 'https://github.com/org/solo' });
  assert.deepEqual(dedupeRepos(detectRepos(ws)).duplicates, [{ id: 'github.com/org/solo', kept: a, ignored: [b] }]);
});

test('finds child repos in a path with a space, their remote, trunk and dotnet commands', async () => {
  const ws = tempDir();
  const app = makeRepo(ws, 'app', { remote: 'https://user@dev.azure.com/Org/Proj/_git/App.git', trunk: 'main', files: { 'App.slnx': '', 'App.sln': '', 'src/A.cs': '' } });
  fs.mkdirSync(path.join(ws, 'notes'));
  const repos = detectRepos(ws);
  assert.equal(repos.length, 1);
  assert.deepEqual(repos[0], {
    id: 'dev.azure.com/org/proj/_git/app', name: 'app', path: app, linked: false, trunk: 'main',
    build: 'dotnet build App.slnx', test: 'dotnet test App.slnx',
    specialists: [{ glob: '**', agent: 'backend' }],
  });
});

test('proposes package manager commands and "none" for a missing script', async () => {
  const ws = tempDir();
  makeRepo(ws, 'web', { files: { 'package.json': JSON.stringify({ scripts: { test: 'x' } }), 'pnpm-lock.yaml': '' } });
  makeRepo(ws, 'site', { files: { 'package.json': JSON.stringify({ scripts: { build: 'x', test: 'x' } }) } });
  const [site, web] = detectRepos(ws);
  assert.deepEqual([web.build, web.test], ['none', 'pnpm test']);
  assert.deepEqual([site.build, site.test], ['npm run build', 'npm test']);
});

test('a repo with no origin, no trunk and no build files is returned with nulls, not thrown', async () => {
  const ws = tempDir();
  makeRepo(ws, 'bare');
  const [repo] = detectRepos(ws);
  assert.deepEqual([repo.id, repo.trunk, repo.build, repo.test], [null, null, null, null]);
});

test('a folder that is itself a repo returns that one repo', async () => {
  const ws = tempDir();
  const dir = makeRepo(ws, 'solo', { remote: 'git@github.com:Org/Solo.git' });
  makeRepo(dir, 'nested');
  const repos = detectRepos(dir);
  assert.deepEqual(repos.map((r) => r.id), ['github.com/org/solo']);
});

test('specialists: sql, then frontend, then backend; frontend-only repos end with frontend', async () => {
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

test('matchRepos splits matched, not cloned and extra', async () => {
  const m = matchRepos([{ id: 'h/a' }, { id: 'h/b' }], [{ id: 'h/a', path: 'C:/w s/a' }, { id: 'h/z', path: 'C:/w s/z' }, { id: null, path: 'C:/w s/n' }]);
  assert.deepEqual(m.matched, [{ id: 'h/a', path: 'C:/w s/a' }]);
  assert.deepEqual(m.notCloned, ['h/b']);
  assert.deepEqual(m.extra.map((r) => r.path), ['C:/w s/z', 'C:/w s/n']);
});

test('a solution name with a space is quoted', async () => {
  const dir = makeRepo(tempDir(), 'spaced', { files: { 'My App.sln': '' } });
  const [found] = detectRepos(dir);
  assert.deepEqual([found.build, found.test], ['dotnet build "My App.sln"', 'dotnet test "My App.sln"']);
});
