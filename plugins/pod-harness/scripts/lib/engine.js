'use strict';
// The stage machine. "next" does every step a script can do alone and returns the first thing only the main
// session can do: dispatch agents, run the tests, ask a checkpoint, fix something, or stop.
const fs = require('node:fs');
const path = require('node:path');
const { ConfigError } = require('./configfile.js');
const { writeFileAtomic } = require('./store.js');
const tasks = require('./taskstore.js');
const { readWorkOrder, validateWorkOrder, withKeys, waves, readContext } = require('./workorder.js');
const { parseReport, lineLimit, joinStageReport, stagePoints } = require('./report.js');
const { branchName, prepareRepo, measureRepo, judgeTrivial } = require('./gitwork.js');
const { isRunning } = require('./testrun.js');
const { renderBrief, writeBrief } = require('./brief.js');
const { CHOICES, decide, question } = require('./checkpoint.js');

const STAGE_NUMBER = { understand: 1, build: 4, test: 5, review: 6, close: 8 }; // the design's numbers
const RANK = ['trivial', 'S', 'M', 'L'];
// How often a loop may repeat before the developer is asked.
const LIMITS = { redo: 2, test: 2, review: 2, reroute: 1 };
// Who runs again when the developer answers a stage that could not go on.
const AGAIN = { understand: 'The Orchestrator plans', build: 'Build runs', test: 'The tests run', review: 'The Reviewer reads' };
const VERDICT_LINE = /^\s*(?:[-*]\s+)?\**\s*verdict\s*:/i;
// An Agent call can return before its agent has finished. For this long after a dispatch, a missing report
// means "still working", not "left no report": it costs no retry.
const GRACE_MS = 30 * 1000;
const STILL_WORKING = 'The agents are still working. Run next again when every agent of the wave has finished.';
const MODE_NOTE = 'The permission mode could not be read, so every checkpoint is asked. To ask nothing for this task, say so.';
const NOT_DONE = 'Not done by the harness in this version: commit, push, pull request, tracker update.';

const title = (stage) => stage.charAt(0).toUpperCase() + stage.slice(1);
const say = (stage, text) => `Stage ${STAGE_NUMBER[stage]} of 8, ${title(stage)}: ${text}`;
const model = (c, key) => ((c.config.teams || {}).models || {})[key] || 'sonnet';
const repoOf = (c, id) => (c.config.repos || []).find((r) => r.id === id) || { id, name: id };
const day = (c) => c.now().toISOString().slice(0, 10);
const goTo = (c, stage, step) => { c.state.stage = stage; c.state.step = step; };
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const stillWorking = (c) => Boolean(c.state.dispatched) && c.now() - new Date(c.state.dispatched) < GRACE_MS;
const working = (c) => ({ action: { type: 'wait', message: STILL_WORKING }, say: say(c.state.stage, 'the agents are still working.') });

// The mode the hook recorded for this session. A record left by another session says nothing about this one.
function recordedMode(c) {
  const mode = tasks.readMode(c.dir);
  if (!mode || (c.session && mode.session && mode.session !== c.session)) return null;
  return mode.value;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new ConfigError('missing-file', `${file} is missing or cannot be read. It is written by the harness.`);
  }
}

function readReport(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch { /* the agent wrote no report */ }
  return text.trim() === '' ? null : parseReport(text);
}

const stageReportFile = (c, stage) => tasks.stageFile(c.dir, stage, 'stage-report', c.state.round[stage], 'md');
// A file's place inside the task folder, as a developer reads it: review/stage-report.md.
const inTask = (c, file) => path.relative(c.dir, file).split(path.sep).join('/');

function affects(c, repoIds) {
  const repos = repoIds.map((id) => { const r = c.state.repos[id]; return `${repoOf(c, id).name}${r ? `, branch ${r.branch}` : ''}`; });
  return [...(c.state.item ? [`item ${c.state.item}`] : []), ...repos];
}

// After Build comes Test, then Review, then Close. A stage the pod switched off is left out.
function stageAfter(c, from) {
  const stages = c.config.stages || {};
  if (from === 'build' && stages.test !== false) return { stage: 'test', step: 'ready' };
  if (stages.review !== false) return { stage: 'review', step: 'ready' };
  return { stage: 'close', step: 'ready' };
}

function endLines(c) {
  const { state } = c;
  const repos = Object.entries(state.repos).map(([id, r]) => `${repoOf(c, id).name}: ${repoOf(c, id).path}, branch ${r.branch}, uncommitted.`);
  const files = ['understand', 'build', 'test', 'review'].filter((s) => state.round[s] > 0).map((s) => stageReportFile(c, s));
  // A task that stopped in Understand may have no stage report yet: the Orchestrator's own report says why.
  if (state.status === 'blocked' && state.stage === 'understand') files.push(tasks.stageFile(c.dir, 'understand', 'orchestrator', state.round.understand, 'md'));
  const reports = files.filter((f) => fs.existsSync(f)).map((f) => `Report: ${f}`);
  if (state.status === 'blocked') {
    return [`Task ${state.id} is blocked: ${state.blocked}`, `It stopped in ${title(state.stage)}.`, ...repos, ...reports,
      `To go on, say what should happen: /pod-harness:resume ${state.id}.`, NOT_DONE];
  }
  const ran = ['understand', 'build', 'test', 'review'].filter((s) => state.round[s] > 0).map((s) => `${title(s)} ${state.round[s]} ${state.round[s] === 1 ? 'round' : 'rounds'}`);
  const lines = [`Task ${state.id} is done. Size ${state.size}, ${state.path} path.`, `Stages: ${ran.join(', ')}.`, ...repos, ...reports];
  if (state.round.review > 0) {
    const review = readReport(tasks.stageFile(c.dir, 'review', 'reviewer', state.round.review, 'md'));
    const left = review ? [...review.questions.map((q) => `Left open at the review: ${q}`), ...review.notes.map((n) => `Note from the review: ${n}`)] : [];
    lines.push(...(left.length ? left : ['The last review left nothing open.']));
  }
  return [...lines, NOT_DONE];
}

const ended = (c) => ({ action: { type: 'end', status: c.state.status, lines: endLines(c) }, say: `Task ${c.state.id} is ${c.state.status}.` });
const fix = (problems) => ({ action: { type: 'fix', problems }, say: 'Something needs fixing before the task can go on.' });

const askAction = (asking) => ({ type: 'ask', checkpoint: asking.checkpoint, ...asking.ask, file: asking.file });

// Nothing may be asked (Bypass permissions, Don't ask, or quiet), and the task cannot go on by itself: it waits
// as blocked with its question kept. "next" asks it once the mode allows, and "answer" takes it in any mode.
function park(c, reason, asking) {
  const { state } = c;
  state.status = 'blocked';
  state.blocked = reason;
  state.asking = { ...asking, parked: true };
  state.step = 'asking';
  tasks.appendTaskNote(c.dir, `- ${day(c)} Waiting for you in ${title(state.stage)}: ${reason}`);
  tasks.unregisterTask(c.env, c.dir);
  return ended(c);
}

// Writes the stage report, adds the line to task.md and the summary the main session shows.
// questions and notes: what the stage itself adds to those of its agents.
function stageReport(c, stage, entries, facts, questions, notes, next) {
  const round = c.state.round[stage];
  const file = stageReportFile(c, stage);
  writeFileAtomic(file, joinStageReport({ id: c.state.id, stage, round, entries, facts, questions, notes, next }));
  tasks.appendTaskNote(c.dir, `- ${day(c)} ${title(stage)}, round ${round}: ${facts[0]} Report: ${path.relative(c.dir, file)}`);
  c.show.push({ stage, round, report: file, lines: facts });
  return { file, ...stagePoints(entries, questions, notes) };
}

function dispatch(c, stage, wavesOfEntries) {
  const round = c.state.round[stage];
  c.state.dispatched = c.now().toISOString();
  return {
    type: 'dispatch', stage,
    waves: wavesOfEntries.map((wave) => wave.map((e) => ({
      key: e.key, agent: `pod-harness:${e.agent}`, model: e.model, ...(e.effort ? { effort: e.effort } : {}),
      prompt: `Read your brief at ${tasks.stageFile(c.dir, stage, e.key, round, 'brief.md')} and do what it says.`,
    }))),
  };
}

// Reads the reports of the agents of a stage. An agent that left none is dispatched again, at most twice.
function collect(c, stage, entries) {
  const round = c.state.round[stage];
  const items = entries.map((e) => {
    const file = tasks.stageFile(c.dir, stage, e.key, round, 'md');
    return { ...e, path: file, limit: lineLimit(c.config, e.model), report: readReport(file) };
  });
  const missing = items.filter((i) => !i.report);
  if (missing.length === 0) {
    c.state.redo = 0;
    return { items };
  }
  if (stillWorking(c)) return working(c);
  const names = missing.map((i) => i.key).join(', ');
  if (c.state.redo >= LIMITS.redo) {
    return needsYou(c, `${names} wrote no report in three runs.`, { headline: 'an agent left no report', change: { stage, step: 'ready', reset: [] } });
  }
  c.state.redo += 1;
  return { action: dispatch(c, stage, waves(missing)), say: say(stage, `${names} left no report. Running again.`) };
}

// Moves the task to the stage an answer leads to. bump raises a return counter. reset starts counters over:
// the developer's answer gives the loop a fresh set of rounds.
function proceed(c, target) {
  if (target.bump) c.state.returns[target.bump] += 1;
  if (target.reset) {
    for (const key of target.reset) c.state.returns[key] = 0;
    c.state.redo = 0;
  }
  if (target.fix) c.state.fix = target.fix;
  c.state.asking = null;
  goTo(c, target.stage, target.step);
  return null;
}

// Raises a checkpoint. Whether it is asked follows the permission mode. One that is not asked is logged, and
// the task goes on as "Continue" would. "Needs you" has no such default: not asked, the task is parked.
// then: where "Continue" leads, absent when it is not offered. change: where "Continue with a change" leads.
function raise(c, { checkpoint, headline, ask, detail, report, affected, next, questions, notes = [], then, change, again }) {
  const { state } = c;
  const value = recordedMode(c);
  const decision = decide({ checkpoint, approvals: c.config.approvals, mode: value, quiet: state.quiet, size: state.size, questions: questions.length });
  state.asked.push(`${checkpoint}:${state.stage}:${state.round[state.stage]}`);
  const entry = { at: c.now().toISOString(), checkpoint, mode: value, outcome: decision.ask ? 'asked' : 'skipped', reason: decision.reason };
  const goesOn = Boolean(then) && checkpoint !== 'needs_you';
  if (!decision.ask && goesOn) {
    tasks.logApproval(c.dir, entry);
    return proceed(c, then);
  }
  const choices = CHOICES.filter((choice) => choice !== 'continue' || then);
  const asked = question({
    checkpoint, id: state.id, headline, ask, detail, next, questions, notes: notes.length, choices, again,
    // The task's own item says nothing new beside the task id.
    affects: affected.filter((a) => a !== `item ${state.id}`), report: report ? inTask(c, report) : undefined,
  });
  const file = tasks.stageFile(c.dir, state.stage, 'checkpoint', state.round[state.stage], 'md');
  writeFileAtomic(file, asked.summary + '\n');
  const asking = { checkpoint, reason: decision.reason, then, change, choices, ask: asked, file };
  if (!decision.ask) {
    tasks.logApproval(c.dir, entry);
    return park(c, detail, asking);
  }
  if (value === null && !tasks.readApprovals(c.dir).some((e) => e.mode === null && e.outcome === 'asked')) c.note = MODE_NOTE;
  tasks.logApproval(c.dir, entry);
  state.asking = asking;
  state.step = 'asking';
  return { action: askAction(asking), say: `Checkpoint: ${asked.header}.` };
}

// The task cannot go on by itself. reason: one sentence on why. then: given only when going on without an
// answer makes sense, with next saying what that does.
function needsYou(c, reason, { headline, questions = [], notes = [], report, then, next, change }) {
  return raise(c, {
    checkpoint: 'needs_you', headline, ask: 'What should happen?', detail: reason, report, affected: affects(c, Object.keys(c.state.repos)),
    next: next || 'Nothing runs until you answer.', questions, notes, then, change, again: AGAIN[change.stage],
  });
}

const briefContext = (c, extra) => ({ config: c.config, state: c.state, dir: c.dir, platform: c.platform, ...extra });

function understandReady(c) {
  const { state, dir } = c;
  const orderFile = path.join(dir, 'work-order.json');
  if (fs.existsSync(orderFile)) {
    const kept = path.join(dir, 'understand', `work-order-r${state.round.understand}.json`);
    fs.mkdirSync(path.dirname(kept), { recursive: true });
    fs.renameSync(orderFile, kept);
  }
  state.round.understand += 1;
  const round = state.round.understand;
  const m = model(c, state.orchestrator);
  const inputs = { notes: state.notes, reports: state.fix ? state.fix.reports : [], result: state.fix ? state.fix.result : undefined, grew: state.grew };
  writeBrief(dir, 'understand', 'explorer', round, renderBrief('explorer', briefContext(c, { model: model(c, 'explorer'), inputs: { notes: [], reports: [] } })));
  writeBrief(dir, 'understand', 'orchestrator', round, renderBrief('orchestrator', briefContext(c, { model: m, inputs })));
  state.step = 'waiting';
  return { action: dispatch(c, 'understand', [[{ key: 'orchestrator', agent: 'orchestrator', model: m }]]), say: say('understand', `the Orchestrator sizes and routes the task (${m}).`) };
}

function understandWaiting(c) {
  const { state, dir } = c;
  const round = state.round.understand;
  const { order, problems } = readWorkOrder(dir);
  if (!order && problems.length === 0 && stillWorking(c)) return working(c);
  const invalid = order ? validateWorkOrder(order, c.config) : [];
  const small = state.orchestrator === 'orchestrator_small';
  const usable = order && invalid.length === 0;
  // The small Orchestrator plans S tasks only: a larger one is planned again by the full Orchestrator.
  const tooLarge = usable && small && order.size !== 'S';
  const reportFile = tasks.stageFile(dir, 'understand', 'orchestrator', round, 'md');

  // What the task needs from the repos it names is checked first: a missing folder or command is for the
  // developer to set up, not for the Orchestrator to plan around.
  const named = order && Array.isArray(order.repos) ? order.repos.filter((id) => (c.config.repos || []).some((r) => r.id === id)) : [];
  const missing = tasks.preflight(c.config, named, c.platform, c.env);
  if (missing.length) return fix(missing);

  if (!usable || tooLarge) {
    const why = tooLarge ? [`The first Orchestrator run sized the task ${order.size}. A task of that size is planned by the full Orchestrator.`]
      : problems.length || invalid.length ? [...problems, ...invalid] : ['No work order was written.'];
    if (small) state.orchestrator = 'orchestrator';
    else if (state.redo < 1) state.redo += 1;
    else {
      const own = readReport(reportFile);
      return needsYou(c, `The Orchestrator left no usable work order in two runs. ${why.join(' ')}`, {
        headline: 'no usable work order', questions: own ? own.questions : [], notes: own ? own.notes : [], report: own ? reportFile : undefined,
        change: { stage: 'understand', step: 'ready', reset: [] },
      });
    }
    const note = tasks.stageFile(dir, 'understand', 'problems', round, 'md');
    writeFileAtomic(note, ['# The last run left no usable work order', '', ...why.map((w) => `- ${w}`),
      ...(fs.existsSync(reportFile) ? ['', `The report of that run: \`${reportFile}\`.`] : []), ''].join('\n'));
    state.notes.push(note);
    state.step = 'ready';
    return null;
  }

  const old = state.size;
  const m = model(c, state.orchestrator);
  const entries = [{ key: 'orchestrator', agent: 'orchestrator', model: m, path: reportFile, limit: lineLimit(c.config, m), report: readReport(reportFile) }];
  const context = readContext(dir);
  const found = [
    context.context ? `The Explorer found ${context.context.found.length} ${context.context.found.length === 1 ? 'place' : 'places'}.` : 'The Explorer left no usable context.json.',
    ...context.problems, ...order.risks.map((r) => `Risk: ${r}`),
  ];
  state.redo = 0;
  state.size = order.size;

  // Questions and no Build agent: nothing can be built until the developer answers. The notes so far are
  // kept, so the next run of the Orchestrator still sees them beside the answer.
  if (order.agents.length === 0) {
    const report = stageReport(c, 'understand', entries, [`Size ${order.size}: ${order.summary}`, 'No Build agent: the Orchestrator needs an answer first.', ...found],
      order.questions, [], 'Nothing until you answer.');
    return needsYou(c, 'The Orchestrator cannot plan this until you answer.', {
      headline: 'the Orchestrator needs an answer', questions: report.questions, notes: report.notes, report: report.file,
      change: { stage: 'understand', step: 'ready', reset: [] },
    });
  }

  state.notes = [];
  state.fix = null;
  const agents = withKeys(order).map((a) => `${a.key} in ${repoOf(c, a.repo).name}`).join(', ');
  const facts = [`Size ${order.size}: ${order.summary}`, `Build agents: ${agents}.`, ...found];
  // Not a question, but a decision the developer should see once: it stays among the questions, so Auto asks.
  const asks = [...order.questions];
  if (order.size !== 'S') asks.push(`The Design and Plan stages are not in this version: this ${order.size} task goes from the work order straight to Build.`);
  const report = stageReport(c, 'understand', entries, facts, asks, [], `Build: ${agents}.`);
  const grew = old !== null && RANK.indexOf(order.size) > RANK.indexOf(old);
  return raise(c, {
    checkpoint: grew ? 'task_grew' : 'work_order', headline: grew ? `from ${old} to ${order.size}` : `size ${order.size}`, ask: 'Start Build?', detail: order.summary,
    report: report.file, affected: affects(c, order.repos), next: `Build starts: ${agents}.`, questions: report.questions, notes: report.notes,
    then: { stage: 'build', step: 'ready' }, change: { stage: 'understand', step: 'ready' },
  });
}

function buildEntries(c, order) {
  return withKeys(order).map((e) => ({ ...e, model: model(c, e.agent) }));
}

function buildReady(c) {
  const { state, dir } = c;
  const { order } = readWorkOrder(dir);
  const missing = order && Array.isArray(order.repos) ? tasks.preflight(c.config, order.repos, c.platform, c.env) : [];
  if (missing.length) return fix(missing);
  const invalid = order ? validateWorkOrder(order, c.config, { script: true }) : ['There is no work order.'];
  if (invalid.length === 0 && order.agents.length === 0) invalid.push('It names no Build agent.');
  if (invalid.length) {
    return needsYou(c, `The work order cannot be used. ${invalid.join(' ')}`, { headline: 'the work order cannot be used', change: { stage: 'understand', step: 'ready', reset: [] } });
  }

  // Every repo is put on the task branch each time Build starts: the developer may have switched since.
  const branch = branchName(c.config.delivery.branch, state.id);
  const warnings = [];
  for (const id of order.repos) {
    const prepared = prepareRepo(repoOf(c, id), branch);
    if (prepared.problem) return fix([prepared.problem]);
    warnings.push(...prepared.warnings);
    if (!state.repos[id]) state.repos[id] = { branch: prepared.branch, base: prepared.base, ...(prepared.warnings.length ? { warnings: prepared.warnings } : {}) };
  }

  state.round.build += 1;
  const entries = buildEntries(c, order);
  const inputs = { notes: state.notes, reports: state.fix ? state.fix.reports : [] };
  for (const entry of entries) {
    writeBrief(dir, 'build', entry.key, state.round.build, renderBrief('build', briefContext(c, { order, entry, model: entry.model, inputs })));
  }
  state.step = 'waiting';
  return { action: dispatch(c, 'build', waves(entries)), say: say('build', [`${entries.map((e) => `${e.key} in ${repoOf(c, e.repo).name}`).join(', ')}.`, ...warnings].join(' ')) };
}

function buildWaiting(c) {
  const { state, dir } = c;
  const { order } = readWorkOrder(dir);
  if (!order) return needsYou(c, 'The work order is gone.', { headline: 'the work order cannot be used', change: { stage: 'understand', step: 'ready', reset: [] } });
  const got = collect(c, 'build', buildEntries(c, order));
  if (!got.items) return got;

  const never = Array.isArray((c.config.trivial || {}).never) ? c.config.trivial.never : [];
  const measures = order.repos.map((id) => {
    const repo = repoOf(c, id);
    const { branch, base } = state.repos[id];
    return { id, name: repo.name, path: repo.path, branch, base, ...measureRepo(repo, base, never) };
  });
  // A missing answer counts as yes.
  const sensitive = got.items.every((i) => i.report.markers.sensitive === 'no') ? 'no' : 'yes';
  const judged = state.path === 'fast' ? judgeTrivial(measures, c.config.trivial, sensitive) : null;
  writeFileAtomic(tasks.stageFile(dir, 'build', 'diff', state.round.build, 'json'), JSON.stringify({ repos: measures, trivial: judged }, null, 2) + '\n');

  const changed = measures.some((m) => m.files.length > 0);
  const after = stageAfter(c, 'build');
  const exceptions = got.items.flatMap((i) => i.report.markers.exceptions.map((x) => ({ key: i.key, text: x })));
  const facts = [
    ...measures.map((m) => `${m.name}: ${count(m.product_files, 'product file')}, ${count(m.product_lines, 'product line')} and ${count(m.test_lines, 'test line')} changed on ${m.branch}.`),
    `Sensitive change: ${sensitive}.`,
    ...Object.values(state.repos).flatMap((r) => r.warnings || []),
    ...(judged ? (judged.trivial ? ['Measured as trivial.'] : judged.reasons.map((r) => `Not trivial: ${r}`)) : []),
    ...exceptions.map((x) => `Not done, a policy needs your yes: ${x.key}: ${x.text}`),
  ];
  const report = stageReport(c, 'build', got.items, facts, [], [], changed ? `${title(after.stage)}.` : 'Nothing: Build changed no file.');
  // The notes stay: Build runs again with them and with the developer's answer.
  if (!changed) {
    return needsYou(c, 'Build changed no file.', {
      headline: 'Build changed no file', questions: report.questions, notes: report.notes, report: report.file, change: { stage: 'build', step: 'ready', reset: [] },
    });
  }
  state.notes = [];
  state.fix = null;

  if (judged && !judged.trivial) {
    state.path = 'full';
    state.size = 'S';
    state.orchestrator = 'orchestrator_small';
    state.grew = judged.reasons;
    return raise(c, {
      checkpoint: 'task_grew', headline: 'the change is not trivial', ask: 'Plan what is left?', detail: judged.reasons.join(' '), report: report.file,
      affected: affects(c, order.repos), next: 'The Orchestrator plans what is left. Then the task goes on, on the full path.',
      questions: report.questions, notes: report.notes, then: { stage: 'understand', step: 'ready' }, change: { stage: 'understand', step: 'ready' },
    });
  }
  if (exceptions.length) {
    return raise(c, {
      checkpoint: 'policy_exception', headline: 'a policy needs your yes', ask: 'Go on without it?',
      detail: 'A Build agent left something undone because a pod policy needs your yes for it.', report: report.file,
      affected: affects(c, order.repos), next: `${title(after.stage)} starts without it. To allow it, choose "Continue with a change" and say so.`,
      questions: exceptions.map((x) => x.text), notes: report.notes, then: after, change: { stage: 'build', step: 'ready' },
    });
  }
  goTo(c, after.stage, after.step);
  return null;
}

function testReady(c) {
  if (isRunning(c.dir, c.now())) return { action: { type: 'wait', message: 'The tests are still running.' }, say: say('test', 'the tests are still running.') };
  return {
    action: { type: 'run', command: `node "${path.join(c.pluginRoot, 'scripts', 'task.js')}" test ${c.state.id}` },
    say: say('test', 'running the build and test commands of the changed repos.'),
  };
}

const testerEntry = (c) => ({ key: 'tester', agent: 'tester', model: model(c, 'tester') });
const resultFile = (c) => tasks.stageFile(c.dir, 'test', 'result', c.state.round.test, 'json');

// Closes a Test round: the stage report, then on to Review, back to Build, or to the Orchestrator.
function finishTest(c, items) {
  const { state } = c;
  const result = readJson(resultFile(c));
  // A missing "Result" line counts as fail.
  const failed = result.result === 'fail' || (items.length > 0 && items[0].report.markers.result !== 'pass');
  const ran = result.repos.some((r) => r.build === 'pass' || r.test === 'pass');
  const facts = [failed ? 'The tests failed.' : ran ? 'The tests passed.' : 'No build or test command ran.', ...result.open, ...result.repos.map((r) => `${r.name}: build ${r.build}, test ${r.test}${r.missing_env ? `, not set: ${r.missing_env.join(', ')}` : ''}${r.output ? `, output in ${path.basename(r.output)}` : ''}.`)];
  const again = state.returns.test < LIMITS.test;
  const reroute = !again && state.returns.reroute < LIMITS.reroute;
  const after = stageAfter(c, 'test');
  const next = !failed ? `${title(after.stage)}.` : again ? 'Back to Build with what failed.' : reroute ? 'The Orchestrator routes the task again.' : 'Nothing until you answer.';
  // What the run skipped is not a question, but the developer should see it once: it stays among the questions.
  const report = stageReport(c, 'test', items, facts, result.open, [], next);
  if (!failed) {
    goTo(c, after.stage, after.step);
    return null;
  }
  const evidence = { from: 'test', reports: [items.length ? items[0].path : report.file], result: resultFile(c) };
  if (again) {
    state.returns.test += 1;
    state.fix = evidence;
    goTo(c, 'build', 'ready');
    return null;
  }
  if (reroute) {
    state.returns.reroute += 1;
    state.returns.test = 0;
    state.orchestrator = 'orchestrator';
    state.fix = evidence;
    if (state.path === 'fast') {
      state.path = 'full';
      state.size = 'S';
      state.grew = ['The tests kept failing on the fast path.'];
    }
    goTo(c, 'understand', 'ready');
    return null;
  }
  // The whole loop is used up. Going on to Review with the failure on record is a real choice: the developer
  // may know that the failure is not this change's.
  return needsYou(c, 'The tests still fail after two returns to Build and a new plan from the Orchestrator.', {
    headline: 'the tests still fail', questions: report.questions, notes: report.notes, report: report.file,
    then: after, next: `${title(after.stage)} starts, with the failing tests on record.`,
    change: { stage: 'build', step: 'ready', fix: evidence, reset: ['test', 'reroute'] },
  });
}

function testRan(c) {
  const { state, dir } = c;
  const result = readJson(resultFile(c));
  const { order } = readWorkOrder(dir);
  const checks = order && Array.isArray(order.checks) ? order.checks : [];
  // The Tester runs only when something failed or the work order lists a check no script can run.
  if (result.result === 'pass' && checks.length === 0) return finishTest(c, []);
  const entry = testerEntry(c);
  writeBrief(dir, 'test', 'tester', state.round.test, renderBrief('tester', briefContext(c, { order, model: entry.model, inputs: { notes: [], reports: [], result: resultFile(c) } })));
  state.step = 'waiting';
  return { action: dispatch(c, 'test', [[entry]]), say: say('test', result.result === 'fail' ? 'the tests failed. The Tester finds what failed.' : 'the Tester runs the checks of the work order.') };
}

function testWaiting(c) {
  const got = collect(c, 'test', [testerEntry(c)]);
  return got.items ? finishTest(c, got.items) : got;
}

// The fast path is reviewed on the cheaper model. The effort is always high.
const reviewerEntry = (c) => ({ key: 'reviewer', agent: 'reviewer', model: model(c, c.state.path === 'fast' ? 'reviewer_trivial' : 'reviewer'), effort: 'high' });

function reviewReady(c) {
  const { state, dir } = c;
  state.round.review += 1;
  const entry = reviewerEntry(c);
  const { order } = readWorkOrder(dir);
  const tested = state.round.test > 0 && fs.existsSync(resultFile(c));
  const inputs = {
    notes: state.notes,
    reports: ['build', ...(tested ? ['test'] : [])].map((s) => stageReportFile(c, s)),
    diff: readJson(tasks.stageFile(dir, 'build', 'diff', state.round.build, 'json')),
    result: tested ? resultFile(c) : undefined,
  };
  writeBrief(dir, 'review', 'reviewer', state.round.review, renderBrief('reviewer', briefContext(c, { order, model: entry.model, inputs })));
  state.step = 'waiting';
  return { action: dispatch(c, 'review', [[entry]]), say: say('review', `the Reviewer reads the change (${entry.model}).`) };
}

function reviewWaiting(c) {
  const { state } = c;
  const got = collect(c, 'review', [reviewerEntry(c)]);
  if (!got.items) return got;
  const [item] = got.items;
  // A missing "Verdict" line counts as changes.
  const approve = item.report.markers.verdict === 'approve';
  const findings = { from: 'review', reports: [item.path] };
  const usedUp = !approve && state.returns.review >= LIMITS.review;
  const next = approve ? 'The task closes. The work stays uncommitted on its branch.'
    : usedUp ? 'Nothing until you answer.' : 'Build runs again with the review\'s findings.';
  // What the Test stage skipped has no checkpoint of its own: it is put before the developer here.
  const skipped = state.round.test > 0 && fs.existsSync(resultFile(c)) ? readJson(resultFile(c)).open : [];
  // The verdict is the first line. A summary that repeats it is not shown twice.
  const lines = item.report.summary.filter((line) => !VERDICT_LINE.test(line));
  const report = stageReport(c, 'review', got.items, [`Verdict: ${approve ? 'approve' : 'changes'}.`, ...lines], skipped, [], next);
  state.notes = [];
  if (usedUp) {
    return needsYou(c, 'The review still asks for changes after two returns to Build.', {
      headline: 'the review still asks for changes', questions: report.questions, notes: report.notes, report: report.file,
      change: { stage: 'build', step: 'ready', fix: findings, reset: ['review'] },
    });
  }
  return raise(c, {
    checkpoint: 'review_result', headline: approve ? 'approved' : 'changes asked', ask: approve ? 'Close the task?' : 'Run Build again?', report: report.file,
    affected: affects(c, Object.keys(state.repos)), next, questions: report.questions, notes: report.notes,
    then: approve ? { stage: 'close', step: 'ready' } : { stage: 'build', step: 'ready', bump: 'review', fix: findings },
    change: { stage: 'build', step: 'ready', ...(approve ? {} : { fix: findings }) },
  });
}

function closeReady(c) {
  const { state } = c;
  state.status = 'done';
  tasks.appendTaskNote(c.dir, `- ${day(c)} Done. Size ${state.size}, ${state.path} path. The work is uncommitted on ${[...new Set(Object.values(state.repos).map((r) => r.branch))].join(', ')}.`);
  tasks.unregisterTask(c.env, c.dir);
  return ended(c);
}

const STEPS = {
  'understand.ready': understandReady, 'understand.waiting': understandWaiting,
  'build.ready': buildReady, 'build.waiting': buildWaiting,
  'test.ready': testReady, 'test.ran': testRan, 'test.waiting': testWaiting,
  'review.ready': reviewReady, 'review.waiting': reviewWaiting,
  'close.ready': closeReady,
};

// ctx: { config, dir, env, platform, pluginRoot, now, session? }
async function next(ctx) {
  const state = tasks.readState(ctx.dir);
  const before = JSON.stringify(state);
  const c = { ...ctx, state, show: [] };
  // The state is written only when it changed: the test command writes it too, while "next" may be waiting.
  const done = (r) => {
    if (JSON.stringify(state) !== before) tasks.writeState(ctx.dir, state);
    return { id: state.id, dir: ctx.dir, stage: state.stage, step: state.step, say: r.say, show: c.show, ...(c.note ? { note: c.note } : {}), action: r.action };
  };

  if (state.status === 'done') return done(ended(c));
  if (state.status === 'blocked') {
    // A parked question is asked once the mode allows it. Until then the task keeps waiting, and nothing is written.
    if (!state.asking) return done(ended(c));
    const value = recordedMode(c);
    const decision = decide({ checkpoint: state.asking.checkpoint, approvals: c.config.approvals, mode: value, quiet: state.quiet, size: state.size, questions: 0 });
    if (!decision.ask) return done(ended(c));
    state.status = 'running';
    state.asking = { ...state.asking, reason: decision.reason, parked: false };
    tasks.logApproval(c.dir, { at: c.now().toISOString(), checkpoint: state.asking.checkpoint, mode: value, outcome: 'asked', reason: decision.reason });
    return done({ action: askAction(state.asking), say: `Checkpoint: ${state.asking.ask.header}.` });
  }
  const request = path.join(ctx.dir, 'request.md');
  if (!fs.existsSync(request) || fs.readFileSync(request, 'utf8').trim() === '') {
    return done(fix([{ message: 'The task has no request yet.', fix: `Write what is asked to ${request}, then continue.` }]));
  }
  if (recordedMode(c) === 'plan') return done(fix([{ message: 'Plan mode is on. The harness cannot write in Plan mode.', fix: 'Leave Plan mode, then continue.' }]));

  if (state.status === 'stopped') state.status = 'running';
  if (state.asking) return done({ action: askAction(state.asking), say: `Checkpoint: ${state.asking.ask.header}.` });

  for (;;) {
    const step = STEPS[`${state.stage}.${state.step}`];
    if (!step) throw new ConfigError('bad-state', `The task is at ${state.stage}.${state.step}, which is not a step of this version.`);
    const r = step(c);
    if (r) return done(r);
  }
}

function answer(ctx, checkpoint, choice, notePath) {
  const state = tasks.readState(ctx.dir);
  if (!state.asking || state.asking.checkpoint !== checkpoint) throw new ConfigError('not-asking', `No question is open for "${checkpoint}" in task ${state.id}.`);
  // A parked question is answered here too, in any mode: the developer's own words are always taken.
  const offered = state.asking.choices || CHOICES;
  if (!offered.includes(choice)) throw new ConfigError('bad-choice', `The answer must be one of: ${offered.join(', ')}.`);
  if (choice === 'change' && (!notePath || !fs.existsSync(notePath))) {
    throw new ConfigError('no-note', 'A change needs a note file with the developer\'s own words.');
  }
  const c = { ...ctx, state, show: [] };
  const { then, change, reason } = state.asking;
  tasks.logApproval(ctx.dir, {
    at: ctx.now().toISOString(), checkpoint, mode: recordedMode(c), outcome: 'asked', reason, answer: choice, ...(choice === 'change' ? { note: notePath } : {}),
  });
  if (choice === 'stop') state.status = 'stopped'; // the question stays open: the next call asks it again
  else {
    state.status = 'running';
    if (choice === 'change') state.notes.push(notePath);
    proceed(c, choice === 'change' ? change : then);
  }
  tasks.writeState(ctx.dir, state);
  return { ok: true, status: state.status };
}

module.exports = { next, answer };
