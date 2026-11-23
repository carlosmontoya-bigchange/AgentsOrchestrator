'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const pluginRoot = path.join(__dirname, '..');
const made = [];
process.on('exit', () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

// The folder name has a space on purpose: home folders like "C:\Users\First Last" must work.
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pod harness '));
  made.push(dir);
  return dir;
}

function tempHome() {
  const dir = tempDir();
  return { dir, env: { POD_HARNESS_HOME: dir } };
}

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });

// A real git repo in parent/name. opts: remote (origin URL), trunk (origin's default branch), files { path: content }.
function makeRepo(parent, name, opts = {}) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  if (opts.remote) git(dir, 'remote', 'add', 'origin', opts.remote);
  if (opts.trunk) git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${opts.trunk}`);
  for (const [file, content] of Object.entries(opts.files || {})) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

module.exports = { pluginRoot, tempDir, tempHome, fixture, makeRepo };
