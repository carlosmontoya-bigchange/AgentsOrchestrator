'use strict';
// Renders the brief an agent reads as its whole task. Nothing above "## Task" names the task, so that part
// is the same text for every task of one pod, agent kind and repo, and the model provider can cache it.
const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('./store.js');
const { commandFor } = require('./validate.js');
const { stageFile } = require('./taskstore.js');
const { HEADINGS, lineLimit } = require('./report.js');

const STAGE = { explorer: 'understand', orchestrator: 'understand', build: 'build', tester: 'test', reviewer: 'review' };
const MARKER = {
  build: 'End your Evidence section with one line: `Sensitive change: yes` or `Sensitive change: no`. Say yes when the change touches money, tax or payment logic, permissions or sign-in, or a contract other code depends on.',
  tester: 'End your Evidence section with one line: `Result: pass` or `Result: fail`.',
  reviewer: 'End your Evidence section with one line: `Verdict: approve` or `Verdict: changes`.',
};
const MAX_FILES_LISTED = 60;

const tick = (p) => `\`${p}\``;
const records = (v) => (Array.isArray(v) ? v : []);

// all: for everyone. own: for this stage or agent. ask: needs the developer's yes before the agent does it.
// The Reviewer checks every review policy, so its "own" holds all that are not already under "all".
function policiesFor(config, stage, agent) {
  const policies = records(config.policies);
  const mine = (p) => p.applies_to === stage || p.applies_to === agent;
  return {
    all: policies.filter((p) => p.check === 'review' && p.applies_to === 'all'),
    own: policies.filter((p) => p.check === 'review' && p.applies_to !== 'all' && (agent === 'reviewer' || mine(p))),
    ask: policies.filter((p) => p.check === 'approval' && (p.applies_to === 'all' || mine(p))),
  };
}

const policyLine = (p, place) => `- ${p.id}: ${p.statement}${place ? ` Applies to: ${p.applies_to}.` : ''}${p.source ? ` (${p.source})` : ''}`;

function podRules(kind, ctx, policies) {
  const reports = ctx.config.reports || {};
  const out = ['## Pod rules', '', `Pod: ${ctx.config.pod.name}.`, ''];
  out.push(...(policies.all.length ? ['Policies for everyone:', ...policies.all.map((p) => policyLine(p))] : ['No pod-wide policy is set.']), '');
  if (kind === 'explorer') {
    out.push('You write no report. Return the path of context.json and one line on what you found. Nothing else.');
  } else {
    out.push(
      'Your report:',
      `- Markdown, in the language "${reports.language || 'en'}", with these \`##\` headings in this order: ${HEADINGS.join(', ')}.`,
      `- Summary: five lines at most. The whole report: ${lineLimit(ctx.config, ctx.model)} lines at most.`,
      '- Questions: only what a person must decide for this work. One line each, written as a question. Write "None" when there is nothing.',
      '- Notes: what a person should know later, such as a check to make by hand, or an assumption you went ahead on. Not questions. Write "None" when there is nothing.',
      '- Return your Summary and the path of your report. Nothing else.',
    );
  }
  return out;
}

const WORK_ORDER_FORMAT = (teams) => [
  'The work order is one JSON object:',
  '```json',
  '{ "format": 1, "size": "S", "summary": "<one sentence, 200 characters at most>",',
  '  "repos": ["<repo id>"],',
  '  "agents": [ { "stage": "build", "agent": "backend", "repo": "<repo id>", "job": "<what to build, with its tests>", "effort": "medium", "read": ["<path>:<lines>"] } ],',
  '  "checks": [], "risks": [], "questions": [], "debate": false }',
  '```',
  '- size: S, M or L.',
  `- agents: Build agents only: backend, frontend or database. At most ${teams.max_agents_per_stage} agents, at most ${teams.max_same_kind} of one kind. Do not list a tester or a reviewer: the harness adds them.`,
  '- repo and repos: ids from the Repo section, exactly as written there.',
  '- effort and read are optional. effort is low, medium or high.',
  '- checks: what a script cannot check, for the Tester. questions: what a person must decide. If nothing can be built until a person answers, list the questions and leave "agents" empty.',
];

const CONTEXT_FORMAT = [
  'context.json is one JSON object:',
  '```json',
  '{ "format": 1, "found": [ { "repo": "<repo id>", "path": "src/a.cs", "lines": "10-40", "why": "<why it matters>" } ], "missing": ["<what you looked for and did not find>"] }',
  '```',
  'Search with Grep and Glob. Read excerpts. Do not read whole files.',
];

function yourPart(kind, ctx, policies, agent) {
  const out = ['## Your part', ''];
  if (policies.own.length) out.push('Policies for your work:', ...policies.own.map((p) => policyLine(p, agent === 'reviewer')), '');
  if (policies.ask.length) {
    out.push('Needs the developer\'s yes first:', ...policies.ask.map((p) => policyLine(p)),
      'If your job would do what one of these covers, do not do it. Write `Policy exception: <id> - <what you would do>` under Questions.',
      'A note under Task in which the developer allows it is that yes.', '');
  }
  const skills = records((ctx.config.skills || {})[agent]);
  if (skills.length) out.push(`Use these skills: ${skills.join(', ')}.`, '');
  if (MARKER[kind]) out.push(MARKER[kind], '');
  if (kind === 'orchestrator') out.push(...WORK_ORDER_FORMAT(ctx.config.teams || {}), '');
  if (kind === 'explorer') out.push(...CONTEXT_FORMAT, '');
  if (out.length === 2) out.push('Nothing extra for your part.', '');
  return out.slice(0, -1);
}

function repoSection(kind, ctx) {
  const out = ['## Repo', ''];
  const all = records(ctx.config.repos);
  if (kind === 'orchestrator' || kind === 'explorer') {
    out.push('The pod\'s repos:', ...all.map((r) => `- ${r.name}: id ${tick(r.id)}, ${r.path ? `folder ${tick(r.path)}` : 'not on this machine'}.`));
    return out;
  }
  const ids = kind === 'build' ? [ctx.entry.repo] : records(ctx.order && ctx.order.repos);
  const shell = ctx.platform === 'win32' ? '`cmd.exe`' : '`/bin/sh`';
  for (const repo of all.filter((r) => ids.includes(r.id))) {
    const command = (key) => {
      const c = commandFor(repo[key], ctx.platform);
      if (c === null || c === 'none') return 'none';
      return tick(c) + (repo.proof && repo.proof[key] === 'not-here' ? ' (recorded as not running on this machine: do not run it)' : '');
    };
    out.push(`${repo.name}: folder ${tick(repo.path)}, trunk ${repo.trunk}.`, `- Build: ${command('build')}`, `- Test: ${command('test')}`);
    if (records(repo.env).length) out.push(`- These commands need the environment variables: ${repo.env.join(', ')}.`);
    out.push('');
  }
  out.push(`The Test stage runs these commands through ${shell}.`, 'Each repo\'s own CLAUDE.md and `.claude/rules` apply inside it.');
  return out;
}

const list = (title, items) => (items.length ? [title, ...items.map((i) => `- ${i}`)] : []);

function taskSection(kind, ctx, stage, key) {
  const { state, dir, inputs } = ctx;
  const round = state.round[stage];
  const file = (name) => path.join(dir, name);
  const out = ['## Task', '', `Task: ${state.id}.`, `The request: ${tick(file('request.md'))}.`];
  if (fs.existsSync(file('item.md'))) out.push(`The tracker item: ${tick(file('item.md'))}.`);
  const hasContext = fs.existsSync(file('context.json'));
  if (hasContext && kind !== 'explorer' && kind !== 'orchestrator') out.push(`What the Explorer found: ${tick(file('context.json'))}.`);
  out.push('');
  const notes = list('Read these notes first. They change or correct the task:', records(inputs.notes).map(tick));

  if (kind === 'explorer') {
    out.push('Find the places in the pod\'s repos that the request touches.', `Write what you find to ${tick(file('context.json'))}.`);
    return out;
  }

  if (kind === 'orchestrator') {
    const explorerBrief = stageFile(dir, 'understand', 'explorer', round, 'brief.md');
    const model = ((ctx.config.teams || {}).models || {}).explorer || 'haiku';
    out.push(`Dispatch \`pod-harness:explorer\` once, on the model \`${model}\`, with the prompt \`Read your brief at ${explorerBrief} and do what it says.\``);
    if (hasContext) out.push(`${tick(file('context.json'))} already exists. Read it. Dispatch the Explorer again only for a place it lacks.`);
    out.push(`Then size the task and write the work order to ${tick(file('work-order.json'))}.`);
    out.push(...notes);
    if (records(inputs.grew).length) {
      out.push('This task started on the fast path and grew:', ...inputs.grew.map((g) => `- ${g}`),
        `What is built so far is measured in ${tick(stageFile(dir, 'build', 'diff', state.round.build, 'json'))}.`,
        'Plan what is left. The task is S unless you find it larger.');
    }
    if (inputs.result) {
      out.push('The tests kept failing after two returns to Build. Route the task again.', `The last test result: ${tick(inputs.result)}.`, ...list('Read:', records(inputs.reports).map(tick)));
    }
    if (state.orchestrator === 'orchestrator_small') {
      out.push('If the task is M or L, or you cannot size it with confidence, write no work order and say so in your Summary.');
    }
  }

  if (kind === 'build') {
    const { entry } = ctx;
    const repo = (state.repos || {})[entry.repo] || {};
    out.push(`Your job: ${entry.job}`, ...list('Start by reading:', records(entry.read).map(tick)),
      `You are on branch ${repo.branch}. Do not commit, push, switch branches or touch another repo.`,
      'If you cannot do the job without a decision from a person, change nothing and put the decision under Questions.', ...notes);
    if (records(inputs.reports).length) out.push(...list('This is a return to Build. Read this and fix what it names:', inputs.reports.map(tick)));
  }

  if (kind === 'tester') {
    if (inputs.result) {
      out.push(`The result of the test run: ${tick(inputs.result)}.`);
      let failed = [];
      try {
        failed = JSON.parse(fs.readFileSync(inputs.result, 'utf8')).repos.filter((r) => r.output).map((r) => `${r.name}: ${tick(r.output)}`);
      } catch { /* the result file names the outputs too */ }
      out.push(...list('The full output of what failed:', failed));
    }
    out.push(...list('Checks from the work order that no script can run:', records(ctx.order && ctx.order.checks)), ...notes, 'Find what failed and where. Fix nothing.');
  }

  if (kind === 'reviewer') {
    out.push('What changed:');
    for (const repo of records(inputs.diff && inputs.diff.repos)) {
      if (repo.files.length === 0) {
        out.push(`${repo.name}: no file changed.`);
        continue;
      }
      out.push(`${repo.name}, branch ${repo.branch}, base ${repo.base}. To see one file: \`git -C "${repo.path}" diff ${repo.base} -- "<file>"\`.`);
      out.push(...repo.files.slice(0, MAX_FILES_LISTED).map((f) => `- ${f.path} (${f.kind}, +${f.added} -${f.removed}): \`git -C "${repo.path}" diff ${repo.base} -- "${f.path}"\``));
      if (repo.files.length > MAX_FILES_LISTED) out.push(`- and ${repo.files.length - MAX_FILES_LISTED} more: \`git -C "${repo.path}" diff --stat ${repo.base}\``);
      out.push('A new file that git does not track yet has no diff: read the file itself.');
    }
    out.push(inputs.result ? `The test result: ${tick(inputs.result)}.` : 'The Test stage did not run: there is no test result.');
    out.push(...list('The reports of the stages before you:', records(inputs.reports).map(tick)), ...notes, 'List under Found what a person must test by hand.');
  }

  out.push('', `Write your report to ${tick(stageFile(dir, stage, key, round, 'md'))}.`);
  return out;
}

// kind: explorer, orchestrator, build, tester or reviewer.
// ctx: { config, state, dir, platform, order?, entry?, model, inputs: { notes, reports, result?, diff?, grew? } }
function renderBrief(kind, ctx) {
  const stage = STAGE[kind];
  const agent = kind === 'build' ? ctx.entry.agent : kind;
  const key = kind === 'build' ? ctx.entry.key : kind;
  const policies = policiesFor(ctx.config, stage, agent);
  return [...podRules(kind, ctx, policies), '', ...yourPart(kind, ctx, policies, agent), '', ...repoSection(kind, ctx), '', ...taskSection(kind, ctx, stage, key)].join('\n') + '\n';
}

function writeBrief(dir, stage, key, round, text) {
  const file = stageFile(dir, stage, key, round, 'brief.md');
  writeFileAtomic(file, text);
  return file;
}

module.exports = { policiesFor, renderBrief, writeBrief };
