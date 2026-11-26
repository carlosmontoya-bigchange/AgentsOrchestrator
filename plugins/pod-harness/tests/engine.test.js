'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pluginRoot, APP, WEB, podHome, podConfig, taskCli, git, writeFiles } = require('./helpers');
const store = require('../scripts/lib/store.js');
const { readState, writeState, writeMode, readApprovals, sessionTask, stageFile } = require('../scripts/lib/taskstore.js');
const engine = require('../scripts/lib/engine.js');

const { spawnSync } = require('node:child_process');

const HOOK = path.join(pluginRoot, 'scripts', 'hook.js');
const now = () => new Date('2026-11-24T10:00:00.000Z');
const out = (dir, ...args) => String(git(dir, ...args)).trim();
const read = (file) => fs.readFileSync(file, 'utf8');
let count = 0;

// What an agent leaves behind: a report with every heading.
const rep = ({ evidence = '', questions = 'None', notes = 'None', summary = 'Done.' } = {}) => ['## Summary', summary, '## Did', '-', '## Found', '-', '## Changed files', '-', '## Evidence', evidence, '## Questions', questions, '## Notes', notes, '## Next', '-', ''].join('\n');
const SAFE = 'Sensitive change: no';
const agent = (name, repo = APP) => ({ stage: 'build', agent: name, repo, job: 'Do the job.' });
const order = (change = {}) => ({ format: 1, size: 'S', summary: 'Change the greeting.', repos: [APP], agents: [agent('backend')], checks: [], risks: [], questions: [], debate: false, ...change });

const TRIVIAL = ['--predict', 'trivial', '--repo', 'App', '--place', 'src/greeting.cs'];
const SMALL = ['--predict', 'small', '--repo', 'App'];
const FULL = ['--predict', 'full'];
const failingTests = (h) => store.patchLayer('example', 'base', 'Repos', [{ id: APP, test: 'node -e "console.log(\'boom\'); process.exit(1)"' }], h.env);

// A started task in a pod whose repos are real clones. opts.mode: the recorded permission mode, null for none.
async function task(args, opts = {}) {
  const h = podHome({ git: true });
  if (opts.setup) opts.setup(h);
  const id = `t${++count}`;
  const started = await taskCli(h, 'start', '--item', id, ...args, '--session', `sess-${id}`);
  assert.equal(started.code, 0, JSON.stringify(started.out));
  const { dir } = started.out;
  if (opts.request !== false) fs.writeFileSync(started.out.request_file, '# What is asked\n\nChange the greeting.\n');
  if (opts.mode !== null) writeMode(dir, { value: opts.mode || 'default', at: now().toISOString(), event: 'UserPromptSubmit' });
  let clock = now().getTime();
  const ctx = () => ({ config: podConfig(h), dir, env: h.env, platform: process.platform, pluginRoot, now: () => new Date(clock), session: opts.session });
  return {
    h, id, dir,
    // Time passes: a step that waits for agents gives them a moment before it calls a report missing.
    later: (seconds) => { clock += seconds * 1000; },
    next: () => engine.next(ctx()),
    answer: (checkpoint, choice, note) => engine.answer(ctx(), checkpoint, choice, note),
    state: () => readState(dir),
    file: (...parts) => path.join(dir, ...parts),
    order: (o = order()) => fs.writeFileSync(path.join(dir, 'work-order.json'), typeof o === 'string' ? o : JSON.stringify(o)),
    report: (stage, key, text = rep()) => {
      const file = stageFile(dir, stage, key, readState(dir).round[stage], 'md');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return file;
    },
    runTests: () => taskCli(h, 'test', id),
  };
}

// The Build agent's part: change files in App and leave the report. A later round writes other text, so every
// round that calls this is seen to have changed something.
function build(t, files, evidence = SAFE, extra = {}) {
  const round = t.state().round.build;
  writeFiles(t.h.app, files || { 'src/greeting.cs': round > 1 ? `hello, pod, round ${round}\n` : 'hello, pod\n' });
  return t.report('build', 'backend', rep({ evidence, ...extra }));
}

// The full path through Understand: the Orchestrator's work order and report, then Continue at the checkpoint.
async function understood(t, o = order()) {
  assert.equal((await t.next()).action.stage, 'understand');
  t.order(o);
  t.report('understand', 'orchestrator');
  const r = await t.next();
  assert.equal(r.action.type, 'ask', JSON.stringify(r.action));
  t.answer(r.action.checkpoint, 'continue');
}

// From a Build dispatch to the Reviewer's report: Build's work, the test run, the review.
async function throughReview(t, verdict = 'Verdict: approve') {
  build(t);
  assert.equal((await t.next()).action.type, 'run');
  await t.runTests();
  assert.equal((await t.next()).action.stage, 'review');
  return t.report('review', 'reviewer', rep({ evidence: verdict }));
}

// One failing Test round after Build's report: the run, the Tester, its report. Returns what comes next.
async function failTests(t) {
  assert.equal((await t.next()).action.type, 'run');
  assert.equal((await t.runTests()).out.result, 'fail');
  assert.equal((await t.next()).action.waves[0][0].key, 'tester');
  t.report('test', 'tester', rep({ evidence: 'Result: fail' }));
  return t.next();
}

function snapshot(dir) {
  const files = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else files[path.relative(dir, path.join(d, e.name))] = read(path.join(d, e.name));
    }
  };
  walk(dir);
  return files;
}

// ---- fast path

test('a trivial task goes straight to one Build agent, with no Orchestrator', async () => {
  const t = await task(TRIVIAL);
  const r = await t.next();
  assert.deepEqual([r.id, r.stage, r.step, r.action.type, r.action.stage], [t.id, 'build', 'waiting', 'dispatch', 'build']);
  const brief = stageFile(t.dir, 'build', 'backend', 1, 'brief.md');
  assert.deepEqual(r.action.waves, [[{ key: 'backend', agent: 'pod-harness:backend', model: 'sonnet', prompt: `Read your brief at ${brief} and do what it says.` }]]);
  assert.ok(read(brief).includes('Make the change in the request, with its automated tests.'));
  assert.equal(r.say, 'Stage 4 of 8, Build: backend in App.');
  assert.equal(out(t.h.app, 'rev-parse', '--abbrev-ref', 'HEAD'), `task/${t.id}`);
  assert.equal(t.state().repos[APP].branch, `task/${t.id}`);
  assert.equal(fs.existsSync(t.file('understand')), false);
});

test('after Build the diff is measured and the test run is asked for', async () => {
  const t = await task(TRIVIAL);
  await t.next();
  build(t);
  const r = await t.next();
  assert.deepEqual([r.stage, r.step, r.action], ['test', 'ready', { type: 'run', command: `node "${path.join(pluginRoot, 'scripts', 'task.js')}" test ${t.id}` }]);
  const diff = JSON.parse(read(t.file('build', 'diff.json')));
  assert.deepEqual([diff.repos[0].id, diff.repos[0].name, diff.repos[0].product_files, diff.repos[0].branch, diff.repos[0].base, diff.trivial],
    [APP, 'App', 1, `task/${t.id}`, t.state().repos[APP].base, { trivial: true, reasons: [] }]);
  assert.deepEqual(r.show.map((s) => [s.stage, s.round]), [['build', 1]]);
  assert.equal(r.show[0].lines[0], `App: 1 product file, 1 product line and 0 test lines changed on task/${t.id}.`);
  assert.ok(read(r.show[0].report).startsWith(`# Build report, task ${t.id}`));
});

test('passing tests go to the Reviewer on the trivial model at high effort, with no Tester', async () => {
  const t = await task(TRIVIAL);
  await t.next();
  build(t);
  await t.next();
  assert.equal((await t.runTests()).out.result, 'pass');
  const r = await t.next();
  assert.deepEqual([r.stage, r.step, r.action.type], ['review', 'waiting', 'dispatch']);
  const [[reviewer]] = r.action.waves;
  assert.deepEqual([reviewer.key, reviewer.agent, reviewer.model, reviewer.effort], ['reviewer', 'pod-harness:reviewer', 'sonnet', 'high']);
  assert.deepEqual(r.show.map((s) => s.stage), ['test']);
  assert.equal(fs.existsSync(stageFile(t.dir, 'test', 'tester', 1, 'brief.md')), false);
  const brief = read(stageFile(t.dir, 'review', 'reviewer', 1, 'brief.md'));
  assert.ok(brief.includes('src/greeting.cs') && brief.includes(stageFile(t.dir, 'test', 'result', 1, 'json')));
});

test('an approving review in Manual mode asks Review result; Continue closes the task', async () => {
  const t = await task(TRIVIAL);
  await t.next();
  await throughReview(t);
  const r = await t.next();
  assert.deepEqual([r.stage, r.step, r.action.type, r.action.checkpoint, r.action.header], ['review', 'asking', 'ask', 'review_result', 'Review']);
  assert.deepEqual(r.action.options.map((o) => o.label), ['Continue', 'Continue with a change', 'Stop here']);
  assert.equal(r.action.question, 'Review result: approved. Close the task?');
  assert.deepEqual(r.action.summary.split('\n'), [
    '### Review result: approved', `Task ${t.id}, App, branch task/${t.id}`, '',
    '**Next:** The task closes. The work stays uncommitted on its branch.', 'The report: review/stage-report.md',
  ]);
  assert.equal(read(r.action.file), r.action.summary + '\n');
  assert.deepEqual(t.answer('review_result', 'continue'), { ok: true, status: 'running' });
  const end = await t.next();
  assert.deepEqual([end.action.type, end.action.status, t.state().status], ['end', 'done', 'done']);
  const text = end.action.lines.join('\n');
  assert.ok(text.includes(`App: ${t.h.app}, branch task/${t.id}, uncommitted.`));
  assert.ok(text.includes('Size trivial, fast path.'));
  assert.ok(text.includes('Not done by the harness in this version: commit, push, pull request, tracker update.'));
  assert.ok(text.includes(stageFile(t.dir, 'review', 'stage-report', 1, 'md')));
  assert.equal(sessionTask(t.h.env, `sess-${t.id}`), null);
  // The harness made no commit and discarded nothing.
  assert.equal(out(t.h.app, 'log', '--oneline').split('\n').length, 1);
  assert.equal(read(path.join(t.h.app, 'src', 'greeting.cs')), 'hello, pod\n');
});

test('a trivial task whose diff has four product files is promoted and Task grew is asked', async () => {
  const t = await task(TRIVIAL);
  await t.next();
  build(t, { 'src/a.cs': 'a\n', 'src/b.cs': 'b\n', 'src/c.cs': 'c\n', 'src/d.cs': 'd\n' });
  const r = await t.next();
  assert.deepEqual([r.action.type, r.action.checkpoint, r.stage, r.step], ['ask', 'task_grew', 'build', 'asking']);
  const s = t.state();
  assert.deepEqual([s.path, s.size, s.orchestrator, s.grew], ['full', 'S', 'orchestrator_small', ['4 product files changed. A trivial change has at most 3.']]);
  assert.ok(r.show[0].lines.includes('Not trivial: 4 product files changed. A trivial change has at most 3.'));
  t.answer('task_grew', 'continue');
  const d = await t.next();
  assert.deepEqual([d.stage, d.action.type, d.action.waves[0][0].agent, d.action.waves[0][0].model], ['understand', 'dispatch', 'pod-harness:orchestrator', 'sonnet']);
  assert.ok(fs.existsSync(t.file('understand', 'work-order-r0.json')));
  assert.equal(fs.existsSync(t.file('work-order.json')), false);
  const brief = read(stageFile(t.dir, 'understand', 'orchestrator', 1, 'brief.md'));
  assert.ok(brief.includes('4 product files changed') && brief.includes(t.file('build', 'diff.json')));
});

test('a missing Sensitive change line promotes the task', async () => {
  const t = await task(TRIVIAL);
  await t.next();
  build(t, undefined, 'The tests pass.');
  const r = await t.next();
  assert.equal(r.action.checkpoint, 'task_grew');
  assert.deepEqual(t.state().grew, ['The Build agent marked the change as sensitive, or did not say.']);
});

// ---- full path

test('a small task dispatches the Orchestrator on the small model, a full one on the full model', async () => {
  const t = await task(SMALL);
  const r = await t.next();
  assert.deepEqual([r.stage, r.step, r.action.stage], ['understand', 'waiting', 'understand']);
  assert.deepEqual(r.action.waves, [[{ key: 'orchestrator', agent: 'pod-harness:orchestrator', model: 'sonnet',
    prompt: `Read your brief at ${stageFile(t.dir, 'understand', 'orchestrator', 1, 'brief.md')} and do what it says.` }]]);
  assert.ok(fs.existsSync(stageFile(t.dir, 'understand', 'explorer', 1, 'brief.md')));
  assert.match(r.say, /^Stage 1 of 8, Understand: /);
  assert.equal((await (await task(FULL)).next()).action.waves[0][0].model, 'opus');
});

test('no work order from the small Orchestrator runs it again on the full model, once, then the task asks', async () => {
  const t = await task(SMALL);
  const models = [];
  for (let i = 0; i < 3; i++) {
    models.push((await t.next()).action.waves[0][0].model);
    t.report('understand', 'orchestrator', rep({ summary: 'This task is M. No work order.' }));
    t.later(60);
  }
  assert.deepEqual(models, ['sonnet', 'opus', 'opus']);
  assert.deepEqual([t.state().round.understand, t.state().orchestrator], [3, 'orchestrator']);
  const note = stageFile(t.dir, 'understand', 'problems', 1, 'md');
  assert.ok(read(note).includes('No work order was written.'));
  assert.ok(read(note).includes(stageFile(t.dir, 'understand', 'orchestrator', 1, 'md')));
  assert.ok(read(stageFile(t.dir, 'understand', 'orchestrator', 2, 'brief.md')).includes(note));
  assert.equal(read(stageFile(t.dir, 'understand', 'orchestrator', 2, 'brief.md')).includes('write no work order'), false);
  const end = await t.next();
  assert.deepEqual([end.action.type, end.action.checkpoint, t.state().status], ['ask', 'needs_you', 'running']);
  assert.equal(end.action.question, 'Needs you: no usable work order. What should happen?');
  const lines = end.action.summary.split('\n');
  assert.equal(lines[1], 'The Orchestrator left no usable work order in two runs. No work order was written.');
  assert.equal(lines.at(-1), 'The report: understand/orchestrator-r3.md', 'the Orchestrator\'s own report is named');
  // The developer's answer gives the Orchestrator a fresh pair of runs.
  const answer = t.file('change-1.md');
  fs.writeFileSync(answer, 'It is one line in src/greeting.cs.');
  t.answer('needs_you', 'change', answer);
  assert.deepEqual([(await t.next()).action.waves[0][0].model, t.state().redo, t.state().round.understand], ['opus', 0, 4]);
});

test('the small Orchestrator sizing a task M is run again on the full model', async () => {
  const t = await task(SMALL);
  await t.next();
  t.order(order({ size: 'M' }));
  const r = await t.next();
  assert.deepEqual([r.action.type, r.action.waves[0][0].model, r.stage, t.state().round.understand], ['dispatch', 'opus', 'understand', 2]);
  assert.ok(read(stageFile(t.dir, 'understand', 'problems', 1, 'md')).includes('sized the task M'));
});

test('an invalid work order runs the Orchestrator again with the problems in a note, then the task asks', async () => {
  const t = await task(FULL);
  await t.next();
  t.order(order({ repos: ['../x'], agents: [agent('backend', '../x')] }));
  const again = await t.next();
  assert.deepEqual([again.action.type, again.action.waves[0][0].model, t.state().round.understand], ['dispatch', 'opus', 2]);
  const note = stageFile(t.dir, 'understand', 'problems', 1, 'md');
  assert.ok(read(note).includes('The repo ../x is not set up for this pod.'));
  assert.ok(read(stageFile(t.dir, 'understand', 'orchestrator', 2, 'brief.md')).includes(note));
  t.order('{ "format": 1,');
  const end = await t.next();
  assert.deepEqual([end.action.checkpoint, t.state().status], ['needs_you', 'running']);
  assert.match(end.action.summary, /not valid JSON/);
  assert.deepEqual(end.action.options.map((o) => o.description)[0], 'The Orchestrator plans again with your answer.');
  assert.equal(fs.existsSync(path.join(t.h.work, 'x')), false, 'nothing is written outside the task folder');
  assert.equal(fs.existsSync(t.file('build')), false, 'nothing was dispatched to Build');
});

test('a valid work order writes the Understand report and asks Work order', async () => {
  const t = await task(SMALL);
  await t.next();
  t.order();
  t.report('understand', 'orchestrator', rep({ questions: '- Which label text do you want?', notes: 'The dialect is not stated.' }));
  const r = await t.next();
  assert.deepEqual([r.stage, r.step, r.action.type, r.action.checkpoint], ['understand', 'asking', 'ask', 'work_order']);
  const report = stageFile(t.dir, 'understand', 'stage-report', 1, 'md');
  assert.equal(r.action.question, 'Work order: size S, 1 question. Start Build?');
  assert.deepEqual(r.action.summary.split('\n'), [
    '### Work order: size S', 'Change the greeting.', `Task ${t.id}, App`, '',
    '**You decide**', '- Which label text do you want?', '',
    '**Next:** Build starts: backend in App.', '1 note for later is in understand/stage-report.md',
  ]);
  assert.equal(read(stageFile(t.dir, 'understand', 'checkpoint', 1, 'md')), r.action.summary + '\n');
  assert.ok(read(report).includes('Build agents: backend in App.'));
  assert.ok(read(report).includes('## Questions\n\n- Which label text do you want?\n\n## Notes\n\n- The dialect is not stated.\n'));
  const s = t.state();
  assert.deepEqual([s.size, s.asking.checkpoint, s.asking.then], ['S', 'work_order', { stage: 'build', step: 'ready' }]);
});

test('a work order without the Orchestrator\'s report is used, and the missing report is noted', async () => {
  const t = await task(SMALL);
  await t.next();
  t.order();
  const r = await t.next();
  assert.equal(r.action.checkpoint, 'work_order');
  assert.ok(read(stageFile(t.dir, 'understand', 'stage-report', 1, 'md')).includes('- orchestrator wrote no report.'));
});

test('a work order naming a repo with no folder returns a fix, and goes on once the folder is set', async () => {
  const t = await task(FULL);
  await t.next();
  store.patchLayer('example', 'personal', 'Repos', [{ id: WEB, path: path.join(t.h.ws, 'missing') }], t.h.env);
  t.order(order({ repos: [APP, WEB], agents: [agent('backend'), agent('frontend', WEB)] }));
  const r = await t.next();
  assert.deepEqual([r.action.type, r.stage, r.step, t.state().round.understand], ['fix', 'understand', 'waiting', 1]);
  assert.match(r.action.problems[0].message, /^Web has no folder on this machine/);
  assert.match(r.action.problems[0].fix, /pod-harness:setup repo/);
  store.patchLayer('example', 'personal', 'Repos', [{ id: WEB, path: t.h.web }], t.h.env);
  assert.equal((await t.next()).action.checkpoint, 'work_order');
});

test('an M task carries the open point about Design and Plan, so Auto asks', async () => {
  const t = await task(FULL, { mode: 'auto' });
  await t.next();
  t.order(order({ size: 'M' }));
  t.report('understand', 'orchestrator');
  const r = await t.next();
  assert.deepEqual([r.action.type, r.action.checkpoint], ['ask', 'work_order']);
  assert.equal(r.action.question, 'Work order: size M, 1 question. Start Build?');
  assert.ok(r.action.summary.includes('- The Design and Plan stages are not in this version: this M task goes from the work order straight to Build.'));

  const s = await task(FULL, { mode: 'auto' });
  await s.next();
  s.order();
  s.report('understand', 'orchestrator');
  const d = await s.next();
  assert.deepEqual([d.action.type, d.action.stage], ['dispatch', 'build'], 'an S task with nothing open is not asked in Auto');
  assert.deepEqual(d.show.map((x) => x.stage), ['understand']);
  assert.deepEqual(readApprovals(s.dir).map((e) => [e.checkpoint, e.mode, e.outcome, e.reason]), [['work_order', 'auto', 'skipped', 'auto-nothing-to-decide']]);
});

test('a larger size than before asks Task grew instead of Work order', async () => {
  const t = await task(FULL);
  await t.next();
  t.order();
  t.report('understand', 'orchestrator');
  await t.next();
  const note = t.file('change-1.md');
  fs.writeFileSync(note, 'Also change the web page.');
  t.answer('work_order', 'change', note);
  await t.next();
  t.order(order({ size: 'M' }));
  t.report('understand', 'orchestrator');
  const r = await t.next();
  assert.deepEqual([r.action.checkpoint, r.action.header], ['task_grew', 'Task grew']);
  assert.equal(r.action.question, 'Task grew: from S to M, 1 question. Start Build?');
  assert.deepEqual(r.action.summary.split('\n').slice(0, 2), ['### Task grew: from S to M', 'Change the greeting.']);
});

test('"Continue with a change" on the work order runs the Orchestrator again with the note', async () => {
  const t = await task(FULL);
  await t.next();
  t.order();
  t.report('understand', 'orchestrator');
  await t.next();
  const note = t.file('change-1.md');
  fs.writeFileSync(note, 'Use the existing helper.');
  assert.deepEqual(t.answer('work_order', 'change', note), { ok: true, status: 'running' });
  assert.deepEqual([t.state().stage, t.state().step, t.state().notes, t.state().asking], ['understand', 'ready', [note], null]);
  const r = await t.next();
  assert.deepEqual([r.action.stage, r.action.waves[0][0].key, t.state().round.understand], ['understand', 'orchestrator', 2]);
  assert.ok(read(stageFile(t.dir, 'understand', 'orchestrator', 2, 'brief.md')).includes(note));
  assert.deepEqual(JSON.parse(read(t.file('understand', 'work-order-r1.json'))), order());
  const last = readApprovals(t.dir).at(-1);
  assert.deepEqual([last.checkpoint, last.outcome, last.answer, last.note], ['work_order', 'asked', 'change', note]);
  t.order();
  await t.next();
  assert.deepEqual(t.state().notes, [], 'dropped once the Orchestrator has used it');
});

test('Build agents in two repos share a wave; two in one repo do not', async () => {
  const t = await task(FULL);
  await understood(t, order({ repos: [APP, WEB], agents: [agent('backend'), agent('database'), agent('frontend', WEB)] }));
  const r = await t.next();
  assert.deepEqual(r.action.waves.map((w) => w.map((a) => `${a.key}:${a.agent}`)), [['backend:pod-harness:backend', 'frontend:pod-harness:frontend'], ['database:pod-harness:database']]);
  for (const dir of [t.h.app, t.h.web]) assert.equal(out(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), `task/${t.id}`);
  assert.equal(r.say, 'Stage 4 of 8, Build: backend in App, database in App, frontend in Web.');
});

test('an effort in the work order is passed to that agent only', async () => {
  const t = await task(FULL);
  await understood(t, order({ agents: [{ ...agent('backend'), effort: 'low' }, agent('database')] }));
  const r = await t.next();
  assert.deepEqual(r.action.waves.flat().map((a) => [a.key, a.effort]), [['backend', 'low'], ['database', undefined]]);
});

test('Build on a dirty repo returns a fix and dispatches nothing', async () => {
  const t = await task(FULL);
  writeFiles(t.h.app, { 'mine.txt': 'my own work\n' });
  await understood(t);
  const r = await t.next();
  assert.deepEqual([r.action.type, r.stage, r.step], ['fix', 'build', 'ready']);
  assert.deepEqual(r.action.problems, [{ message: 'App has uncommitted changes on main.', fix: `Commit or stash them in ${t.h.app}, then continue.` }]);
  assert.equal(fs.existsSync(t.file('build')), false);
  assert.equal(read(path.join(t.h.app, 'mine.txt')), 'my own work\n');
  assert.equal(out(t.h.app, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  fs.rmSync(path.join(t.h.app, 'mine.txt'));
  assert.equal((await t.next()).action.type, 'dispatch');
});

test('a Policy exception line asks Policy exception before Test', async () => {
  const t = await task(FULL);
  await understood(t);
  await t.next();
  writeFiles(t.h.app, { 'src/greeting.cs': 'hello, pod\n' });
  t.report('build', 'backend', rep({ evidence: SAFE, questions: '- Policy exception: pod-migration - drop the old column' }));
  const r = await t.next();
  assert.deepEqual([r.action.checkpoint, r.action.header, r.stage, r.step], ['policy_exception', 'Policy', 'build', 'asking']);
  assert.equal(r.action.question, 'Policy exception: a policy needs your yes, 1 question. Go on without it?');
  assert.ok(r.action.summary.includes('**You decide**\n- pod-migration - drop the old column\n'));
  assert.ok(r.action.summary.includes('To allow it, choose "Continue with a change" and say so.'));
  t.answer('policy_exception', 'continue');
  assert.equal((await t.next()).action.type, 'run');
});

// ---- loops and limits

test('a missing report is dispatched again twice, then the task asks', async () => {
  const t = await task(FULL);
  await understood(t, order({ agents: [agent('backend'), agent('database')] }));
  const first = await t.next();
  writeFiles(t.h.app, { 'src/greeting.cs': 'hello, pod\n' });
  t.report('build', 'backend', rep({ evidence: SAFE }));
  for (const redo of [1, 2]) {
    t.later(60);
    const r = await t.next();
    assert.deepEqual([r.action.type, r.action.waves, t.state().redo, t.state().round.build], ['dispatch', [[first.action.waves[1][0]]], redo, 1]);
  }
  t.later(60);
  const end = await t.next();
  assert.deepEqual([end.action.type, end.action.checkpoint], ['ask', 'needs_you']);
  assert.equal(end.action.question, 'Needs you: an agent left no report. What should happen?');
  assert.equal(end.action.summary.split('\n')[1], 'database wrote no report in three runs.');
  const note = t.file('change-1.md');
  fs.writeFileSync(note, 'Run it again.');
  t.answer('needs_you', 'change', note);
  const again = await t.next();
  assert.deepEqual([again.action.stage, t.state().redo, t.state().round.build], ['build', 0, 2]);
});

test('a Build that changed no file asks, with no question of its own when the agent has none', async () => {
  const t = await task(TRIVIAL);
  await t.next();
  t.report('build', 'backend', rep({ evidence: SAFE }));
  const end = await t.next();
  assert.deepEqual([end.action.checkpoint, end.action.question], ['needs_you', 'Needs you: Build changed no file. What should happen?']);
  assert.equal(sessionTask(t.h.env, `sess-${t.id}`), t.dir, 'the task still runs, so its session stays registered');
  assert.ok(fs.existsSync(stageFile(t.dir, 'build', 'stage-report', 1, 'md')));
});

test('failing tests call the Tester, then return to Build with its report', async () => {
  const t = await task(TRIVIAL, { setup: failingTests });
  await t.next();
  build(t);
  await t.next();
  assert.equal((await t.runTests()).out.result, 'fail');
  const r = await t.next();
  assert.deepEqual([r.stage, r.step, r.action.waves[0][0].agent, r.action.waves[0][0].model], ['test', 'waiting', 'pod-harness:tester', 'sonnet']);
  assert.ok(read(stageFile(t.dir, 'test', 'tester', 1, 'brief.md')).includes(path.join(t.dir, 'test', 'App.txt')));
  const testerReport = t.report('test', 'tester', rep({ evidence: 'Result: fail' }));
  const back = await t.next();
  assert.deepEqual([back.stage, back.action.stage, t.state().round.build, t.state().returns.test], ['build', 'build', 2, 1]);
  assert.ok(read(stageFile(t.dir, 'build', 'backend', 2, 'brief.md')).includes(testerReport));
  assert.deepEqual(back.show.map((s) => [s.stage, s.lines[0]]), [['test', 'The tests failed.']]);
});

test('the Tester runs for a check in the work order though the tests pass, and its fail returns to Build', async () => {
  const t = await task(FULL);
  await understood(t, order({ checks: ['Open the quote screen and check the label.'] }));
  await t.next();
  build(t);
  await t.next();
  assert.equal((await t.runTests()).out.result, 'pass');
  const r = await t.next();
  assert.deepEqual([r.action.waves[0][0].key, r.step], ['tester', 'waiting']);
  t.report('test', 'tester', rep({ evidence: 'The label is wrong.' })); // no Result line: read as fail
  assert.deepEqual([(await t.next()).action.stage, t.state().returns.test], ['build', 1]);
});

test('a third test failure re-routes to the full Orchestrator; after two more returns the task asks, and Continue goes on to Review', async () => {
  const t = await task(SMALL, { setup: failingTests });
  await understood(t);
  await t.next();
  build(t);
  let r;
  for (const round of [2, 3]) {
    r = await failTests(t);
    assert.deepEqual([r.action.stage, t.state().round.build], ['build', round]);
    build(t);
  }
  r = await failTests(t);
  assert.deepEqual([r.stage, r.action.waves[0][0].agent, r.action.waves[0][0].model], ['understand', 'pod-harness:orchestrator', 'opus']);
  assert.deepEqual(t.state().returns, { test: 0, review: 0, reroute: 1 });
  const brief = read(stageFile(t.dir, 'understand', 'orchestrator', 2, 'brief.md'));
  assert.ok(brief.includes(stageFile(t.dir, 'test', 'result', 3, 'json')) && brief.includes(stageFile(t.dir, 'test', 'tester', 3, 'md')));

  t.order();
  t.report('understand', 'orchestrator');
  assert.equal((await t.next()).action.checkpoint, 'task_grew', 'a plan made after the tests kept failing is always shown');
  t.answer('task_grew', 'continue');
  assert.equal((await t.next()).action.stage, 'build');
  for (let i = 0; i < 2; i++) {
    build(t);
    assert.equal((await failTests(t)).action.stage, 'build');
  }
  build(t);
  const end = await failTests(t);
  assert.deepEqual([end.action.type, end.action.checkpoint, t.state().status], ['ask', 'needs_you', 'running']);
  assert.equal(end.action.question, 'Needs you: the tests still fail. What should happen?');
  assert.equal(end.action.summary.split('\n')[1], 'The tests still fail after two returns to Build and a new plan from the Orchestrator.');
  assert.ok(end.action.summary.endsWith('The report: test/stage-report-r6.md'));
  assert.deepEqual(end.action.options.map((o) => o.label), ['Continue', 'Continue with a change', 'Stop here']);
  assert.equal(end.action.options[0].description, 'Review starts, with the failing tests on record.');
  assert.deepEqual(t.state().asking.change.reset, ['test', 'reroute']);
  t.answer('needs_you', 'continue');
  const review = await t.next();
  assert.deepEqual([review.stage, review.action.waves[0][0].key], ['review', 'reviewer']);
  assert.ok(read(stageFile(t.dir, 'review', 'reviewer', 1, 'brief.md')).includes(stageFile(t.dir, 'test', 'result', 6, 'json')));
});

test('after the whole test loop, an answer with a change starts the counts over', async () => {
  const t = await task(TRIVIAL, { setup: failingTests });
  await t.next();
  build(t);
  let r = await failTests(t);
  for (let i = 0; i < 2; i++) { build(t); r = await failTests(t); }
  assert.equal(r.stage, 'understand');
  t.order();
  t.report('understand', 'orchestrator');
  r = await t.next();
  t.answer(r.action.checkpoint, 'continue');
  await t.next();
  for (let i = 0; i < 3; i++) { build(t); r = await failTests(t); }
  assert.equal(r.action.checkpoint, 'needs_you');
  const note = t.file('change-1.md');
  fs.writeFileSync(note, 'The test command is wrong: fix the script.');
  t.answer('needs_you', 'change', note);
  const back = await t.next();
  assert.deepEqual([back.action.stage, t.state().returns], ['build', { test: 0, review: 0, reroute: 0 }]);
  const brief = read(stageFile(t.dir, 'build', 'backend', t.state().round.build, 'brief.md'));
  assert.ok(brief.includes(note) && brief.includes(stageFile(t.dir, 'test', 'tester', 6, 'md')));
});

test('a review that asks for changes returns to Build twice, then the task asks', async () => {
  const t = await task(TRIVIAL);
  await t.next();
  for (const round of [1, 2]) {
    const review = await throughReview(t, 'Verdict: changes');
    const r = await t.next();
    assert.equal(r.action.checkpoint, 'review_result');
    assert.equal(r.action.question, 'Review result: changes asked. Run Build again?');
    t.answer('review_result', 'continue');
    const back = await t.next();
    assert.deepEqual([back.action.stage, t.state().returns.review, t.state().round.build], ['build', round, round + 1]);
    assert.ok(read(stageFile(t.dir, 'build', 'backend', round + 1, 'brief.md')).includes(review));
  }
  const review = await throughReview(t, 'Verdict: changes');
  const last = await t.next();
  assert.deepEqual([last.action.checkpoint, last.action.question], ['needs_you', 'Needs you: the review still asks for changes. What should happen?']);
  assert.equal(last.action.summary.split('\n')[1], 'The review still asks for changes after two returns to Build.');
  assert.deepEqual(last.action.options.map((o) => o.label), ['Continue with a change', 'Stop here']);
  const note = t.file('change-1.md');
  fs.writeFileSync(note, 'Do only the first finding.');
  t.answer('needs_you', 'change', note);
  const back = await t.next();
  assert.deepEqual([back.action.stage, t.state().returns.review, t.state().round.build], ['build', 0, 4]);
  const brief = read(stageFile(t.dir, 'build', 'backend', 4, 'brief.md'));
  assert.ok(brief.includes(note) && brief.includes(review));
});

test('a missing Verdict line is read as changes', async () => {
  const t = await task(TRIVIAL);
  await t.next();
  await throughReview(t, 'It looks fine to me.');
  assert.equal((await t.next()).action.question, 'Review result: changes asked. Run Build again?');
});

test('"Continue with a change" after a review sends Build the note and the review', async () => {
  const t = await task(TRIVIAL);
  await t.next();
  const review = await throughReview(t, 'Verdict: changes');
  await t.next();
  const note = t.file('change-1.md');
  fs.writeFileSync(note, 'Keep the old greeting as a fallback.');
  t.answer('review_result', 'change', note);
  const r = await t.next();
  const brief = read(stageFile(t.dir, 'build', 'backend', 2, 'brief.md'));
  assert.deepEqual([r.action.stage, brief.includes(note), brief.includes(review), t.state().returns.review], ['build', true, true, 0]);
  assert.deepEqual([t.state().notes, t.state().fix.reports], [[note], [review]], 'kept while Build works, for a brief that must be rendered again');
  build(t);
  await t.next();
  assert.deepEqual([t.state().notes, t.state().fix], [[], null], 'dropped once Build has used them');
});

// ---- modes

test('under Bypass permissions nothing is asked and each checkpoint is logged as skipped', async () => {
  const t = await task(SMALL, { mode: 'bypassPermissions' });
  await t.next();
  t.order();
  t.report('understand', 'orchestrator');
  assert.equal((await t.next()).action.stage, 'build');
  await throughReview(t);
  const end = await t.next();
  assert.deepEqual([end.action.type, end.action.status], ['end', 'done']);
  assert.deepEqual(end.show.map((s) => s.stage), ['review']);
  assert.deepEqual(readApprovals(t.dir).map((e) => [e.checkpoint, e.mode, e.outcome, e.reason]),
    [['work_order', 'bypassPermissions', 'skipped', 'bypass'], ['review_result', 'bypassPermissions', 'skipped', 'bypass']]);
});

test('a missing mode asks, with the note once', async () => {
  const t = await task(SMALL, { mode: null });
  await t.next();
  t.order();
  t.report('understand', 'orchestrator');
  const first = await t.next();
  assert.deepEqual([first.action.type, first.note], ['ask', 'The permission mode could not be read, so every checkpoint is asked. To ask nothing for this task, say so.']);
  assert.equal((await t.next()).note, undefined);
  t.answer('work_order', 'continue');
  await t.next();
  await throughReview(t);
  const second = await t.next();
  assert.deepEqual([second.action.checkpoint, second.note], ['review_result', undefined]);
  assert.deepEqual(readApprovals(t.dir)[0], { at: now().toISOString(), checkpoint: 'work_order', mode: null, outcome: 'asked', reason: 'mode-unknown' });
});

test('quiet asks nothing though the mode is unknown', async () => {
  const t = await task(SMALL, { mode: null });
  await taskCli(t.h, 'quiet', t.id, 'on');
  await t.next();
  t.order();
  t.report('understand', 'orchestrator');
  const r = await t.next();
  assert.deepEqual([r.action.stage, r.note, readApprovals(t.dir)[0].reason], ['build', undefined, 'quiet']);
});

test('Plan mode returns a fix and changes no file', async () => {
  const t = await task(SMALL, { mode: 'plan' });
  const before = snapshot(t.dir);
  const r = await t.next();
  assert.deepEqual(r.action, { type: 'fix', problems: [{ message: 'Plan mode is on. The harness cannot write in Plan mode.', fix: 'Leave Plan mode, then continue.' }] });
  assert.deepEqual(snapshot(t.dir), before);
});

test('a stage switched off in the configuration is skipped', async () => {
  const t = await task(TRIVIAL, { setup: (h) => store.patchLayer('example', 'base', 'Stages', { test: false }, h.env) });
  await t.next();
  build(t);
  const r = await t.next();
  assert.deepEqual([r.stage, r.action.stage, r.action.waves[0][0].key], ['review', 'review', 'reviewer']);
  assert.ok(read(stageFile(t.dir, 'review', 'reviewer', 1, 'brief.md')).includes('The Test stage did not run'));

  const u = await task(TRIVIAL, { setup: (h) => store.patchLayer('example', 'base', 'Stages', { test: false, review: false }, h.env) });
  await u.next();
  build(u);
  const end = await u.next();
  assert.deepEqual([end.action.type, end.action.status], ['end', 'done']);
});

// ---- re-entry

test('next at test.ready while the tests run returns wait, not a second run', async () => {
  const t = await task(TRIVIAL);
  await t.next();
  build(t);
  const first = await t.next();
  assert.equal(first.action.type, 'run');
  assert.deepEqual((await t.next()).action, first.action, 'called again before the run started: the same action');
  fs.mkdirSync(t.file('test'), { recursive: true });
  fs.writeFileSync(t.file('test', 'running.json'), JSON.stringify({ pid: process.pid, at: now().toISOString() }));
  const state = read(t.file('state.json'));
  const written = fs.statSync(t.file('state.json')).mtimeMs;
  const r = await t.next();
  assert.deepEqual([r.action.type, r.stage, r.step], ['wait', 'test', 'ready']);
  assert.match(r.action.message, /tests are still running/);
  assert.equal(read(t.file('state.json')), state);
  assert.equal(fs.statSync(t.file('state.json')).mtimeMs, written, 'waiting writes nothing: the test command owns the state while it runs');
});

test('next called again while the Orchestrator still works waits, and uses up nothing', async () => {
  const t = await task(SMALL);
  await t.next();
  const state = read(t.file('state.json'));
  for (let i = 0; i < 3; i++) {
    const again = await t.next();
    assert.deepEqual([again.stage, again.step, again.action.type], ['understand', 'waiting', 'wait']);
    assert.match(again.action.message, /every agent[^.]*has finished/);
  }
  assert.equal(read(t.file('state.json')), state);
  t.later(60);
  const later = await t.next();
  assert.deepEqual([later.action.type, later.action.waves[0][0].model, t.state().round.understand], ['dispatch', 'opus', 2], 'after a while a missing work order is a missing work order');
});

test('next called again right after a Build dispatch waits and does not use up a retry', async () => {
  const t = await task(TRIVIAL);
  await t.next();
  for (let i = 0; i < 4; i++) assert.equal((await t.next()).action.type, 'wait');
  assert.deepEqual([t.state().redo, t.state().status, t.state().round.build], [0, 'running', 1]);
  build(t);
  assert.equal((await t.next()).action.type, 'run', 'a report that is there is read at once');
});

test('Stop here stops the task; the next call asks the same question again', async () => {
  const t = await task(SMALL);
  await t.next();
  t.order();
  t.report('understand', 'orchestrator');
  const asked = await t.next();
  assert.deepEqual(t.answer('work_order', 'stop'), { ok: true, status: 'stopped' });
  assert.deepEqual([t.state().status, t.state().stage, t.state().step], ['stopped', 'understand', 'asking']);
  const again = await t.next();
  assert.deepEqual(again.action, asked.action);
  assert.equal(t.state().status, 'running');
  assert.deepEqual(readApprovals(t.dir).map((e) => [e.outcome, e.reason, e.answer]), [['asked', 'mode', undefined], ['asked', 'mode', 'stop']]);
  t.answer('work_order', 'continue');
  assert.equal((await t.next()).action.stage, 'build');
});

test('next on a done or blocked task returns end and changes nothing', async () => {
  const done = await task(TRIVIAL, { mode: 'bypassPermissions' });
  await done.next();
  await throughReview(done);
  const first = await done.next();
  // Blocked means parked: nothing may be asked, so the task waits with its question.
  const blocked = await task(TRIVIAL, { mode: 'bypassPermissions' });
  await blocked.next();
  blocked.report('build', 'backend', rep({ evidence: SAFE }));
  const stuck = await blocked.next();
  assert.equal(stuck.action.status, 'blocked');
  for (const [t, was] of [[done, first], [blocked, stuck]]) {
    const before = snapshot(t.dir);
    const r = await t.next();
    assert.deepEqual([r.action.type, r.action.status, r.action.lines], ['end', was.action.status, was.action.lines]);
    assert.deepEqual(snapshot(t.dir), before);
  }
});

test('no request.md returns a fix', async () => {
  const t = await task(SMALL, { request: false });
  const r = await t.next();
  assert.equal(r.action.type, 'fix');
  assert.ok(r.action.problems[0].fix.includes(t.file('request.md')));
  fs.writeFileSync(t.file('request.md'), '  \n');
  assert.equal((await t.next()).action.type, 'fix');
  assert.deepEqual([t.state().round.understand, fs.existsSync(t.file('understand'))], [0, false]);
});

test('every finished stage adds a line to task.md and a Show', async () => {
  const t = await task(SMALL, { mode: 'bypassPermissions' });
  const shows = [];
  const step = async () => { const r = await t.next(); shows.push(...r.show); return r; };
  await step();
  t.order();
  t.report('understand', 'orchestrator');
  await step();
  build(t);
  await step();
  await t.runTests();
  await step();
  t.report('review', 'reviewer', rep({ evidence: 'Verdict: approve' }));
  await step();
  assert.deepEqual(shows.map((s) => [s.stage, s.round]), [['understand', 1], ['build', 1], ['test', 1], ['review', 1]]);
  assert.ok(shows.every((s) => fs.existsSync(s.report) && s.lines.length > 0));
  const lines = read(t.file('task.md')).split('\n').filter((l) => l.startsWith('- '));
  assert.deepEqual(lines.map((l) => l.replace(/^- 2026-11-24 /, '').split(/[,:.]/)[0]), ['Understand', 'Build', 'Test', 'Review', 'Done']);
  assert.match(lines[0], /^- 2026-11-24 Understand, round 1: Size S: Change the greeting\. Report: understand[\\/]stage-report\.md$/);
});

test('answer refuses a checkpoint that is not open', async () => {
  const t = await task(SMALL);
  assert.throws(() => t.answer('work_order', 'continue'), (e) => e.code === 'not-asking');
  await t.next();
  t.order();
  t.report('understand', 'orchestrator');
  await t.next();
  assert.throws(() => t.answer('review_result', 'continue'), (e) => e.code === 'not-asking');
  assert.throws(() => t.answer('work_order', 'maybe'), (e) => e.code === 'bad-choice');
  assert.throws(() => t.answer('work_order', 'change'), (e) => e.code === 'no-note');
  assert.throws(() => t.answer('work_order', 'change', t.file('no-such-note.md')), (e) => e.code === 'no-note');
  assert.equal(t.state().asking.checkpoint, 'work_order');
});

// ---- through the CLI

test('next and answer through the CLI, and next registers the session', async () => {
  const t = await task(SMALL);
  const first = await taskCli(t.h, 'next', t.id, '--session', 'another-session');
  assert.deepEqual([first.code, first.out.action.type, first.out.stage], [0, 'dispatch', 'understand']);
  assert.equal(sessionTask(t.h.env, 'another-session'), t.dir);
  t.order();
  t.report('understand', 'orchestrator');
  assert.equal((await taskCli(t.h, 'next', t.id)).out.action.checkpoint, 'work_order');
  const note = t.file('change-1.md');
  fs.writeFileSync(note, 'Use the helper.');
  assert.equal((await taskCli(t.h, 'answer', t.id, 'work_order', 'change')).out.error.code, 'no-note');
  assert.deepEqual((await taskCli(t.h, 'answer', t.id, 'work_order', 'change', `@${note}`)).out, { ok: true, status: 'running' });
  assert.equal((await taskCli(t.h, 'answer', t.id, 'work_order', 'continue')).out.error.code, 'not-asking');
  assert.equal((await taskCli(t.h, 'next', 'no-such-task')).out.error.code, 'no-task');
});

// ---- from the final review

test('next prints the task folder', async () => {
  const t = await task(SMALL);
  assert.equal((await t.next()).dir, t.dir);
});

test('a Test round in which no command ran says so, and what was skipped reaches the Review checkpoint', async () => {
  const none = await task(TRIVIAL);
  await none.next();
  build(none);
  await none.next();
  await none.runTests();
  const r = await none.next();
  assert.equal(r.show[0].lines[0], 'No build or test command ran.');

  const skipped = await task(TRIVIAL, { setup: (h) => {
    store.patchLayer('example', 'base', 'Repos', [{ id: APP, build: 'node -e "process.exit(0)"', test: 'node -e "process.exit(1)"' }], h.env);
    store.patchLayer('example', 'personal', 'Repos', [{ id: APP, proof: { build: 'pass', test: 'not-here' } }], h.env);
  } });
  await skipped.next();
  build(skipped);
  await skipped.next();
  assert.equal((await skipped.runTests()).out.result, 'pass');
  const shown = await skipped.next();
  const open = 'App: the test command is recorded as not run on this machine.';
  assert.deepEqual([shown.show[0].lines[0], shown.show[0].lines.includes(open)], ['The tests passed.', true]);
  skipped.report('review', 'reviewer', rep({ evidence: 'Verdict: approve' }));
  const asked = await skipped.next();
  assert.ok(asked.action.summary.includes(`**You decide**\n- ${open}\n`), 'the developer sees it at the Review checkpoint');
  assert.equal(asked.action.question, 'Review result: approved, 1 question. Close the task?');
});

test('a Policy exception that is not asked is still shown, in every mode', async () => {
  const t = await task(SMALL, { mode: 'bypassPermissions' });
  await t.next();
  t.order();
  t.report('understand', 'orchestrator');
  await t.next();
  writeFiles(t.h.app, { 'src/greeting.cs': 'hello, pod\n' });
  t.report('build', 'backend', rep({ evidence: SAFE, questions: '- Policy exception: pod-migration - drop the old column' }));
  const r = await t.next();
  assert.equal(r.action.type, 'run');
  assert.ok(r.show[0].lines.includes('Not done, a policy needs your yes: backend: pod-migration - drop the old column'));
  assert.deepEqual(readApprovals(t.dir).at(-1).checkpoint, 'policy_exception');
});

test('with two Build agents one "no" is not enough: a missing answer makes the change sensitive', async () => {
  const t = await task(FULL);
  await understood(t, order({ agents: [agent('backend'), agent('database')] }));
  await t.next();
  writeFiles(t.h.app, { 'src/greeting.cs': 'hello, pod\n' });
  t.report('build', 'backend', rep({ evidence: SAFE }));
  t.report('build', 'database', rep({ evidence: 'The tests pass.' }));
  const r = await t.next();
  assert.ok(r.show[0].lines.includes('Sensitive change: yes.'));
});

test('a trunk that could not be fetched is said when Build starts, not after it', async () => {
  const t = await task(TRIVIAL);
  git(t.h.app, 'remote', 'set-url', 'origin', path.join(t.h.ws, 'gone.git'));
  const r = await t.next();
  assert.equal(r.action.type, 'dispatch');
  assert.match(r.say, /^Stage 4 of 8, Build: backend in App\. App: main could not be fetched from origin\./);
});

test('a mode recorded by another session counts as unknown', async () => {
  const t = await task(SMALL, { mode: null, session: 'new-session' });
  writeMode(t.dir, { value: 'bypassPermissions', at: now().toISOString(), event: 'UserPromptSubmit', session: 'old-session' });
  await t.next();
  t.order();
  t.report('understand', 'orchestrator');
  const r = await t.next();
  assert.deepEqual([r.action.type, r.action.checkpoint, typeof r.note], ['ask', 'work_order', 'string']);
  assert.deepEqual(readApprovals(t.dir)[0].mode, null);
  // The same session's own record is used.
  writeMode(t.dir, { value: 'bypassPermissions', at: now().toISOString(), event: 'UserPromptSubmit', session: 'new-session' });
  t.answer('work_order', 'continue');
  await t.next();
  await throughReview(t);
  assert.equal((await t.next()).action.type, 'end');
});

test('next registers the session of a stopped task, so the hook records for the session that resumes it', async () => {
  const t = await task(SMALL);
  await t.next();
  t.order();
  t.report('understand', 'orchestrator');
  await t.next();
  t.answer('work_order', 'stop');
  assert.equal(t.state().status, 'stopped');
  await taskCli(t.h, 'next', t.id, '--session', 'resumed-session');
  assert.equal(sessionTask(t.h.env, 'resumed-session'), t.dir);
});

// ---- the task asks when it cannot go on (0.2.1)

// A trivial task whose Build agent changed nothing and asks a question instead.
async function stuckInBuild(opts) {
  const t = await task(TRIVIAL, opts);
  await t.next();
  t.report('build', 'backend', rep({ evidence: SAFE, questions: 'Which wording do you want?' }));
  return t;
}

test('an Orchestrator that needs an answer raises Needs you, and the answer plans again', async () => {
  const t = await task(SMALL);
  await t.next();
  t.order(order({ agents: [], questions: ['Which table should the index cover?'] }));
  t.report('understand', 'orchestrator', rep({ questions: 'Which table should the index cover?' }));
  const r = await t.next();
  assert.deepEqual([r.action.type, r.action.checkpoint, r.action.header, t.state().status], ['ask', 'needs_you', 'Needs you', 'running']);
  assert.equal(r.action.question, 'Needs you: the Orchestrator needs an answer, 1 question. What should happen?');
  assert.deepEqual(r.action.options.map((o) => o.label), ['Continue with a change', 'Stop here']);
  assert.deepEqual(r.action.summary.split('\n'), [
    '### Needs you: the Orchestrator needs an answer', 'The Orchestrator cannot plan this until you answer.', `Task ${t.id}`, '',
    '**You decide**', '- Which table should the index cover?', '',
    '**Next:** Nothing runs until you answer.', 'The report: understand/stage-report.md',
  ]);
  assert.equal(read(r.action.file), r.action.summary + '\n');
  assert.equal(r.action.file, stageFile(t.dir, 'understand', 'checkpoint', 1, 'md'));
  const before = [JSON.stringify(t.state()), readApprovals(t.dir).length];
  assert.throws(() => t.answer('needs_you', 'continue'), (e) => e.code === 'bad-choice');
  assert.deepEqual([JSON.stringify(t.state()), readApprovals(t.dir).length], before, 'a refused answer changes nothing');
  const note = t.file('change-1.md');
  fs.writeFileSync(note, 'Table dbo.Customer, column Email.\n');
  t.answer('needs_you', 'change', note);
  const again = await t.next();
  assert.deepEqual([again.stage, again.action.type, again.action.waves[0][0].model], ['understand', 'dispatch', 'sonnet']);
  assert.ok(read(stageFile(t.dir, 'understand', 'orchestrator', 2, 'brief.md')).includes(note));
});

test('Build that changed no file asks with the agent\'s question', async () => {
  const t = await stuckInBuild();
  const r = await t.next();
  assert.equal(r.action.checkpoint, 'needs_you');
  assert.equal(r.action.question, 'Needs you: Build changed no file, 1 question. What should happen?');
  assert.ok(r.action.summary.includes('- Which wording do you want?'));
  assert.equal(r.action.options[0].description, 'Build runs again with your answer.');
  assert.equal(t.state().status, 'running');
});

test('under Bypass permissions a task that needs you is parked, and an answer in words restarts it', async () => {
  const t = await stuckInBuild({ mode: 'bypassPermissions' });
  const r = await t.next();
  assert.deepEqual([r.action.type, r.action.status, t.state().blocked], ['end', 'blocked', 'Build changed no file.']);
  assert.ok(r.action.lines.includes(`To go on, say what should happen: /pod-harness:resume ${t.id}.`));
  assert.equal(r.action.lines.some((l) => l.includes('cannot be started again')), false);
  // The developer reads what is asked without opening a file.
  assert.ok(r.action.lines.includes('It needs your answer: Which wording do you want?'));
  assert.ok(r.action.lines.includes(`The question: ${stageFile(t.dir, 'build', 'checkpoint', 1, 'md')}`));
  assert.equal(sessionTask(t.h.env, `sess-${t.id}`), t.dir, 'a parked task stays registered, so the hook still records the mode for it');
  assert.ok(read(stageFile(t.dir, 'build', 'checkpoint', 1, 'md')).includes('- Which wording do you want?'));
  assert.equal((await t.next()).action.status, 'blocked', 'still nothing may be asked');
  assert.deepEqual([t.state().asking.checkpoint, t.state().asking.parked], ['needs_you', true]);
  assert.throws(() => t.answer('needs_you', 'stop'), (e) => e.code === 'bad-choice', 'a waiting task is already stopped');
  const note = t.file('change-1.md');
  fs.writeFileSync(note, 'Say "hello, pod".\n');
  assert.deepEqual(t.answer('needs_you', 'change', note), { ok: true, status: 'running' });
  assert.deepEqual(readApprovals(t.dir).map((e) => [e.outcome, e.answer]), [['skipped', undefined], ['answered', 'change']], 'nothing was asked, so the log does not say "asked"');
  const again = await t.next();
  assert.deepEqual([again.stage, again.action.type, t.state().round.build], ['build', 'dispatch', 2]);
  assert.ok(read(stageFile(t.dir, 'build', 'backend', 2, 'brief.md')).includes(note));
});

test('under Bypass permissions tests that still fail park the task: Review is not started unasked', async () => {
  const t = await task(TRIVIAL, { setup: failingTests, mode: 'bypassPermissions' });
  await t.next();
  build(t);
  let r = await failTests(t);
  for (let i = 0; i < 2; i++) { build(t); r = await failTests(t); }
  assert.equal(r.stage, 'understand');
  t.order();
  t.report('understand', 'orchestrator');
  assert.equal((await t.next()).action.stage, 'build', 'the work order is not asked under Bypass permissions');
  for (let i = 0; i < 3; i++) { build(t); r = await failTests(t); }
  assert.deepEqual([r.action.type, r.action.status, t.state().asking.checkpoint, t.state().round.review], ['end', 'blocked', 'needs_you', 0]);
  assert.deepEqual(t.state().asking.choices, ['continue', 'change', 'stop']);
});

test('a parked question is asked once the mode allows it', async () => {
  const t = await stuckInBuild({ mode: 'bypassPermissions' });
  const parked = await t.next();
  assert.equal(parked.action.status, 'blocked');
  writeMode(t.dir, { value: 'default', at: now().toISOString(), event: 'UserPromptSubmit' });
  const r = await t.next();
  assert.deepEqual([r.action.type, r.action.checkpoint, t.state().status, t.state().asking.parked], ['ask', 'needs_you', 'running', false]);
  assert.equal(r.action.question, 'Needs you: Build changed no file, 1 question. What should happen?');
  assert.deepEqual(readApprovals(t.dir).map((e) => [e.outcome, e.reason]), [['skipped', 'bypass'], ['asked', 'mode']]);
});

test('a parked task is asked in the same session after the developer leaves Bypass permissions: the real hook records for it', async () => {
  const t = await stuckInBuild({ mode: 'bypassPermissions' });
  assert.equal((await t.next()).action.status, 'blocked');
  const input = JSON.stringify({ session_id: `sess-${t.id}`, hook_event_name: 'UserPromptSubmit', permission_mode: 'default' });
  assert.equal(spawnSync(process.execPath, [HOOK], { input, env: { ...process.env, ...t.h.env }, encoding: 'utf8' }).status, 0);
  const r = await t.next();
  assert.deepEqual([r.action.type, r.action.checkpoint], ['ask', 'needs_you']);
});

test('in Plan mode a parked task is not asked, and nothing is written', async () => {
  const t = await stuckInBuild({ mode: 'bypassPermissions' });
  await t.next();
  writeMode(t.dir, { value: 'plan', at: now().toISOString(), event: 'UserPromptSubmit' });
  const before = snapshot(t.dir);
  const r = await t.next();
  assert.deepEqual([r.action.type, r.action.problems[0].fix], ['fix', 'Leave Plan mode, then continue.']);
  assert.deepEqual(snapshot(t.dir), before);
});

test('a Build agent\'s question is asked though files changed, and Continue goes on to Test', async () => {
  const t = await task(FULL);
  await understood(t, order({ agents: [agent('backend'), agent('database')] }));
  await t.next();
  writeFiles(t.h.app, { 'src/greeting.cs': 'hello, pod\n' });
  t.report('build', 'backend', rep({ evidence: SAFE }));
  t.report('build', 'database', rep({ evidence: SAFE, questions: 'Should the index be unique?', notes: 'I went on without the index.' }));
  const r = await t.next();
  assert.deepEqual([r.action.checkpoint, r.action.question], ['needs_you', 'Needs you: a Build agent needs an answer, 1 question. What should happen?']);
  assert.deepEqual(r.action.options.map((o) => [o.label, o.description]), [
    ['Continue', 'Test starts, with the question left open.'],
    ['Continue with a change', 'Build runs again with your answer.'],
    ['Stop here', 'The task keeps everything. /pod-harness:resume continues it.'],
  ]);
  assert.ok(r.action.summary.includes('- Should the index be unique?'));
  t.answer('needs_you', 'continue');
  assert.equal((await t.next()).action.type, 'run');
});

test('a Build agent that asks and changes nothing on a later round is asked too, not sent to Test', async () => {
  const t = await task(TRIVIAL);
  await t.next();
  await throughReview(t, 'Verdict: changes');
  t.answer((await t.next()).action.checkpoint, 'continue');
  assert.equal((await t.next()).action.stage, 'build');
  t.report('build', 'backend', rep({ evidence: SAFE, questions: 'Which of the two findings do you want fixed?' }));
  const r = await t.next();
  assert.deepEqual([r.action.checkpoint, t.state().round.build, t.state().round.test], ['needs_you', 2, 1]);
});

test('a question beside a policy exception is shown with it', async () => {
  const t = await task(FULL);
  await understood(t);
  await t.next();
  writeFiles(t.h.app, { 'src/greeting.cs': 'hello, pod\n' });
  t.report('build', 'backend', rep({ evidence: SAFE, questions: '- Policy exception: pod-migration - drop the old column\n- Which name should the new column have?' }));
  const r = await t.next();
  assert.deepEqual([r.action.checkpoint, r.action.question], ['policy_exception', 'Policy exception: a policy needs your yes, 2 questions. Go on without it?']);
  assert.ok(r.action.summary.includes('- pod-migration - drop the old column\n- Which name should the new column have?'));
});

test('a verdict line that says more keeps the rest', async () => {
  const t = await task(TRIVIAL);
  await t.next();
  build(t);
  await t.next();
  await t.runTests();
  await t.next();
  t.report('review', 'reviewer', rep({ evidence: 'Verdict: approve', summary: 'The change is right.\n**Verdict: approve.** The tests cover it.\nVerdict: approve.' }));
  assert.deepEqual((await t.next()).show.at(-1).lines, ['Verdict: approve.', 'The change is right.', 'The tests cover it.']);
});

test('next registers the session of a parked task, and not of a done one', async () => {
  const t = await stuckInBuild({ mode: 'bypassPermissions' });
  await t.next();
  await taskCli(t.h, 'next', t.id, '--session', 'resumed-session');
  assert.equal(sessionTask(t.h.env, 'resumed-session'), t.dir);
  const done = await task(TRIVIAL, { mode: 'bypassPermissions' });
  await done.next();
  await throughReview(done);
  await done.next();
  await taskCli(done.h, 'next', done.id, '--session', 'late-session');
  assert.equal(sessionTask(done.h.env, 'late-session'), null);
});

test('a work order with questions and agents is a Work order checkpoint that Auto asks', async () => {
  const t = await task(SMALL, { mode: 'auto' });
  await t.next();
  t.order(order({ questions: ['Should the index be unique?'] }));
  t.report('understand', 'orchestrator', rep({ questions: 'should the index be unique?' }));
  const r = await t.next();
  assert.deepEqual([r.action.checkpoint, r.action.question], ['work_order', 'Work order: size S, 1 question. Start Build?']);
  assert.deepEqual(readApprovals(t.dir).map((e) => e.reason), ['auto-decision']);
});

test('in Auto a review with notes only is not asked, and the notes are in the end lines', async () => {
  const t = await task(TRIVIAL, { mode: 'auto' });
  await t.next();
  build(t);
  assert.equal((await t.next()).action.type, 'run');
  await t.runTests();
  await t.next();
  t.report('review', 'reviewer', rep({ evidence: 'Verdict: approve', notes: 'The work is uncommitted. Deliver must commit it.' }));
  const r = await t.next();
  assert.deepEqual([r.action.type, r.action.status], ['end', 'done']);
  assert.ok(r.action.lines.includes('Note from the review: The work is uncommitted. Deliver must commit it.'));
  assert.deepEqual(readApprovals(t.dir).map((e) => [e.checkpoint, e.outcome, e.reason]), [['review_result', 'skipped', 'auto-nothing-to-decide']]);
});

test('a question the review leaves is asked in Auto and named in the end lines', async () => {
  const t = await task(TRIVIAL, { mode: 'auto' });
  await t.next();
  build(t);
  await t.next();
  await t.runTests();
  await t.next();
  t.report('review', 'reviewer', rep({ evidence: 'Verdict: approve', questions: 'Should the greeting be translated?' }));
  const r = await t.next();
  assert.equal(r.action.question, 'Review result: approved, 1 question. Close the task?');
  t.answer('review_result', 'continue');
  assert.ok((await t.next()).action.lines.includes('Left open at the review: Should the greeting be translated?'));
});

test('the review lines show the verdict once', async () => {
  const t = await task(TRIVIAL);
  await t.next();
  build(t);
  await t.next();
  await t.runTests();
  await t.next();
  t.report('review', 'reviewer', rep({ evidence: 'Verdict: approve', summary: 'The change is right.\nVerdict: approve.' }));
  const r = await t.next();
  assert.deepEqual(r.show.at(-1).lines, ['Verdict: approve.', 'The change is right.']);
});

test('a task that is done says so when nothing is left open', async () => {
  const t = await task(TRIVIAL, { mode: 'bypassPermissions' });
  await t.next();
  await throughReview(t);
  assert.ok((await t.next()).action.lines.includes('The last review left nothing open.'));
});

// ---- what the developer decided travels with the task (0.2.2)

const WORDING = 'Which wording do you want?';

// A trivial task whose Build agent changed a file and asked: "Needs you" is open.
async function buildAsks(opts) {
  const t = await task(TRIVIAL, opts);
  await t.next();
  writeFiles(t.h.app, { 'src/greeting.cs': 'hello, pod\n' });
  t.report('build', 'backend', rep({ evidence: SAFE, questions: WORDING }));
  return { t, asked: await t.next() };
}

// From an open Build question to the next Build round: Continue, the tests, a review that asks for changes.
async function backToBuild(t, checkpoint = 'needs_you') {
  t.answer(checkpoint, 'continue');
  assert.equal((await t.next()).action.type, 'run');
  await t.runTests();
  assert.equal((await t.next()).action.stage, 'review');
  t.report('review', 'reviewer', rep({ evidence: 'Verdict: changes' }));
  t.answer((await t.next()).action.checkpoint, 'continue');
  assert.equal((await t.next()).action.stage, 'build');
}

test('an answer given in Understand is kept and named in the briefs of Build and Review', async () => {
  const t = await task(SMALL);
  await t.next();
  t.order(order({ agents: [], questions: ['Which table should the index cover?'] }));
  t.report('understand', 'orchestrator');
  const asked = await t.next();
  const note = t.file('change-1.md');
  fs.writeFileSync(note, 'Table dbo.Customer, column Email.\n');
  t.answer('needs_you', 'change', note);
  assert.deepEqual(t.state().decisions, [{ kind: 'answer', stage: 'understand', note, question: asked.action.file }]);
  await understood(t);
  assert.equal(t.state().decisions.length, 1, 'Continue where nothing was asked records nothing');
  assert.equal((await t.next()).action.stage, 'build');
  const decided = `They are decided. Do not ask them again:\n- \`${note}\`, the answer to \`${asked.action.file}\``;
  assert.ok(read(stageFile(t.dir, 'build', 'backend', 1, 'brief.md')).includes(decided));
  await throughReview(t);
  assert.ok(read(stageFile(t.dir, 'review', 'reviewer', 1, 'brief.md')).includes(decided));
});

test('a Build question left open with Continue is not asked again in a later round, and the end lines name it', async () => {
  const { t, asked } = await buildAsks();
  assert.deepEqual(asked.action.summary.split('\n'), [
    '### Needs you: a Build agent needs an answer', `Task ${t.id}, App, branch task/${t.id}`, '',
    '**You decide**', `- ${WORDING}`, '',
    '**Next:** Test starts, with the question left open.', 'The report: build/stage-report.md',
  ]);
  await backToBuild(t);
  assert.deepEqual(t.state().decisions[0], { kind: 'left-open', stage: 'build', questions: [WORDING], question: asked.action.file });
  const leftOpen = `The developer saw these questions and chose to go on. Do not ask them again. Work without an answer and say under Notes what you assumed:\n- ${WORDING}\n\n`;
  assert.ok(read(stageFile(t.dir, 'build', 'backend', 2, 'brief.md')).includes(leftOpen));
  build(t, undefined, SAFE, { questions: 'Which wording should the greeting have?' });
  const again = await t.next();
  assert.deepEqual([again.action.type, again.stage], ['run', 'test'], 'asked once for this work order');
  assert.ok(read(again.show[0].report).includes('- Which wording should the greeting have?'), 'the stage report keeps it');
  assert.equal(again.show[0].lines.at(-1), 'Not asked again, left open: Which wording should the greeting have?');
  assert.deepEqual(t.state().decisions.at(-1), { kind: 'not-asked', stage: 'build', questions: ['Which wording should the greeting have?'], question: again.show[0].report });
  await t.runTests();
  assert.equal((await t.next()).action.stage, 'review');
  const review = read(stageFile(t.dir, 'review', 'reviewer', 2, 'brief.md'));
  assert.ok(review.includes(leftOpen) && !review.includes('Which wording should the greeting have?'), 'the developer did not see the later question: no brief says so');
  t.report('review', 'reviewer', rep({ evidence: 'Verdict: approve' }));
  t.answer((await t.next()).action.checkpoint, 'continue');
  const { lines } = (await t.next()).action;
  assert.deepEqual(lines.filter((l) => l.startsWith('Left open in Build')), [`Left open in Build: ${WORDING}`, 'Left open in Build: Which wording should the greeting have?']);
});

test('a new work order starts the count again: its first Build question is asked', async () => {
  const { t } = await buildAsks();
  await backToBuild(t);
  build(t, { 'src/a.cs': 'a\n', 'src/b.cs': 'b\n', 'src/c.cs': 'c\n' });
  assert.equal((await t.next()).action.checkpoint, 'task_grew');
  t.answer('task_grew', 'continue');
  await understood(t);
  assert.equal((await t.next()).action.stage, 'build');
  build(t, undefined, SAFE, { questions: 'Should the old greeting stay?' });
  const r = await t.next();
  assert.deepEqual([r.action.checkpoint, r.action.question], ['needs_you', 'Needs you: a Build agent needs an answer, 1 question. What should happen?']);
});

test('an answer in words starts the count again: what Build asks after it is asked', async () => {
  const { t } = await buildAsks();
  const note = t.file('change-1.md');
  fs.writeFileSync(note, 'Say "hello, pod".\n');
  t.answer('needs_you', 'change', note);
  assert.equal((await t.next()).action.stage, 'build');
  build(t, undefined, SAFE, { questions: 'Should the old greeting stay?' });
  assert.equal((await t.next()).action.question, 'Needs you: a Build agent needs an answer, 1 question. What should happen?');
});

test('when the work order holds questions, the checkpoint shows those and not the report\'s wording as well', async () => {
  const none = await task(SMALL);
  await none.next();
  none.order(order({ agents: [], questions: ['Which table should the index cover?'] }));
  none.report('understand', 'orchestrator', rep({ questions: 'Which table is the index for: Customer or Orders?' }));
  const r = await none.next();
  assert.equal(r.action.question, 'Needs you: the Orchestrator needs an answer, 1 question. What should happen?');
  assert.equal(r.action.summary.includes('Customer or Orders'), false);

  const some = await task(SMALL, { mode: 'auto' });
  await some.next();
  some.order(order({ questions: ['Should the index be unique?'] }));
  some.report('understand', 'orchestrator', rep({ questions: 'Is a unique index wanted here?' }));
  assert.equal((await some.next()).action.question, 'Work order: size S, 1 question. Start Build?');

  // A work order without questions still shows what the Orchestrator's report asks.
  const report = await task(SMALL, { mode: 'auto' });
  await report.next();
  report.order();
  report.report('understand', 'orchestrator', rep({ questions: 'Is a unique index wanted here?' }));
  assert.equal((await report.next()).action.question, 'Work order: size S, 1 question. Start Build?');
});

// A state file as 0.2.1 wrote it.
function asBefore(t) {
  const old = t.state();
  delete old.decisions;
  delete old.build_asked;
  writeState(t.dir, old);
}

test('a task started before 0.2.2 has no list of decisions: it is read as empty', async () => {
  const answered = await stuckInBuild();
  await answered.next();
  asBefore(answered);
  const note = answered.file('change-1.md');
  fs.writeFileSync(note, 'Say "hello, pod".\n');
  answered.answer('needs_you', 'change', note);
  assert.deepEqual(answered.state().decisions.map((d) => [d.kind, d.note]), [['answer', note]]);
  assert.equal((await answered.next()).action.stage, 'build');

  const { t: left } = await buildAsks();
  asBefore(left);
  left.answer('needs_you', 'continue');
  assert.deepEqual(left.state().decisions.map((d) => d.kind), ['left-open']);

  const plain = await task(TRIVIAL, { mode: 'bypassPermissions' });
  await plain.next();
  asBefore(plain);
  await throughReview(plain);
  const end = await plain.next();
  assert.deepEqual([end.action.status, end.action.lines.some((l) => l.startsWith('Left open'))], ['done', false]);
});

test('a policy exception left with Continue is not listed as left open; the question beside it is, and is not asked again', async () => {
  const t = await task(TRIVIAL);
  await t.next();
  writeFiles(t.h.app, { 'src/greeting.cs': 'hello, pod\n' });
  const name = 'Which name should the new column have?';
  t.report('build', 'backend', rep({ evidence: SAFE, questions: `- Policy exception: pod-migration - drop the old column\n- ${name}` }));
  const asked = await t.next();
  assert.equal(asked.action.checkpoint, 'policy_exception');
  await backToBuild(t, 'policy_exception');
  assert.deepEqual(t.state().decisions, [{ kind: 'left-open', stage: 'build', questions: [name], question: asked.action.file }]);
  assert.equal(read(stageFile(t.dir, 'build', 'backend', 2, 'brief.md')).includes('drop the old column'), false, 'going on without it is not a yes');
  build(t, undefined, SAFE, { questions: name });
  assert.equal((await t.next()).action.type, 'run', 'the question was shown beside the exception: it is not asked a second time');
});

test('Continue at a parked Build question records it and goes on to Test', async () => {
  const { t, asked } = await buildAsks({ mode: 'bypassPermissions' });
  assert.equal(asked.action.status, 'blocked');
  t.answer('needs_you', 'continue');
  assert.deepEqual(t.state().decisions.map((d) => [d.kind, d.questions]), [['left-open', [WORDING]]]);
  assert.equal((await t.next()).action.type, 'run');
});

test('a question left open at the review is not printed as left open in Build', async () => {
  const t = await task(TRIVIAL, { mode: 'auto' });
  await t.next();
  await throughReview(t);
  t.report('review', 'reviewer', rep({ evidence: 'Verdict: approve', questions: 'Should the greeting be translated?' }));
  t.answer((await t.next()).action.checkpoint, 'continue');
  const { lines } = (await t.next()).action;
  assert.deepEqual(lines.filter((l) => l.startsWith('Left open')), ['Left open at the review: Should the greeting be translated?']);
});

test('an M work order with a question of its own still says that Design and Plan are skipped', async () => {
  const t = await task(FULL);
  await t.next();
  t.order(order({ size: 'M', questions: ['Should the index be unique?'] }));
  t.report('understand', 'orchestrator', rep({ questions: 'Is a unique index wanted here?' }));
  const r = await t.next();
  assert.equal(r.action.question, 'Work order: size M, 2 questions. Start Build?');
  assert.ok(r.action.summary.includes('- Should the index be unique?\n- The Design and Plan stages are not in this version'));
});

// ---- a round that changes nothing (0.2.3)

const SCRIPT = 'Should the always-failing test script be fixed?';

// A trivial task whose tests fail: Build round 1 changed a file, the Tester reported, Build round 2 is dispatched.
async function sentBackByTests(opts = {}) {
  const t = await task(TRIVIAL, { setup: failingTests, ...opts });
  await t.next();
  build(t);
  const back = await failTests(t);
  assert.deepEqual([back.action.stage, t.state().round.build], ['build', 2]);
  return t;
}

test('a round sent back by failing tests that changes nothing stops the loop and asks, with Review on offer', async () => {
  const t = await sentBackByTests();
  t.report('build', 'backend', rep({ evidence: SAFE, questions: SCRIPT }));
  const r = await t.next();
  assert.deepEqual([r.action.type, r.action.checkpoint], ['ask', 'needs_you']);
  assert.equal(r.action.question, 'Needs you: Build changed nothing and the tests still fail, 1 question. What should happen?');
  assert.deepEqual(r.action.summary.split('\n').slice(0, 5), [
    '### Needs you: Build changed nothing and the tests still fail', `Task ${t.id}, App, branch task/${t.id}`, '',
    '**You decide**', `- ${SCRIPT}`,
  ]);
  assert.deepEqual(r.action.options.map((o) => o.label), ['Continue', 'Continue with a change', 'Stop here']);
  assert.equal(r.action.options[0].description, 'Review starts, with the failing tests on record.');
  assert.deepEqual([t.state().round.build, t.state().round.test, t.state().returns.test], [2, 1, 1], 'no third round was started');
});

test('Continue there starts the Review with the failing test result', async () => {
  const t = await sentBackByTests();
  t.report('build', 'backend', rep({ evidence: SAFE }));
  assert.equal((await t.next()).action.checkpoint, 'needs_you');
  t.answer('needs_you', 'continue');
  const review = await t.next();
  assert.deepEqual([review.stage, review.action.waves[0][0].key, t.state().round.build], ['review', 'reviewer', 2]);
  assert.ok(read(stageFile(t.dir, 'review', 'reviewer', 1, 'brief.md')).includes(stageFile(t.dir, 'test', 'result', 1, 'json')));
});

test('Continue with a change there runs Build again with the answer and the Tester\'s report, and gives the loop its rounds back', async () => {
  const t = await sentBackByTests();
  t.report('build', 'backend', rep({ evidence: SAFE }));
  assert.equal((await t.next()).action.checkpoint, 'needs_you');
  const note = t.file('change-1.md');
  fs.writeFileSync(note, 'Replace the test script.\n');
  t.answer('needs_you', 'change', note);
  const back = await t.next();
  assert.deepEqual([back.action.stage, t.state().round.build, t.state().returns.test], ['build', 3, 0]);
  const brief = read(stageFile(t.dir, 'build', 'backend', 3, 'brief.md'));
  assert.ok(brief.includes(note) && brief.includes(stageFile(t.dir, 'test', 'tester', 1, 'md')));
});

test('a round sent back by the review that changes nothing asks with two choices', async () => {
  const t = await task(TRIVIAL);
  await t.next();
  await throughReview(t, 'Verdict: changes');
  t.answer((await t.next()).action.checkpoint, 'continue');
  assert.deepEqual([(await t.next()).action.stage, t.state().round.build], ['build', 2]);
  t.report('build', 'backend', rep({ evidence: SAFE }));
  const r = await t.next();
  assert.deepEqual([r.action.checkpoint, r.action.question], ['needs_you', 'Needs you: Build changed no file. What should happen?']);
  assert.deepEqual(r.action.options.map((o) => o.label), ['Continue with a change', 'Stop here']);
});

test('a later round that changes a file goes on, though the branch already had changes', async () => {
  const t = await sentBackByTests();
  build(t);
  assert.deepEqual([(await t.next()).action.type, t.state().stage], ['run', 'test']);
});

test('a missing report dispatched again keeps the round\'s starting point', async () => {
  const t = await sentBackByTests();
  const before = t.state().build_before;
  assert.deepEqual([before.round, Object.keys(before.repos)], [2, [APP]]);
  t.later(60);
  const again = await t.next();
  assert.deepEqual([again.action.type, again.action.stage, t.state().round.build], ['dispatch', 'build', 2]);
  assert.deepEqual(t.state().build_before, before);
  t.report('build', 'backend', rep({ evidence: SAFE }));
  assert.equal((await t.next()).action.checkpoint, 'needs_you');
});

test('a Build round started before 0.2.3 has no starting point: the branch is measured, as before', async () => {
  const t = await sentBackByTests();
  const old = t.state();
  delete old.build_before;
  writeState(t.dir, old);
  t.report('build', 'backend', rep({ evidence: SAFE }));
  assert.deepEqual([(await t.next()).action.type, t.state().stage], ['run', 'test']);
});

test('under Bypass permissions a round that changes nothing after failing tests parks the task', async () => {
  const t = await sentBackByTests({ mode: 'bypassPermissions' });
  t.report('build', 'backend', rep({ evidence: SAFE }));
  const r = await t.next();
  assert.deepEqual([r.action.type, r.action.status, t.state().asking.checkpoint, t.state().round.review], ['end', 'blocked', 'needs_you', 0]);
  assert.ok(r.action.lines.some((l) => l.includes('Build changed nothing and the tests still fail')), r.action.lines.join(' | '));
});

// ---- a plan made after the loop was used up (0.2.3)

test('the work order written after the tests kept failing is asked in Auto, as Task grew', async () => {
  const t = await task(SMALL, { setup: failingTests, mode: 'auto' });
  await t.next();
  t.order();
  t.report('understand', 'orchestrator');
  assert.equal((await t.next()).action.stage, 'build', 'a first work order with no question is not asked in Auto');
  build(t);
  let r = await failTests(t);
  for (let i = 0; i < 2; i++) { build(t); r = await failTests(t); }
  assert.deepEqual([r.stage, t.state().returns.reroute], ['understand', 1]);
  t.order();
  t.report('understand', 'orchestrator');
  r = await t.next();
  assert.deepEqual([r.action.type, r.action.checkpoint], ['ask', 'task_grew']);
  assert.equal(r.action.question, 'Task grew: a new plan after the tests kept failing. Start Build?');
  assert.deepEqual(r.action.options.map((o) => o.label), ['Continue', 'Continue with a change', 'Stop here']);
  assert.deepEqual(readApprovals(t.dir).map((e) => [e.checkpoint, e.outcome, e.reason]), [
    ['work_order', 'skipped', 'auto-nothing-to-decide'], ['task_grew', 'asked', 'auto-decision'],
  ]);
  t.answer('task_grew', 'continue');
  assert.equal((await t.next()).action.stage, 'build');
});
