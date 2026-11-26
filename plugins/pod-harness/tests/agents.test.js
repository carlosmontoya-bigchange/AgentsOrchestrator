'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pluginRoot } = require('./helpers');
const { readDefaults } = require('../scripts/lib/store.js');

// name: [model, effort, maxTurns]
const AGENTS = {
  orchestrator: ['opus', 'high', 30], explorer: ['haiku', 'low', 20], backend: ['sonnet', 'medium', 150], frontend: ['sonnet', 'medium', 150],
  database: ['sonnet', 'medium', 150], tester: ['sonnet', 'low', 40], reviewer: ['opus', 'high', 60],
};
const BUILD = ['backend', 'frontend', 'database'];
const names = Object.keys(AGENTS);

// The frontmatter as { key: value } and the text after it.
function agent(name) {
  const text = fs.readFileSync(path.join(pluginRoot, 'agents', `${name}.md`), 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  assert.ok(m, `${name}: no frontmatter`);
  const meta = Object.fromEntries(m[1].split('\n').map((line) => { const at = line.indexOf(':'); return [line.slice(0, at).trim(), line.slice(at + 1).trim()]; }));
  return { meta, body: m[2], tools: (meta.tools || '').split(',').map((t) => t.trim()).filter(Boolean) };
}

test('there are exactly the seven agents of this version', () => {
  assert.deepEqual(fs.readdirSync(path.join(pluginRoot, 'agents')).sort(), names.map((n) => `${n}.md`).sort());
});

test('each agent has its name, model, effort, a tools list and maxTurns', () => {
  for (const [name, [model, effort, turns]] of Object.entries(AGENTS)) {
    const { meta, tools } = agent(name);
    assert.deepEqual([meta.name, meta.model, meta.effort, Number(meta.maxTurns)], [name, model, effort, turns], name);
    assert.ok(meta.description.length >= 40, `${name}: description`);
    assert.ok(tools.length >= 4 && tools.includes('Read') && tools.includes('Write'), `${name}: tools`);
    for (const ignored of ['hooks', 'mcpServers', 'permissionMode']) assert.equal(meta[ignored], undefined, `${name}: ${ignored} is ignored in a plugin agent`);
  }
});

test('the default models match teams.models in the shipped defaults', () => {
  const models = readDefaults(pluginRoot).sections.Teams.models;
  for (const name of names) assert.equal(agent(name).meta.model, models[name], name);
});

test('only the Build agents can Edit; the Orchestrator and Explorer have no shell and skip CLAUDE.md', () => {
  for (const name of names) {
    const { meta, tools } = agent(name);
    assert.equal(tools.includes('Edit'), BUILD.includes(name), `${name}: Edit`);
    const outside = name === 'orchestrator' || name === 'explorer';
    assert.equal(tools.includes('Bash') || tools.includes('PowerShell'), !outside, `${name}: shell`);
    assert.equal(meta.omitClaudeMd, outside ? 'true' : undefined, `${name}: omitClaudeMd`);
  }
});

test('only the Orchestrator has the Agent tool, and it names the Explorer as the one agent it may dispatch', () => {
  for (const name of names) assert.equal(agent(name).tools.includes('Agent'), name === 'orchestrator', name);
  const { body } = agent('orchestrator');
  assert.ok(body.includes('The only agent you may dispatch is `pod-harness:explorer`'));
  assert.match(body, /never dispatch a Build agent/i);
});

test('every agent is told to read its brief first and what to return', () => {
  for (const name of names) {
    const { body } = agent(name);
    assert.ok(body.includes('Your prompt gives you the path of a brief. Read it first. It is your whole task.'), name);
    if (name === 'explorer') assert.ok(body.includes('context.json') && /write no report/i.test(body), name);
    else {
      assert.ok(body.includes('your Summary and the path of your report'), name);
      assert.ok(body.includes('If you need a skill you do not have, say so under Notes.'), name);
      assert.ok(body.includes('Under Questions write only what a person must decide for this work, each as one question.'), name);
      assert.equal(body.includes('Open points'), false, name);
      assert.ok(body.includes('Summary, Did, Found, Changed files, Evidence, Questions, Notes, Next'), name);
    }
  }
});

test('a Build agent asks instead of guessing, and the Orchestrator may leave the agents empty', () => {
  for (const name of ['backend', 'frontend', 'database']) assert.ok(agent(name).body.includes('If you cannot do the job without a decision from a person, change nothing and put the decision under Questions.'), name);
  assert.ok(agent('orchestrator').body.includes('If nothing can be built until a person decides something, write the work order with the questions and an empty `agents` list. Do not guess.'));
});

test('every agent that gets the developer\'s decisions is told not to ask them again', () => {
  for (const name of names.filter((n) => n !== 'explorer')) {
    assert.ok(agent(name).body.includes('If the brief lists what the developer decided, it is decided: do not ask it again.'), name);
  }
});

test('each agent names its marker line', () => {
  for (const name of BUILD) assert.ok(agent(name).body.includes('`Sensitive change: yes` or `Sensitive change: no`'), name);
  assert.ok(agent('tester').body.includes('`Result: pass` or `Result: fail`'));
  assert.ok(agent('reviewer').body.includes('`Verdict: approve` or `Verdict: changes`'));
  for (const name of ['orchestrator', 'explorer']) assert.equal(/Sensitive change:|Result:|Verdict:/.test(agent(name).body), false, name);
});

test('no agent is told to push, open a pull request or write to the tracker', () => {
  for (const name of names) {
    const { body } = agent(name);
    assert.match(body, /never (commit, )?push, open a pull request,? (or )?write to the tracker/i, name);
  }
});

test('each agent keeps to its job', () => {
  const body = (name) => agent(name).body;
  assert.match(body('orchestrator'), /never edit code/i);
  assert.match(body('explorer'), /Do not read whole files/);
  assert.match(body('tester'), /Fix nothing/);
  assert.match(body('reviewer'), /never edit/i);
  assert.match(body('reviewer'), /only to read/i);
  assert.match(body('reviewer'), /must (be tested|test) by hand/i);
  assert.match(body('database'), /never run anything against shared or production data/i);
  assert.match(body('frontend'), /accessibility/i);
  for (const name of BUILD) assert.match(body(name), /never commit/i, name);
  for (const name of BUILD) assert.match(body(name), /automated tests/i, name);
});

test('every key under teams.models that phase 2 uses has an agent file', () => {
  const uses = { orchestrator: 'orchestrator', orchestrator_small: 'orchestrator', explorer: 'explorer', backend: 'backend', frontend: 'frontend', database: 'database', tester: 'tester', reviewer: 'reviewer', reviewer_trivial: 'reviewer' };
  const models = readDefaults(pluginRoot).sections.Teams.models;
  for (const [key, file] of Object.entries(uses)) {
    assert.ok(models[key], `teams.models.${key}`);
    assert.ok(fs.existsSync(path.join(pluginRoot, 'agents', `${file}.md`)), file);
  }
});
