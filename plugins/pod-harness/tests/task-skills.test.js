'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pluginRoot } = require('./helpers');
const { COMMANDS } = require('../scripts/cli.js');
const { TASK_COMMANDS } = require('../scripts/task.js');

const read = (file) => fs.readFileSync(path.join(pluginRoot, file), 'utf8');
const skill = (name) => read(`skills/${name}/SKILL.md`);
const front = (text) => text.slice(0, text.indexOf('\n---', 4));
const setupStep = (n) => { const text = skill('setup'); return text.slice(text.indexOf(`### ${n}. `), n === 12 ? undefined : text.indexOf(`### ${n + 1}. `)); };

test('task and resume have frontmatter with name, description, model sonnet and effort medium', () => {
  for (const name of ['task', 'resume']) {
    const head = front(skill(name));
    assert.match(head, new RegExp(`^---\\r?\\nname: ${name}\\r?\\n`));
    assert.match(head, /\ndescription: .{40,}/);
    assert.match(head, /\nmodel: sonnet(\r?\n|$)/);
    assert.match(head, /\neffort: medium(\r?\n|$)/);
  }
  assert.match(front(skill('task')), /\nargument-hint: <what to do, or a work item id>/);
});

test('every task.js command a skill names exists', () => {
  for (const name of ['task', 'resume', 'setup', 'doctor', 'export']) {
    const text = skill(name);
    for (const m of text.matchAll(/task\.js" ([a-z-]+)/g)) assert.ok(TASK_COMMANDS.includes(m[1]), `${name}: task.js ${m[1]}`);
    for (const m of text.matchAll(/cli\.js" ([a-z-]+)/g)) assert.ok(COMMANDS.includes(m[1]), `${name}: cli.js ${m[1]}`);
  }
  const used = [...skill('task').matchAll(/task\.js" ([a-z-]+)/g)].map((m) => m[1]);
  for (const command of ['start', 'next', 'answer', 'quiet']) assert.ok(used.includes(command), `task never runs ${command}`);
  assert.ok(skill('resume').includes('task.js" status'));
});

test('task handles every action type the engine returns', () => {
  const text = skill('task');
  for (const type of ['dispatch', 'run', 'wait', 'ask', 'fix', 'end']) assert.ok(text.includes('`' + type + '`'), type);
  assert.match(text, /subagent_type/);
  assert.match(text, /exactly as given/);
  assert.match(text, /in the background/);
});

test('task passes the session id on start and next', () => {
  const text = skill('task');
  assert.match(text, /task\.js" start [^\n]*--session \$\{CLAUDE_SESSION_ID\}/);
  assert.match(text, /task\.js" next <id> --session \$\{CLAUDE_SESSION_ID\}/);
});

test('task never asks for a typed phrase and names no outward action as its own', () => {
  const text = skill('task');
  assert.match(text, /[Nn]ever ask the developer to type an approval phrase/);
  assert.match(text, /question dialog/);
  assert.match(text, /no commit, push, pull request or tracker write/);
  assert.doesNotMatch(text, /type (the word|"|`)?(Accept|Approve|yes)/i);
  for (const outward of ['git push', 'git commit', 'gh pr', 'az repos']) assert.equal(text.includes(outward), false, outward);
  assert.match(text, /secret/i);
});

test('task writes only the request, the item and change notes, and gives an agent only its prompt', () => {
  const text = skill('task');
  assert.match(text, /[Nn]ever edit `state\.json`, a work order, a brief or a stage report/);
  assert.match(text, /only the `prompt`/);
  assert.match(text, /customer/); // an item's customer names and data stay out of item.md
  assert.match(text, /read-only/);
});

test('task starts in Plan mode only after plan approval', () => {
  const text = skill('task');
  const plan = text.slice(text.indexOf('## Plan mode'), text.indexOf('## ', text.indexOf('## Plan mode') + 5));
  assert.ok(plan.length > 100);
  assert.match(plan, /run nothing that writes/i);
  assert.match(plan, /plan approval/);
  assert.ok(text.indexOf('## Plan mode') < text.indexOf('task.js" start'), 'Plan mode is handled before anything is started');
});

test('resume lists the open tasks, then continues in the task skill', () => {
  const text = skill('resume');
  assert.match(text, /not `done`/);
  assert.match(text, /`pod-harness:task` skill with the Skill tool/);
  assert.match(text, /Loop/);
  assert.match(text, /argument-hint: \[task id\]/);
});

test('setup probes the agents in step 1, asks for skills in step 4, counts with trivial-count in step 8 and asks the branch pattern in step 11', () => {
  assert.match(setupStep(1), /pod-harness:explorer/);
  assert.match(setupStep(1), /pod-harness:orchestrator/);
  assert.match(setupStep(1), /Reply with the single word: ready/);
  assert.match(setupStep(1), /haiku[^\n]*sonnet[^\n]*opus/);
  assert.match(setupStep(1), /costs a few small agent runs/);
  assert.match(setupStep(4), /Which skills should each agent use\?/);
  assert.match(setupStep(4), /set base Skills '\{"backend":\["<skill>"\]\}'/);
  assert.match(setupStep(8), /cli\.js" trivial-count/);
  assert.match(setupStep(8), /ignore case/);
  assert.equal(setupStep(8).includes('Glob tool'), false);
  assert.match(setupStep(11), /task\/\{id\}/);
  assert.match(setupStep(11), /"branch":/);
});

test('every skill says how to use a test home in Bash and in PowerShell', () => {
  for (const name of ['setup', 'doctor', 'export']) {
    const text = skill(name);
    assert.ok(text.includes('POD_HARNESS_HOME="<folder>"'), `${name}: Bash`);
    assert.ok(text.includes('$env:POD_HARNESS_HOME = \'<folder>\''), `${name}: PowerShell`);
  }
});

test('doctor runs the probe only with the agents argument, and explains an error that names a file', () => {
  const text = skill('doctor');
  assert.match(text, /\/pod-harness:doctor agents/);
  assert.match(text, /probe was not run/);
  assert.match(text, /`file`/);
  assert.match(front(text), /\nargument-hint: \[agents\]/);
});

test('export asks before overwriting and stops on an invalid base', () => {
  const text = skill('export');
  assert.match(text, /`exists`[^\n]*ask/i);
  assert.match(text, /--force/);
  assert.match(text, /`invalid-base`[^\n]*stop/i);
});

test('the README documents the five commands and the Claude Code version', () => {
  const text = read('README.md');
  for (const name of ['setup', 'doctor', 'export', 'task', 'resume']) assert.ok(text.includes(`/pod-harness:${name}`), name);
  assert.match(text, /Claude Code 2\.1\.292 or later/);
  assert.match(text, /## How a task runs/);
  assert.match(text, /cmd\.exe/);
  assert.match(text, /\/bin\/sh/);
  assert.match(text, /blocked/);
  assert.match(text, /mode\.json/);
  assert.match(text, /uncommitted/);
  for (const later of ['Design', 'Plan', 'Deliver']) assert.ok(text.includes(later), later);
  assert.equal(/Phase 1 sets up only|Nothing runs tasks yet/.test(text), false, 'the README no longer says nothing runs');
});

test('plugin.json is at 0.2.1 and the marketplace describes running tasks', () => {
  const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.equal(plugin.version, '0.2.1');
  assert.match(plugin.description, /\/pod-harness:task/);
  const market = JSON.parse(fs.readFileSync(path.join(pluginRoot, '..', '..', '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.match(market.plugins.find((p) => p.name === 'pod-harness').description, /task/i);
});

test('task prints the summary before the dialog, and passes on the developer\'s words for a blocked task', () => {
  const text = skill('task');
  assert.match(text, /Print `summary` exactly as given: it is markdown\./);
  assert.ok(text.indexOf('Print `summary`') < text.indexOf('question dialog: `header`'));
  assert.match(text, /There are two or three options/);
  assert.match(text, /An option that is not offered is never sent\./);
  assert.match(text, /answer <id> needs_you change "@<full path of the note>"/);
  assert.match(text, /If words follow the task id, they are the developer's answer/);
  assert.match(text, /At any other question, raise the dialog as usual./);
  assert.equal(text.includes('the three `options`'), false);
});

test('resume passes the developer\'s words on, and a blocked task waits for an answer', () => {
  const text = skill('resume');
  assert.equal(text.includes('cannot be started again'), false);
  assert.match(text, /any words the developer gave after the id/);
  assert.match(text, /restarts the stage that stopped/);
});

test('setup says when a permission rule starts to hold, and shows only the globs that match', () => {
  assert.match(setupStep(7), /A rule in your user settings holds at once\. A rule in a project settings file that did not exist before holds from the next session\./);
  assert.match(setupStep(8), /only the globs that match at least one file/);
  assert.match(setupStep(8), /how many globs match nothing/);
  assert.equal(skill('setup').includes('open point'), false);
});

test('the README says how a task asks when it cannot go on', () => {
  const text = read('README.md');
  assert.match(text, /This is version 0\.2\.1/);
  assert.match(text, /Needs you/);
  assert.match(text, /Agents take the permission mode of your session\. The harness sets none of its own\./);
  assert.match(text, /questions and notes/i);
  assert.equal(text.includes('cannot be started again'), false);
  assert.match(text, /Four more checkpoints always exist/);
});

test('task waits for agents to finish, not to start, and handles a wait it cannot time', () => {
  const text = skill('task');
  assert.match(text, /has finished, not only started/);
  assert.match(text, /`wait`[^\n]*`message`/);
  assert.match(text, /after a minute/);
});

test('task passes a change note in a form both shells accept, and quotes a name', () => {
  const text = skill('task');
  assert.ok(text.includes('"@<full path of the note>"'));
  assert.ok(text.includes('--name "<short name>"'));
  assert.match(text, /`dir`/);
  assert.ok(skill('setup').includes('"@<file>"'));
});

test('setup records only the command that does not run, as the developer\'s choice', () => {
  const step = setupStep(6);
  assert.match(step, /"not-here"/);
  assert.equal(step.includes('"proof":{"build":"not-run","test":"not-run"'), false);
  assert.match(step, /only the command that does not run/);
});
