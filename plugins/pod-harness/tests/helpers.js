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

const APP = 'dev.azure.com/org/proj/_git/app';
const WEB = 'github.com/org/web';

// A pod "example" in a temp home with a work folder and two repos that have folders:
// App (SQL goes to the database agent, the rest to backend) and Web (frontend).
function podHome() {
  const store = require('../scripts/lib/store.js');
  const h = tempHome();
  const ws = tempDir();
  const dirs = { [APP]: path.join(ws, 'app'), [WEB]: path.join(ws, 'web') };
  const repos = [
    { id: APP, name: 'App', trunk: 'main', build: 'none', test: 'none', specialists: [{ glob: '**/*.sql', agent: 'database' }, { glob: '**', agent: 'backend' }] },
    { id: WEB, name: 'Web', trunk: 'main', build: 'none', test: 'none', specialists: [{ glob: '**', agent: 'frontend' }] },
  ];
  store.initPod('example', h.env);
  store.patchLayer('example', 'base', 'Pod', { name: 'example', tracker: { type: 'none' } }, h.env);
  store.patchLayer('example', 'base', 'Repos', repos, h.env);
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  store.patchLayer('example', 'personal', 'Repos', repos.map((r) => ({ id: r.id, path: dirs[r.id] })), h.env);
  store.patchLayer('example', 'personal', 'Reports', { work_dir: path.join(ws, 'work') }, h.env);
  return { ...h, ws, work: path.join(ws, 'work'), app: dirs[APP], web: dirs[WEB] };
}

// The configuration a command would load for that home.
function podConfig(h) {
  const store = require('../scripts/lib/store.js');
  const { sanitize } = require('../scripts/lib/validate.js');
  return sanitize(store.loadConfig('example', { env: h.env, pluginRoot }).config).config;
}

// Runs one task.js command against a temp home and returns its exit code and parsed output.
async function taskCli(h, ...argv) {
  const { main } = require('../scripts/task.js');
  let text = '';
  const code = await main(argv, { env: h.env, stdout: { write: (s) => { text += s; } }, cwd: h.dir, now: () => new Date('2026-11-24T10:00:00.000Z') });
  return { code, out: JSON.parse(text) };
}

module.exports = { pluginRoot, tempDir, tempHome, fixture, makeRepo, APP, WEB, podHome, podConfig, taskCli };
