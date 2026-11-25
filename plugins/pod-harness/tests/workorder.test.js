'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, APP, WEB, podHome, podConfig } = require('./helpers');
const wo = require('../scripts/lib/workorder.js');

// The example of the plan: one backend agent in App.
const example = (change = {}) => ({
  format: 1, size: 'S', summary: 'Add a stock line type to the quote export.', repos: [APP],
  agents: [{ stage: 'build', agent: 'backend', repo: APP, job: 'Add the line type to QuoteExport and its unit tests.', effort: 'medium', read: ['src/Quotes/QuoteExport.cs:40-90'] }],
  checks: [], risks: [], open_points: [], debate: false, ...change,
});
const agent = (name, repo = APP, extra = {}) => ({ stage: 'build', agent: name, repo, job: 'Do the job.', ...extra });
const config = () => podConfig(podHome());

test('the example work order of this plan has no problems', () => {
  assert.deepEqual(wo.validateWorkOrder(example(), config()), []);
});

test('a missing file is no order and no problem; broken JSON is one problem and no order', () => {
  const dir = tempDir();
  assert.deepEqual(wo.readWorkOrder(dir), { order: null, problems: [] });
  fs.writeFileSync(path.join(dir, 'work-order.json'), '{ "format": 1,');
  const r = wo.readWorkOrder(dir);
  assert.deepEqual([r.order, r.problems.length], [null, 1]);
  assert.match(r.problems[0], /not valid JSON/);
  fs.writeFileSync(path.join(dir, 'work-order.json'), JSON.stringify(example()));
  assert.deepEqual(wo.readWorkOrder(dir), { order: example(), problems: [] });
});

test('something that is not a work order is one problem, not a crash', () => {
  for (const value of [null, [], 'text', 7]) assert.equal(wo.validateWorkOrder(value, config()).length, 1, JSON.stringify(value));
  assert.ok(wo.validateWorkOrder({}, config()).length >= 4);
});

test('a repo the pod does not have, an unknown agent and an empty job are each named', () => {
  const problems = wo.validateWorkOrder(example({
    repos: [APP, '../x'],
    agents: [agent('architect'), agent('backend', '../x', { job: ' ' }), agent('backend', WEB), { ...agent('database'), stage: 'review' }, agent('frontend', APP, { effort: 'max' })],
  }), config());
  assert.deepEqual(problems, [
    'The repo ../x is not set up for this pod.',
    'Agent 1: "architect" is not a Build agent. Use backend, frontend or database.',
    'Agent 2: it has no job.',
    'Agent 3: its repo is not in "repos".',
    'Agent 4: the stage must be "build".',
    'Agent 5: the effort must be low, medium or high.',
    'The work order has 5 Build agents. This pod allows 4 in one stage.',
  ]);
});

test('a repo with no folder on this machine is a problem', () => {
  const c = config();
  c.repos[1].path = path.join(tempDir(), 'missing');
  assert.deepEqual(wo.validateWorkOrder(example({ repos: [WEB], agents: [agent('frontend', WEB)] }), c), ['Web has no folder on this machine.']);
});

test('more agents than the pod allows is a problem', () => {
  const five = wo.validateWorkOrder(example({ repos: [APP, WEB], agents: [agent('backend'), agent('database'), agent('frontend', WEB), agent('backend', WEB), agent('database', WEB)] }), config());
  assert.deepEqual(five, ['The work order has 5 Build agents. This pod allows 4 in one stage.']);
  const three = wo.validateWorkOrder(example({ agents: [agent('backend'), agent('backend'), agent('backend')] }), config());
  assert.deepEqual(three, ['The work order has 3 backend agents. This pod allows 2 of one kind.']);
});

test('size trivial is refused from an agent and accepted from the script', () => {
  assert.deepEqual(wo.validateWorkOrder(example({ size: 'trivial' }), config()), ['The size must be S, M or L.']);
  assert.deepEqual(wo.validateWorkOrder(example({ size: 'trivial' }), config(), { script: true }), []);
  assert.deepEqual(wo.validateWorkOrder(example({ size: 'XL' }), config(), { script: true }), ['The size must be S, M or L.']);
});

test('the summary, the format and the lists are checked', () => {
  const problems = wo.validateWorkOrder(example({ format: 2, summary: 'x'.repeat(201), agents: [], checks: 'run it', risks: [7], open_points: null }), config());
  assert.deepEqual(problems, [
    'The format must be 1.',
    'The summary must be one sentence of at most 200 characters.',
    'The work order names no Build agent.',
    '"checks" must be a list of sentences.',
    '"risks" must be a list of sentences.',
    '"open_points" must be a list of sentences.',
  ]);
});

test('keys number the repeats', () => {
  const keyed = wo.withKeys(example({ agents: [agent('backend'), agent('backend'), agent('database'), agent('backend')] }));
  assert.deepEqual(keyed.map((a) => a.key), ['backend', 'backend-2', 'database', 'backend-3']);
  assert.equal(keyed[0].job, 'Do the job.');
});

test('agents in the same repo never share a wave', () => {
  const [a, b, c] = wo.withKeys(example({ agents: [agent('backend', 'r1'), agent('database', 'r1'), agent('frontend', 'r2')] }));
  assert.deepEqual(wo.waves([a, b, c]), [[a, c], [b]]);
  assert.deepEqual(wo.waves([]), []);
});

test('the first matching specialist glob wins, and backend is the fallback', () => {
  const [app] = config().repos;
  assert.equal(wo.specialistFor(app, 'db/x.SQL'), 'database');
  assert.equal(wo.specialistFor(app, 'src/a.cs'), 'backend');
  assert.equal(wo.specialistFor({ specialists: [{ glob: '**/*.tsx', agent: 'frontend' }] }, 'src/a.cs'), 'backend');
  assert.equal(wo.specialistFor({ specialists: [{ glob: '**', agent: 'reviewer' }] }, 'src/a.cs'), 'backend');
  assert.equal(wo.specialistFor({}, 'src/a.cs'), 'backend');
});

test('the fast order has one Build agent for the place', () => {
  const c = config();
  const order = wo.fastOrder(c.repos[0], ['db/fix.sql', 'src/a.cs']);
  assert.deepEqual([order.size, order.repos, order.agents.length, order.agents[0].agent, order.agents[0].repo, order.agents[0].read],
    ['trivial', [APP], 1, 'database', APP, ['db/fix.sql', 'src/a.cs']]);
  assert.equal(order.agents[0].job, 'Make the change in the request, with its automated tests.');
  assert.deepEqual(wo.validateWorkOrder(order, c, { script: true }), []);
});

test('a context file needs a list of found places, each with a path', () => {
  const dir = tempDir();
  const write = (value) => fs.writeFileSync(path.join(dir, 'context.json'), typeof value === 'string' ? value : JSON.stringify(value));
  assert.deepEqual(wo.readContext(dir), { context: null, problems: [] });
  write({ format: 1, found: [{ repo: APP, path: 'src/a.cs', lines: '10-40', why: 'the export loop' }], missing: [] });
  assert.deepEqual(wo.readContext(dir).problems, []);
  assert.equal(wo.readContext(dir).context.found[0].path, 'src/a.cs');
  for (const value of ['{ broken', [], { found: 'x' }, { found: [{ why: 'no path' }] }]) {
    write(value);
    const r = wo.readContext(dir);
    assert.deepEqual([r.context, r.problems.length], [null, 1], JSON.stringify(value));
  }
});
