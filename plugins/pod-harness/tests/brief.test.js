'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { APP, WEB, podHome, podConfig } = require('./helpers');
const store = require('../scripts/lib/store.js');
const { createTask, taskDir, stageFile } = require('../scripts/lib/taskstore.js');
const { withKeys } = require('../scripts/lib/workorder.js');
const { policiesFor, renderBrief, writeBrief } = require('../scripts/lib/brief.js');

const POLICIES = [
  { id: 'pod-tests', statement: 'Every change comes with a unit test.', applies_to: 'build', check: 'review' },
  { id: 'pod-dod', statement: 'A change meets the Definition of Done before review.', applies_to: 'review', check: 'review', source: 'https://example.invalid/wiki/dod' },
  { id: 'pod-sql', statement: 'A query comes with its plan.', applies_to: 'database', check: 'review' },
  { id: 'pod-migration', statement: 'A migration needs the DBA to agree.', applies_to: 'database', check: 'approval' },
  { id: 'pod-flags', statement: 'Removing a feature flag needs the product owner.', applies_to: 'all', check: 'approval' },
];
const ORDER = {
  format: 1, size: 'S', summary: 'Add a stock line type.', repos: [APP, WEB],
  agents: [
    { stage: 'build', agent: 'backend', repo: APP, job: 'Add the line type to QuoteExport and its unit tests.', read: ['src/Quotes/QuoteExport.cs:40-90'] },
    { stage: 'build', agent: 'database', repo: APP, job: 'Add the column.' },
    { stage: 'build', agent: 'frontend', repo: WEB, job: 'Show the line type.' },
  ],
  checks: ['Open the quote screen and check the label.'], risks: [], open_points: [], debate: false,
};

// A pod with policies, skills and a repo that needs a variable, and a task at the given stage.
function fixture(id = '362525', stateChange = {}) {
  const h = podHome();
  store.patchLayer('example', 'base', 'Policies', POLICIES, h.env);
  store.patchLayer('example', 'base', 'Skills', { backend: ['csharp-testing', 'dotnet-patterns'] }, h.env);
  store.patchLayer('example', 'base', 'Repos', [{ id: APP, build: 'dotnet build App.slnx', test: { win32: 'dotnet test App.slnx --windows', linux: 'dotnet test App.slnx --linux' }, env: ['NUGET_TOKEN'] }], h.env);
  const config = podConfig(h);
  const dir = taskDir(config, id);
  const state = createTask(dir, {
    id, pod: 'example', item: id, predicted: 'small', path: 'full', size: 'S', orchestrator: 'orchestrator_small', stage: 'build',
    round: { understand: 1, build: 1, test: 1, review: 1 },
    repos: { [APP]: { branch: `task/${id}`, base: 'abc1234' }, [WEB]: { branch: `task/${id}`, base: 'def5678' } },
    ...stateChange,
  });
  fs.writeFileSync(path.join(dir, 'request.md'), 'What is asked');
  const ctx = (extra = {}) => ({ config, state, dir, platform: 'win32', order: ORDER, model: 'sonnet', inputs: { notes: [], reports: [] }, ...extra });
  return { h, config, dir, state, ctx, entries: withKeys(ORDER) };
}
const above = (text) => text.slice(0, text.indexOf('## Task'));
const section = (text, name) => { const from = text.indexOf(`## ${name}`); const to = text.indexOf('\n## ', from + 1); return text.slice(from, to === -1 ? undefined : to); };

test('policies are sorted into everyone, this agent or stage, and needs a yes', () => {
  const { config } = fixture();
  const ids = (list) => list.map((p) => p.id);
  const build = policiesFor(config, 'build', 'database');
  assert.deepEqual(ids(build.all), ['org-no-secrets', 'org-no-customer-data', 'org-outward-in-deliver']);
  assert.deepEqual(ids(build.own), ['pod-tests', 'pod-sql']);
  assert.deepEqual(ids(build.ask), ['pod-migration', 'pod-flags']);
  assert.deepEqual(ids(policiesFor(config, 'build', 'backend').ask), ['pod-flags']);
  assert.deepEqual(ids(policiesFor(config, 'review', 'reviewer').own), ['pod-tests', 'pod-dod', 'pod-sql']);
});

test('the four sections come in order', () => {
  const f = fixture();
  for (const [kind, extra] of [['explorer', {}], ['orchestrator', {}], ['build', { entry: f.entries[0] }], ['tester', {}], ['reviewer', { model: 'opus' }]]) {
    const text = renderBrief(kind, f.ctx(extra));
    const at = ['## Pod rules', '## Your part', '## Repo', '## Task'].map((h) => text.indexOf(h));
    assert.ok(at.every((x) => x >= 0), kind);
    assert.deepEqual(at, [...at].sort((a, b) => a - b), kind);
    assert.equal(text.match(/^## /gm).length, 4, kind);
  }
});

test('two tasks of the same pod, agent and repo share every byte above "## Task"', () => {
  const [a, b] = [fixture('362525'), fixture('2026-11-24-other-task')];
  const other = { ...ORDER, summary: 'Another thing.', agents: [{ ...ORDER.agents[0], job: 'A different job.' }] };
  for (const kind of ['explorer', 'orchestrator', 'build', 'tester', 'reviewer']) {
    const one = renderBrief(kind, a.ctx({ entry: a.entries[0] }));
    const two = renderBrief(kind, { ...b.ctx({ entry: withKeys(other)[0], order: { ...other, repos: ORDER.repos } }), config: a.config });
    assert.equal(above(one), above(two), kind);
    assert.notEqual(one, two, kind);
  }
});

test('the task id appears only under "## Task"', () => {
  const f = fixture('362525');
  for (const kind of ['explorer', 'orchestrator', 'build', 'tester', 'reviewer']) {
    const text = renderBrief(kind, f.ctx({ entry: f.entries[0] }));
    assert.equal(above(text).includes('362525'), false, kind);
    assert.ok(section(text, 'Task').includes('362525'), kind);
  }
});

test('a review policy for the stage is in the Build brief, and every review policy is in the Reviewer brief', () => {
  const f = fixture();
  const build = renderBrief('build', f.ctx({ entry: f.entries[1] })); // the database agent
  assert.ok(section(build, 'Pod rules').includes('org-no-secrets: No secret in a prompt, a file or a report.'));
  assert.ok(section(build, 'Your part').includes('pod-tests: Every change comes with a unit test.'));
  assert.ok(section(build, 'Your part').includes('pod-sql'));
  assert.equal(build.includes('pod-dod'), false);
  const review = renderBrief('reviewer', f.ctx({ model: 'opus' }));
  for (const id of ['org-no-secrets', 'org-no-customer-data', 'org-outward-in-deliver', 'pod-tests', 'pod-dod', 'pod-sql']) assert.ok(review.includes(id), id);
  assert.ok(review.includes('https://example.invalid/wiki/dod'));
  assert.match(section(review, 'Your part'), /pod-sql: A query comes with its plan\. Applies to: database\./);
});

test('an approval policy is under "Needs the developer\'s yes first" with the exception line', () => {
  const f = fixture();
  const part = section(renderBrief('build', f.ctx({ entry: f.entries[1] })), 'Your part');
  const at = part.indexOf('Needs the developer\'s yes first');
  assert.ok(at > 0);
  assert.ok(part.indexOf('pod-migration: A migration needs the DBA to agree.') > at);
  assert.ok(part.indexOf('pod-flags') > at);
  assert.ok(part.includes('do not do it. Write `Policy exception: <id> - <what you would do>` under Open points.'));
  assert.equal(section(renderBrief('build', f.ctx({ entry: f.entries[0] })), 'Your part').includes('pod-migration'), false);
});

test('skills named for the agent are listed, and none are named when the pod has none', () => {
  const f = fixture();
  assert.ok(renderBrief('build', f.ctx({ entry: f.entries[0] })).includes('Use these skills: csharp-testing, dotnet-patterns.'));
  assert.equal(renderBrief('build', f.ctx({ entry: f.entries[2] })).includes('Use these skills'), false);
  assert.equal(renderBrief('reviewer', f.ctx()).includes('Use these skills'), false);
});

test('the commands are the ones for this platform, and a needed variable is named', () => {
  const f = fixture();
  const win = section(renderBrief('build', f.ctx({ entry: f.entries[0] })), 'Repo');
  assert.ok(win.includes('dotnet test App.slnx --windows') && !win.includes('--linux'));
  assert.ok(win.includes('dotnet build App.slnx'));
  assert.ok(win.includes('NUGET_TOKEN'));
  assert.ok(win.includes('cmd.exe'));
  assert.ok(win.includes(f.config.repos[0].path));
  assert.ok(win.includes('CLAUDE.md'));
  assert.equal(win.includes('Web'), false, 'a Build agent sees only its own repo');
  const linux = section(renderBrief('build', f.ctx({ entry: f.entries[0], platform: 'linux' })), 'Repo');
  assert.ok(linux.includes('dotnet test App.slnx --linux') && linux.includes('/bin/sh'));
  const all = section(renderBrief('orchestrator', f.ctx()), 'Repo');
  assert.ok(all.includes(APP) && all.includes(WEB) && all.includes(f.config.repos[1].path));
});

test('a Build brief names its job, what to read and its branch, and tells the agent not to commit', () => {
  const f = fixture();
  const task = section(renderBrief('build', f.ctx({ entry: f.entries[0] })), 'Task');
  assert.ok(task.includes('Add the line type to QuoteExport and its unit tests.'));
  assert.ok(task.includes('src/Quotes/QuoteExport.cs:40-90'));
  assert.ok(task.includes('You are on branch task/362525. Do not commit, push, switch branches or touch another repo.'));
  assert.ok(task.includes(path.join(f.dir, 'request.md')));
  assert.equal(task.includes('item.md'), false);
  assert.ok(task.trimEnd().endsWith(`\`${stageFile(f.dir, 'build', 'backend', 1, 'md')}\`.`));
});

test('a Build brief on a return names the Tester report and the notes', () => {
  const f = fixture('362525', { round: { understand: 1, build: 2, test: 1, review: 0 } });
  fs.writeFileSync(path.join(f.dir, 'item.md'), 'the item');
  const report = stageFile(f.dir, 'test', 'tester', 1, 'md');
  const note = path.join(f.dir, 'change-1.md');
  const task = section(renderBrief('build', f.ctx({ entry: f.entries[0], inputs: { notes: [note], reports: [report] } })), 'Task');
  assert.ok(task.includes(report) && task.includes(note));
  assert.match(task, /return to Build/i);
  assert.ok(task.includes(path.join(f.dir, 'item.md')));
  assert.ok(task.trimEnd().endsWith(`\`${stageFile(f.dir, 'build', 'backend', 2, 'md')}\`.`));
});

test('the small Orchestrator is told to write no order for an M or L task; the full one is not', () => {
  const f = fixture();
  const small = renderBrief('orchestrator', f.ctx());
  assert.ok(small.includes('If the task is M or L, or you cannot size it with confidence, write no work order and say so in your Summary.'));
  const full = renderBrief('orchestrator', f.ctx({ state: { ...f.state, orchestrator: 'orchestrator' }, model: 'opus' }));
  assert.equal(full.includes('write no work order'), false);
});

test('the Orchestrator brief gives the Explorer\'s brief, the work order format and the pod\'s limits', () => {
  const f = fixture();
  const text = renderBrief('orchestrator', f.ctx());
  const explorerBrief = stageFile(f.dir, 'understand', 'explorer', 1, 'brief.md');
  assert.ok(section(text, 'Task').includes(`Dispatch \`pod-harness:explorer\` once, on the model \`haiku\`, with the prompt \`Read your brief at ${explorerBrief} and do what it says.\``));
  assert.ok(section(text, 'Task').includes(path.join(f.dir, 'work-order.json')));
  assert.ok(text.includes('"agents"') && text.includes('"open_points"'));
  assert.ok(text.includes('At most 4 agents') && text.includes('at most 2 of one kind'));
  assert.equal(text.includes('Read it. Dispatch the Explorer again only for a place it lacks.'), false);
  fs.writeFileSync(path.join(f.dir, 'context.json'), '{}');
  assert.ok(renderBrief('orchestrator', f.ctx()).includes('Read it. Dispatch the Explorer again only for a place it lacks.'));
});

test('the Orchestrator brief after a promotion carries the reasons and the diff path', () => {
  const f = fixture();
  const task = section(renderBrief('orchestrator', f.ctx({ inputs: { notes: [], reports: [], grew: ['4 product files changed. A trivial change has at most 3.'] } })), 'Task');
  assert.ok(task.includes('4 product files changed. A trivial change has at most 3.'));
  assert.ok(task.includes(stageFile(f.dir, 'build', 'diff', 1, 'json')));
  assert.ok(task.includes('Plan what is left. The task is S unless you find it larger.'));
});

test('the Orchestrator brief after failed tests names the result and the reports', () => {
  const f = fixture();
  const result = stageFile(f.dir, 'test', 'result', 3, 'json');
  const report = stageFile(f.dir, 'test', 'stage-report', 3, 'md');
  const task = section(renderBrief('orchestrator', f.ctx({ inputs: { notes: [], reports: [report], result } })), 'Task');
  assert.ok(task.includes(result) && task.includes(report));
});

test('the Explorer brief says where context.json goes and how to search', () => {
  const f = fixture();
  const text = renderBrief('explorer', f.ctx({ model: 'haiku' }));
  assert.ok(section(text, 'Task').includes(path.join(f.dir, 'context.json')));
  assert.ok(text.includes('Search with Grep and Glob. Read excerpts. Do not read whole files.'));
  assert.ok(text.includes('"found"') && text.includes('"missing"'));
  assert.equal(text.includes('## Summary'), false);
});

test('the Tester brief names the result, the failing output and the checks, and says to fix nothing', () => {
  const f = fixture();
  const result = stageFile(f.dir, 'test', 'result', 1, 'json');
  fs.mkdirSync(path.dirname(result), { recursive: true });
  fs.writeFileSync(result, JSON.stringify({ result: 'fail', repos: [{ id: APP, name: 'App', build: 'pass', test: 'fail', output: path.join(f.dir, 'test', 'App.txt') }, { id: WEB, name: 'Web', build: 'pass', test: 'pass' }] }));
  const task = section(renderBrief('tester', f.ctx({ inputs: { notes: [], reports: [], result } })), 'Task');
  assert.ok(task.includes(result) && task.includes(path.join(f.dir, 'test', 'App.txt')));
  assert.ok(task.includes('Open the quote screen and check the label.'));
  assert.ok(task.includes('Find what failed and where. Fix nothing.'));
});

test('the Reviewer brief lists the changed files with the diff command for each repo', () => {
  const f = fixture();
  const diff = { repos: [
    { id: APP, name: 'App', path: f.config.repos[0].path, branch: 'task/362525', base: 'abc1234', files: [{ path: 'src/a.cs', added: 3, removed: 1, kind: 'product' }, { path: 'tests/a.test.cs', added: 9, removed: 0, kind: 'test' }] },
    { id: WEB, name: 'Web', path: f.config.repos[1].path, branch: 'task/362525', base: 'def5678', files: [] },
  ], trivial: null };
  const reports = [stageFile(f.dir, 'build', 'stage-report', 1, 'md'), stageFile(f.dir, 'test', 'stage-report', 1, 'md')];
  const task = section(renderBrief('reviewer', f.ctx({ model: 'opus', inputs: { notes: [], reports, diff, result: stageFile(f.dir, 'test', 'result', 1, 'json') } })), 'Task');
  assert.ok(task.includes(`git -C "${f.config.repos[0].path}" diff abc1234 -- "src/a.cs"`));
  assert.ok(task.includes('src/a.cs (product, +3 -1)') && task.includes('tests/a.test.cs (test, +9 -0)'));
  assert.ok(task.includes('Web: no file changed.'));
  assert.ok(task.includes(reports[0]) && task.includes(reports[1]) && task.includes(stageFile(f.dir, 'test', 'result', 1, 'json')));
  assert.ok(task.includes('List under Found what a person must test by hand.'));
});

test('each kind is told its marker line', () => {
  const f = fixture();
  const part = (kind, extra) => section(renderBrief(kind, f.ctx(extra)), 'Your part');
  assert.ok(part('build', { entry: f.entries[0] }).includes('`Sensitive change: yes` or `Sensitive change: no`'));
  assert.ok(part('tester').includes('`Result: pass` or `Result: fail`'));
  assert.ok(part('reviewer').includes('`Verdict: approve` or `Verdict: changes`'));
  for (const kind of ['orchestrator', 'explorer']) assert.equal(/Sensitive change|Result:|Verdict:/.test(part(kind)), false, kind);
});

test('the report rules give the headings, the line limit for the model and the language', () => {
  const f = fixture();
  const rules = (model) => section(renderBrief('reviewer', f.ctx({ model })), 'Pod rules');
  assert.ok(rules('sonnet').includes('Summary, Did, Found, Changed files, Evidence, Open points, Next'));
  assert.ok(rules('sonnet').includes('40 lines at most') && rules('opus').includes('80 lines at most'));
  assert.ok(rules('sonnet').includes('"en"'));
  assert.ok(rules('sonnet').includes('Return your Summary and the path of your report. Nothing else.'));
});

test('paths with a space are written in full', () => {
  const f = fixture();
  assert.ok(f.dir.includes(' '));
  const text = renderBrief('build', f.ctx({ entry: f.entries[0] }));
  assert.ok(text.includes(`\`${path.join(f.dir, 'request.md')}\``));
  assert.ok(text.includes(`\`${stageFile(f.dir, 'build', 'backend', 1, 'md')}\``));
});

test('writeBrief puts the brief beside the report it asks for', () => {
  const f = fixture();
  const file = writeBrief(f.dir, 'build', 'backend-2', 2, 'text');
  assert.equal(file, path.join(f.dir, 'build', 'backend-2-r2.brief.md'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'text');
});

test('a command recorded as not running on this machine is marked in the brief', () => {
  const f = fixture();
  f.config.repos[0].proof = { build: 'pass', test: 'not-here' };
  const repo = section(renderBrief('build', f.ctx({ entry: f.entries[0] })), 'Repo');
  assert.match(repo, /- Test: `dotnet test App\.slnx --windows` \(recorded as not running on this machine: do not run it\)/);
  assert.match(repo, /- Build: `dotnet build App\.slnx`\n/);
});

test('a Build brief says that a note in which the developer allows it is the yes', () => {
  const f = fixture();
  const part = section(renderBrief('build', f.ctx({ entry: f.entries[1] })), 'Your part');
  assert.ok(part.includes('A note under Task in which the developer allows it is that yes.'));
});
