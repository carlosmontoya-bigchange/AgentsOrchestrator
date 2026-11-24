'use strict';
// Git for the Build stage: put a repo on its task branch, and measure what changed there.
// This file only switches branches and reads. The developer's own work is never touched or thrown away.
const fs = require('node:fs');
const path = require('node:path');
const { ConfigError } = require('./configfile.js');
const runner = require('./run.js');
const { matchGlob } = require('./glob.js');

const branchName = (pattern, id) => pattern.replaceAll('{id}', id);

function prepareRepo(repo, branch, opts = {}) {
  const run = opts.run || runner.run;
  const git = (...args) => run('git', ['-C', repo.path, ...args], { timeoutMs: 120000 });
  const text = (...args) => { const r = git(...args); return r.code === 0 ? r.stdout.trim() : null; };
  const problem = (message, fix) => ({ problem: { message, fix } });
  const trunk = `origin/${repo.trunk}`;

  if (text('rev-parse', '--git-dir') === null) return problem(`${repo.name}: ${repo.path} is not a git repo.`, `Run /pod-harness:setup repo ${repo.path}.`);
  const current = text('symbolic-ref', '--short', '-q', 'HEAD') || 'a detached HEAD';
  // Where the task's work starts: everything after this commit is measured as the task's change.
  const forkPoint = () => text('merge-base', 'HEAD', trunk) || text('rev-parse', 'HEAD');
  if (current === branch) return { branch, base: forkPoint(), warnings: [] };

  const status = git('status', '--porcelain');
  if (status.code !== 0 || status.stdout.trim() !== '') {
    return problem(`${repo.name} has uncommitted changes on ${current}.`, `Commit or stash them in ${repo.path}, then continue.`);
  }
  const warnings = [];
  if (git('fetch', 'origin', repo.trunk).code !== 0) {
    warnings.push(`${repo.name}: ${repo.trunk} could not be fetched from origin. The branch starts from what was fetched last.`);
  }
  const exists = git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).code === 0;
  // --no-track: the task branch must not get the trunk as its upstream.
  const moved = exists ? git('switch', branch) : git('switch', '-c', branch, '--no-track', trunk);
  if (moved.code !== 0) {
    return problem(exists ? `${repo.name}: git could not switch to ${branch}.` : `${repo.name}: the branch ${branch} could not be created from ${trunk}.`,
      'Check the trunk name and the remote with /pod-harness:doctor, then continue.');
  }
  return { branch, base: exists ? forkPoint() : text('rev-parse', 'HEAD'), warnings };
}

const GENERATED = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'packages.lock.json', '*.lock', '*.Designer.cs', '*.g.cs', '*.generated.*', '*.min.js', '*.min.css', '*.snap']
  .map((name) => `**/${name}`);
const TEST_FOLDER = /^(test|tests|__tests__|spec|specs)$|\.(tests|test|unittests|integrationtests)$/i;
const TEST_FILE = /\.(test|spec)\.[^.]+$/i;
const TEST_SUFFIX = /Tests?\.[^.]+$/; // the capital T matters: BarTests.cs is a test, Latest.cs is not

function classify(filePath) {
  const file = String(filePath).replace(/\\/g, '/');
  if (GENERATED.some((glob) => matchGlob(glob, file))) return 'generated';
  const folders = file.split('/');
  const name = folders.pop();
  return folders.some((f) => TEST_FOLDER.test(f)) || TEST_FILE.test(name) || TEST_SUFFIX.test(name) ? 'test' : 'product';
}

function countLines(file) {
  let data;
  try {
    data = fs.readFileSync(file);
  } catch {
    return 0;
  }
  if (data.length === 0 || data.includes(0)) return 0; // empty or binary
  const text = data.toString('utf8');
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

// The working tree against the base, so committed, uncommitted and new files all count.
function measureRepo(repo, base, never, opts = {}) {
  const run = opts.run || runner.run;
  const git = (...args) => {
    const r = run('git', ['-C', repo.path, ...args], { timeoutMs: 120000 });
    if (r.code !== 0) throw new ConfigError('git-failed', `git ${args[0]} failed in ${repo.path}: ${r.stderr.trim().slice(0, 300)}`);
    return r.stdout.split('\0').filter(Boolean);
  };
  const changed = git('diff', '--numstat', '--no-renames', '-z', base).map((record) => {
    const [added, removed, file] = record.split('\t');
    return { path: file, added: Number(added) || 0, removed: Number(removed) || 0 }; // a binary file prints "-" and counts 0
  });
  const added = git('ls-files', '--others', '--exclude-standard', '-z').map((file) => ({ path: file, added: countLines(path.join(repo.path, file)), removed: 0 }));
  const files = [...changed, ...added].map((f) => ({ ...f, kind: classify(f.path) })).sort((a, b) => (a.path < b.path ? -1 : 1));
  const sum = (kind) => files.filter((f) => f.kind === kind).reduce((n, f) => n + f.added + f.removed, 0);
  return {
    files,
    product_files: files.filter((f) => f.kind === 'product').length,
    product_lines: sum('product'),
    test_lines: sum('test'),
    never: files.filter((f) => never.some((glob) => matchGlob(glob, f.path))).map((f) => f.path),
  };
}

// The measurement decides whether a task was trivial. Each failed condition is one reason, with its numbers.
function judgeTrivial(measures, trivial, sensitive) {
  const total = (key) => measures.reduce((n, m) => n + m[key], 0);
  const never = measures.flatMap((m) => m.never);
  const reasons = [];
  const limit = (count, what, max) => { if (count > max) reasons.push(`${count} ${what} changed. A trivial change has at most ${max}.`); };
  limit(total('product_files'), 'product files', trivial.max_files);
  limit(total('product_lines'), 'product lines', trivial.max_lines);
  limit(total('test_lines'), 'test lines', trivial.max_test_lines);
  if (never.length) {
    const shown = never.slice(0, 3).join(', ') + (never.length > 3 ? ` and ${never.length - 3} more` : '');
    reasons.push(`${shown} ${never.length === 1 ? 'is on a path that is' : 'are on paths that are'} never trivial.`);
  }
  if (sensitive !== 'no') reasons.push('The Build agent marked the change as sensitive, or did not say.');
  return { trivial: reasons.length === 0, reasons };
}

module.exports = { branchName, prepareRepo, classify, measureRepo, judgeTrivial };
