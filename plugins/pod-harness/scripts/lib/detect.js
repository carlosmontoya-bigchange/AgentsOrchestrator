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
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '');
  } else {
    s = s.replace(/^[^@/]+@/, '').replace(':', '/'); // git@host:org/repo
  }
  return s.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
}

function proposeCommands(dir) {
  const files = fs.readdirSync(dir).sort();
  const solution = files.find((f) => f.endsWith('.slnx')) || files.find((f) => f.endsWith('.sln'));
  if (solution) return { build: `dotnet build ${solution}`, test: `dotnet test ${solution}` };
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

function matchRepos(configRepos, detected) {
  const ids = new Set((configRepos || []).map((r) => r.id));
  const cloned = new Map(detected.filter((d) => d.id !== null).map((d) => [d.id, d]));
  return {
    matched: [...ids].filter((id) => cloned.has(id)).map((id) => ({ id, path: cloned.get(id).path })),
    notCloned: [...ids].filter((id) => !cloned.has(id)),
    extra: detected.filter((d) => d.id === null || !ids.has(d.id)),
  };
}

module.exports = { normalizeRemote, detectRepos, matchRepos };
