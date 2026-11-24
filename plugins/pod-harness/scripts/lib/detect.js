'use strict';
const fs = require('node:fs');
const path = require('node:path');
const runner = require('./run.js');

const SKIP = new Set(['.git', 'node_modules', 'bin', 'obj', 'dist']);
const FRONTEND = new Set(['.tsx', '.jsx', '.vue', '.css', '.scss']);
const BACKEND = new Set(['.cs', '.go', '.py', '.java', '.rb', '.php', '.vb', '.fs']);
const FRONTEND_GLOB = '**/*.{tsx,jsx,vue,css,scss}';

// One id for every way of writing the same remote: host/path, lower case.
function normalizeRemote(url) {
  let s = String(url).trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '').replace(/^([^/:]+):\d+(?=\/)/, '$1');
  } else {
    s = s.replace(/^[^@/]+@/, '').replace(':', '/'); // git@host:org/repo
  }
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
  // Azure DevOps writes one repo several ways: SSH (v3/org/project/repo) and the old org.visualstudio.com host.
  const ssh = /^(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(s);
  if (ssh) return `dev.azure.com/${ssh[1]}/${ssh[2]}/_git/${ssh[3]}`;
  const old = /^([^./]+)\.visualstudio\.com\/(?:defaultcollection\/)?(.+)$/.exec(s);
  if (old) return `dev.azure.com/${old[1]}/${old[2]}`;
  return s;
}

function proposeCommands(dir) {
  const files = fs.readdirSync(dir).sort();
  const solution = files.find((f) => f.endsWith('.slnx')) || files.find((f) => f.endsWith('.sln'));
  if (solution) {
    const file = solution.includes(' ') ? `"${solution}"` : solution;
    return { build: `dotnet build ${file}`, test: `dotnet test ${file}` };
  }
  if (files.includes('package.json')) {
    let scripts = {};
    try {
      scripts = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts || {};
    } catch { /* an unreadable package.json proposes "none" for both */ }
    const manager = files.includes('pnpm-lock.yaml') ? 'pnpm' : files.includes('yarn.lock') ? 'yarn' : 'npm';
    return { build: scripts.build ? `${manager} run build` : 'none', test: scripts.test ? `${manager} test` : 'none' };
  }
  return { build: null, test: null };
}

function extensions(dir, depth, found = new Set()) {
  if (depth === 0) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) extensions(path.join(dir, entry.name), depth - 1, found);
    } else {
      found.add(path.extname(entry.name).toLowerCase());
    }
  }
  return found;
}

function proposeSpecialists(dir) {
  const found = extensions(dir, 4);
  const has = (set) => [...set].some((ext) => found.has(ext));
  const frontend = has(FRONTEND);
  const backend = has(BACKEND);
  const out = [];
  if (found.has('.sql')) out.push({ glob: '**/*.sql', agent: 'database' });
  if (frontend && backend) out.push({ glob: FRONTEND_GLOB, agent: 'frontend' });
  out.push({ glob: '**', agent: frontend && !backend ? 'frontend' : 'backend' });
  return out;
}

function describe(dir, run) {
  const git = (...args) => run('git', ['-C', dir, ...args], { timeoutMs: 20000 });
  const remote = git('remote', 'get-url', 'origin');
  const head = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  return {
    id: remote.code === 0 && remote.stdout.trim() ? normalizeRemote(remote.stdout) : null,
    name: path.basename(dir),
    path: dir,
    linked: fs.statSync(path.join(dir, '.git')).isFile(), // a linked worktree or submodule, not the main clone
    trunk: head.code === 0 && head.stdout.trim() ? head.stdout.trim().replace(/^origin\//, '') : null,
    ...proposeCommands(dir),
    specialists: proposeSpecialists(dir),
  };
}

const isRepo = (dir) => fs.existsSync(path.join(dir, '.git'));

// dir is either one repo or a folder whose direct children are repos.
function detectRepos(dir, opts = {}) {
  const run = opts.run || runner.run;
  const dirs = isRepo(dir)
    ? [dir]
    : fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name)).filter(isRepo).sort();
  return dirs.map((d) => describe(d, run));
}

// Two folders can hold the same remote (a linked worktree beside its main clone). Keeps one per remote:
// the main clone if there is one, else the first by name. Says which folders it left out.
function dedupeRepos(detected) {
  const duplicates = [];
  const ignored = new Set();
  for (const id of new Set(detected.map((d) => d.id).filter((x) => x !== null))) {
    const group = detected.filter((d) => d.id === id);
    if (group.length < 2) continue;
    const kept = group.find((d) => !d.linked) || group[0];
    const rest = group.filter((d) => d !== kept);
    rest.forEach((d) => ignored.add(d));
    duplicates.push({ id, kept: kept.path, ignored: rest.map((d) => d.path) });
  }
  return { repos: detected.filter((d) => !ignored.has(d)), duplicates };
}

function matchRepos(configRepos, detected) {
  const { repos, duplicates } = dedupeRepos(detected);
  const ids = new Set((configRepos || []).map((r) => r.id));
  const cloned = new Map(repos.filter((d) => d.id !== null).map((d) => [d.id, d]));
  return {
    matched: [...ids].filter((id) => cloned.has(id)).map((id) => ({ id, path: cloned.get(id).path })),
    notCloned: [...ids].filter((id) => !cloned.has(id)),
    extra: repos.filter((d) => d.id === null || !ids.has(d.id)),
    duplicates,
  };
}

module.exports = { normalizeRemote, detectRepos, dedupeRepos, matchRepos };
