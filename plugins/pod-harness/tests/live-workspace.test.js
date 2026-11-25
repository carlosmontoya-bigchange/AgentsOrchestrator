'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, git } = require('./helpers');
const { detectRepos } = require('../scripts/lib/detect.js');
const { makeWorkspace } = require('./live/make-workspace.js');

test('the live-check workspace has the three repos the live checks expect', () => {
  const dir = tempDir();
  makeWorkspace(dir);
  const [app, broken, web] = detectRepos(dir);
  assert.deepEqual([app.id, app.trunk, app.build, app.test], ['dev.azure.com/example/p/_git/app', 'main', 'dotnet build App.slnx', 'dotnet test App.slnx']);
  assert.deepEqual(app.specialists.map((s) => s.agent), ['database', 'backend']);
  assert.deepEqual([web.id, web.trunk, web.build, web.test], ['github.com/example/web', 'main', 'pnpm run build', 'pnpm test']);
  assert.deepEqual(web.specialists, [{ glob: '**', agent: 'frontend' }]);
  assert.deepEqual([broken.id, broken.trunk, broken.build, broken.test], ['github.com/example/broken', 'main', 'none', 'npm test']);
});

test('a task can start in each live repo: one commit on main, a trunk to branch from, nothing uncommitted', () => {
  const dir = tempDir();
  makeWorkspace(dir);
  const out = (repo, ...args) => String(git(path.join(dir, repo), ...args)).trim();
  for (const repo of ['app', 'broken', 'web']) {
    assert.equal(out(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', repo);
    assert.equal(out(repo, 'rev-parse', 'origin/main'), out(repo, 'rev-parse', 'HEAD'), repo);
    assert.equal(out(repo, 'status', '--porcelain'), '', repo);
  }
  // Running the commands of these two leaves node_modules behind. It must not count as the task's change.
  for (const repo of ['broken', 'web']) assert.equal(out(repo, 'check-ignore', 'node_modules/x'), 'node_modules/x', repo);
});

test('the web repo has a greeting with a test that passes, and the broken repo has a test that fails', () => {
  const dir = tempDir();
  makeWorkspace(dir);
  assert.equal(require(path.join(dir, 'web', 'src', 'greeting.js')).greeting(), 'hello');
  assert.ok(fs.readFileSync(path.join(dir, 'web', 'tests', 'greeting.test.js'), 'utf8').includes('node:test'));
  const scripts = (repo) => JSON.parse(fs.readFileSync(path.join(dir, repo, 'package.json'), 'utf8')).scripts;
  assert.deepEqual(scripts('web'), { build: 'node -e ""', test: 'node --test' });
  assert.deepEqual(scripts('broken'), { test: 'node -e "process.exit(1)"' });
});

// The first pnpm run rewrites the lock file. A tracked one made the repo dirty on main, and a task then refused to start.
test('a first pnpm run leaves web clean: its lock file is on disk for detection and ignored by git', () => {
  const dir = tempDir();
  makeWorkspace(dir);
  const web = path.join(dir, 'web');
  assert.ok(fs.existsSync(path.join(web, 'pnpm-lock.yaml')));
  fs.writeFileSync(path.join(web, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n');
  assert.equal(String(git(web, 'status', '--porcelain')).trim(), '');
  assert.equal(String(git(web, 'ls-files', 'pnpm-lock.yaml')).trim(), '');
  assert.equal(detectRepos(dir).find((r) => r.name === 'web').test, 'pnpm test');
});

test('the init script of app creates a table an index can be added to', () => {
  const dir = tempDir();
  makeWorkspace(dir);
  assert.match(fs.readFileSync(path.join(dir, 'app', 'db', '001_init.sql'), 'utf8'), /CREATE TABLE dbo\.Customer \(/);
});
