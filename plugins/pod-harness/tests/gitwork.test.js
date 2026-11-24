'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pluginRoot, tempDir, git, clonedRepo, writeFiles, commitAll } = require('./helpers');
const { branchName, prepareRepo, classify, measureRepo, judgeTrivial } = require('../scripts/lib/gitwork.js');

const out = (dir, ...args) => String(git(dir, ...args)).trim();
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join('');
const TRIVIAL = { max_files: 3, max_lines: 50, max_test_lines: 150, never: ['**/*.sql'] };

// A repo record as the configuration holds it, on a fresh clone.
function repo(files) {
  const dir = clonedRepo(tempDir(), 'app', files);
  return { id: 'h/app', name: 'App', path: dir, trunk: 'main' };
}

test('the branch name comes from the pattern', () => {
  assert.equal(branchName('task/{id}', '362525'), 'task/362525');
  assert.equal(branchName('feature/{id}-work', 'a-b'), 'feature/a-b-work');
});

test('a clean repo gets the task branch cut from the fetched trunk', () => {
  const r = repo();
  // Someone else pushes to main after this clone last fetched.
  const other = path.join(tempDir(), 'other');
  git(path.dirname(other), 'clone', '-q', `${r.path}.git`, other);
  for (const [k, v] of [['user.name', 'Other'], ['user.email', 'other@example.invalid']]) git(other, 'config', k, v);
  writeFiles(other, { 'new.txt': 'new\n' });
  const pushed = commitAll(other, 'second');
  git(other, 'push', '-q', 'origin', 'main');

  const result = prepareRepo(r, 'task/1');
  assert.deepEqual(result, { branch: 'task/1', base: pushed, warnings: [] });
  assert.equal(out(r.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'task/1');
  assert.equal(out(r.path, 'rev-parse', 'HEAD'), pushed);
  assert.equal(out(r.path, 'for-each-ref', '--format=%(upstream)', 'refs/heads/task/1'), '', 'the task branch must not track the trunk');
});

test('uncommitted work on another branch stops with a fix and changes nothing', () => {
  const r = repo();
  writeFiles(r.path, { 'README.md': 'my work\n', 'notes.txt': 'mine\n' });
  const before = out(r.path, 'status', '--porcelain');
  const result = prepareRepo(r, 'task/1');
  assert.deepEqual(result, { problem: { message: 'App has uncommitted changes on main.', fix: `Commit or stash them in ${r.path}, then continue.` } });
  assert.equal(out(r.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(out(r.path, 'status', '--porcelain'), before);
  assert.equal(fs.readFileSync(path.join(r.path, 'README.md'), 'utf8'), 'my work\n');
  assert.equal(out(r.path, 'branch', '--list', 'task/1'), '');
});

test('being on the task branch with uncommitted work is fine', () => {
  const r = repo();
  const first = prepareRepo(r, 'task/1');
  writeFiles(r.path, { 'README.md': 'work in progress\n' });
  assert.deepEqual(prepareRepo(r, 'task/1'), { branch: 'task/1', base: first.base, warnings: [] });
  assert.equal(fs.readFileSync(path.join(r.path, 'README.md'), 'utf8'), 'work in progress\n');
});

test('an existing task branch is switched to, not recreated', () => {
  const r = repo();
  const base = out(r.path, 'rev-parse', 'HEAD');
  git(r.path, 'switch', '-q', '-c', 'task/1');
  writeFiles(r.path, { 'done.txt': 'earlier work\n' });
  const extra = commitAll(r.path, 'earlier work');
  git(r.path, 'switch', '-q', 'main');
  assert.deepEqual(prepareRepo(r, 'task/1'), { branch: 'task/1', base, warnings: [] });
  assert.equal(out(r.path, 'rev-parse', 'HEAD'), extra);
});

test('a fetch that fails is a warning', () => {
  const r = repo();
  git(r.path, 'remote', 'set-url', 'origin', path.join(tempDir(), 'missing.git'));
  const result = prepareRepo(r, 'task/1');
  assert.equal(result.branch, 'task/1');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /^App: main could not be fetched/);
  assert.equal(out(r.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'task/1');
});

test('a folder that is not a repo, or a trunk the remote does not have, is a problem and not a crash', () => {
  const plain = { id: 'h/x', name: 'Plain', path: tempDir(), trunk: 'main' };
  assert.match(prepareRepo(plain, 'task/1').problem.message, /^Plain/);
  const r = { ...repo(), trunk: 'develop' };
  const result = prepareRepo(r, 'task/1');
  assert.match(result.problem.message, /^App: the branch task\/1 could not be created from origin\/develop/);
  assert.equal(out(r.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

test('tests, lock files and generated files are told apart', () => {
  const kinds = {
    'src/Foo.Tests/BarTests.cs': 'test', 'src/Foo.UnitTests/Helper.cs': 'test', 'web/src/__tests__/a.js': 'test', 'web/Spec/a.js': 'test',
    'web/src/greeting.test.ts': 'test', 'web/src/greeting.SPEC.ts': 'test', 'src/QuoteExportTest.cs': 'test', 'src\\Quotes\\QuoteTests.cs': 'test',
    'web/pnpm-lock.yaml': 'generated', 'package-lock.json': 'generated', 'Cargo.lock': 'generated', 'src/a.Designer.cs': 'generated',
    'src/b.g.cs': 'generated', 'api/client.generated.ts': 'generated', 'web/app.min.js': 'generated', 'web/tests/__snapshots__/a.snap': 'generated',
    'src/Latest.cs': 'product', 'src/Contest.cs': 'product', 'src/Testing/Helper.cs': 'product', 'docs/readme.md': 'product', 'db/001.sql': 'product',
  };
  for (const [file, kind] of Object.entries(kinds)) assert.equal(classify(file), kind, file);
});

test('committed, uncommitted and untracked changes are all measured', () => {
  const r = repo({ 'src/a.cs': lines(10), 'src/b.cs': lines(5), 'src/old.cs': lines(4), 'tests/a.test.js': lines(3) });
  const { base } = prepareRepo(r, 'task/1');
  writeFiles(r.path, { 'src/a.cs': lines(10) + 'added 1\nadded 2\n' });
  commitAll(r.path, 'committed on the task branch');
  writeFiles(r.path, { 'src/b.cs': lines(4), 'src/old.cs': null, 'src/new.cs': lines(7), 'tests/a.test.js': lines(3) + 'more\n', 'db/1.sql': 'select 1;\n' });
  const m = measureRepo(r, base, TRIVIAL.never);
  assert.deepEqual(m.files, [
    { path: 'db/1.sql', added: 1, removed: 0, kind: 'product' },
    { path: 'src/a.cs', added: 2, removed: 0, kind: 'product' },
    { path: 'src/b.cs', added: 0, removed: 1, kind: 'product' },
    { path: 'src/new.cs', added: 7, removed: 0, kind: 'product' },
    { path: 'src/old.cs', added: 0, removed: 4, kind: 'product' },
    { path: 'tests/a.test.js', added: 1, removed: 0, kind: 'test' },
  ]);
  assert.deepEqual([m.product_files, m.product_lines, m.test_lines, m.never], [5, 15, 1, ['db/1.sql']]);
});

test('a lock file is listed but not counted, and a binary file counts no lines', () => {
  const r = repo();
  const { base } = prepareRepo(r, 'task/1');
  writeFiles(r.path, { 'pnpm-lock.yaml': lines(900), 'logo.bin': Buffer.from([0, 1, 2, 0, 255]), 'src/a.cs': 'one\n' });
  const m = measureRepo(r, base, []);
  assert.deepEqual(m.files.map((f) => [f.path, f.added, f.kind]), [['logo.bin', 0, 'product'], ['pnpm-lock.yaml', 900, 'generated'], ['src/a.cs', 1, 'product']]);
  assert.deepEqual([m.product_files, m.product_lines, m.test_lines], [2, 1, 0]);
});

test('nothing changed measures as nothing', () => {
  const r = repo();
  const { base } = prepareRepo(r, 'task/1');
  assert.deepEqual(measureRepo(r, base, TRIVIAL.never), { files: [], product_files: 0, product_lines: 0, test_lines: 0, never: [] });
});

const measure = (product_files, product_lines, test_lines = 0, never = []) => ({ files: [], product_files, product_lines, test_lines, never });

test('3 product files and 50 lines are trivial; a fourth file or line 51 is not', () => {
  assert.deepEqual(judgeTrivial([measure(3, 50)], TRIVIAL, 'no'), { trivial: true, reasons: [] });
  assert.deepEqual(judgeTrivial([measure(2, 20), measure(2, 10)], TRIVIAL, 'no'), { trivial: false, reasons: ['4 product files changed. A trivial change has at most 3.'] });
  assert.deepEqual(judgeTrivial([measure(1, 51)], TRIVIAL, 'no'), { trivial: false, reasons: ['51 product lines changed. A trivial change has at most 50.'] });
});

test('150 test lines are trivial and 151 are not', () => {
  assert.equal(judgeTrivial([measure(1, 1, 150)], TRIVIAL, 'no').trivial, true);
  assert.deepEqual(judgeTrivial([measure(1, 1, 151)], TRIVIAL, 'no').reasons, ['151 test lines changed. A trivial change has at most 150.']);
});

test('a never-trivial path or a sensitive change is not trivial, with the reason', () => {
  assert.deepEqual(judgeTrivial([measure(1, 1, 0, ['db/1.sql'])], TRIVIAL, 'no').reasons, ['db/1.sql is on a path that is never trivial.']);
  assert.deepEqual(judgeTrivial([measure(1, 1)], TRIVIAL, 'yes'), { trivial: false, reasons: ['The Build agent marked the change as sensitive, or did not say.'] });
  assert.equal(judgeTrivial([measure(9, 99, 999, ['a.sql', 'b.sql', 'c.sql', 'd.sql'])], TRIVIAL, 'yes').reasons.length, 5);
});

test('the git module never discards or moves work', () => {
  const source = fs.readFileSync(path.join(pluginRoot, 'scripts', 'lib', 'gitwork.js'), 'utf8');
  // Every git argument in the module is a quoted word, so a quoted word that is not there is a command it cannot run.
  for (const word of ['reset', 'stash', 'checkout', 'clean', 'restore', 'push', 'commit', 'merge', 'rebase', 'branch', '-D', '-f', '--force']) {
    assert.equal(source.includes(`'${word}'`), false, word);
  }
});

test('git never waits for someone to sign in: a fetch that needs a password fails at once', () => {
  const r = repo();
  const seen = [];
  const run = (cmd, args, opts) => {
    seen.push({ args: args.slice(2), env: opts.env });
    return require('../scripts/lib/run.js').run(cmd, args, opts);
  };
  prepareRepo(r, 'task/1', { run });
  const fetch = seen.find((s) => s.args[0] === 'fetch');
  assert.deepEqual([fetch.env.GIT_TERMINAL_PROMPT, fetch.env.GCM_INTERACTIVE], ['0', 'Never']);
  assert.equal(fetch.env.PATH || fetch.env.Path, process.env.PATH || process.env.Path, 'the rest of the environment is kept');
});
