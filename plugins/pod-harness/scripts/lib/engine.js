'use strict';
// The stage machine. "next" does every step a script can do alone and returns the first thing only the main
// session can do: dispatch agents, run the tests, ask a checkpoint, fix something, or stop.
const fs = require('node:fs');
const path = require('node:path');
const { ConfigError } = require('./configfile.js');
const { writeFileAtomic } = require('./store.js');
const tasks = require('./taskstore.js');
const { readWorkOrder, validateWorkOrder, withKeys, waves, readContext } = require('./workorder.js');
const { parseReport, lineLimit, joinStageReport } = require('./report.js');
const { branchName, prepareRepo, measureRepo, judgeTrivial } = require('./gitwork.js');
const { isRunning } = require('./testrun.js');
const { renderBrief, writeBrief } = require('./brief.js');
const { decide, question } = require('./checkpoint.js');

const STAGE_NUMBER = { understand: 1, build: 4, test: 5, review: 6, close: 8 }; // the design's numbers
const RANK = ['trivial', 'S', 'M', 'L'];
// How often a loop may repeat before the developer takes over.
const LIMITS = { redo: 2, test: 2, review: 2, reroute: 1 };
const CHOICES = ['continue', 'change', 'stop'];
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
  const reports = ['understand', 'build', 'test', 'review'].filter((s) => state.round[s] > 0).map((s) => stageReportFile(c, s)).filter((f) => fs.existsSync(f))
    .map((f) => `Report: ${f}`);
  if (state.status === 'blocked') {
    return [`Task ${state.id} is blocked: ${state.blocked}`, `It stopped in ${title(state.stage)}.`, ...repos, ...reports,
      'A blocked task cannot be started again in this version. The work stays on its branch for you to take over.', NOT_DONE];
  }
  const ran = ['understand', 'build', 'test', 'review'].filter((s) => state.round[s] > 0).map((s) => `${title(s)} ${state.round[s]} ${state.round[s] === 1 ? 'round' : 'rounds'}`);
  const lines = [`Task ${state.id} is done. Size ${state.size}, ${state.path} path.`, `Stages: ${ran.join(', ')}.`, ...repos, ...reports];
  if (state.round.review > 0) {
    const review = readReport(tasks.stageFile(c.dir, 'review', 'reviewer', state.round.review, 'md'));
    const points = review ? review.openPoints : [];
    lines.push(...(points.length ? points.map((p) => `Open point from the review: ${p}`) : ['The last review left no open point.']));
  }
  return [...lines, NOT_DONE];
}

const ended = (c) => ({ action: { type: 'end', status: c.state.status, lines: endLines(c) }, say: `Task ${c.state.id} is ${c.state.status}.` });
const fix = (problems) => ({ action: { type: 'fix', problems }, say: 'Something needs fixing before the task can go on.' });

function blocked(c, reason) {
  c.state.status = 'blocked';
  c.state.blocked = reason;
  c.state.asking = null;
  tasks.appendTaskNote(c.dir, `- ${day(c)} Blocked in ${title(c.state.stage)}: ${reason}`);
  tasks.unregisterTask(c.env, c.dir);
  return ended(c);
}

// Writes the stage report, adds the line to task.md and the summary the main session shows.
function stageReport(c, stage, entries, facts, open, next) {
  const round = c.state.round[stage];
  const file = stageReportFile(c, stage);
  writeFileAtomic(file, joinStageReport({ id: c.state.id, stage, round, entries, facts, open, next }));
  tasks.appendTaskNote(c.dir, `- ${day(c)} ${title(stage)}, round ${round}: ${facts[0]} Report: ${path.relative(c.dir, file)}`);
  c.show.push({ stage, round, report: file, lines: facts });
  return { file, points: [...entries.flatMap((e) => (e.report ? e.report.openPoints.map((p) => `${e.key}: ${p}`) : [])), ...open] };
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
  if (c.state.redo >= LIMITS.redo) return blocked(c, `${names} wrote no report in three runs.`);
  c.state.redo += 1;
  return { action: dispatch(c, stage, waves(missing)), say: say(stage, `${names} left no report. Running again.`) };
}

// Moves the task on as "Continue" would.
function proceed(c, then) {
  if (then.block) return blocked(c, then.block);
  if (then.bump) c.state.returns[then.bump] += 1;
  if (then.fix) c.state.fix = then.fix;
  c.state.asking = null;
  goTo(c, then.stage, then.step);
  return null;
}

// Raises a checkpoint. Whether it is asked follows the permission mode; one that is not asked is logged and continued.
function raise(c, { checkpoint, produced, report, affected, next, openPoints, then, change }) {
  const { state } = c;
  const value = recordedMode(c);
  const decision = decide({ checkpoint, approvals: c.config.approvals, mode: value, quiet: state.quiet, size: state.size, openPoints: openPoints.length });
  state.asked.push(`${checkpoint}:${state.stage}:${state.round[state.stage]}`);
  const entry = { at: c.now().toISOString(), checkpoint, mode: value, outcome: decision.ask ? 'asked' : 'skipped', reason: decision.reason };
  if (!decision.ask) {
    tasks.logApproval(c.dir, entry);
    return proceed(c, then);
  }
  if (value === null && !tasks.readApprovals(c.dir).some((e) => e.mode === null && e.outcome === 'asked')) c.note = MODE_NOTE;
  tasks.logApproval(c.dir, entry);
  const ask = question({ checkpoint, id: state.id, produced, report, affects: affected, next, openPoints });
  state.asking = { checkpoint, reason: decision.reason, then, change, ask };
  state.step = 'asking';
  return { action: { type: 'ask', checkpoint, ...ask }, say: `Checkpoint: ${ask.header}.` };
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
    else return blocked(c, `The Orchestrator left no usable work order in two runs. ${why.join(' ')}`);
    const note = tasks.stageFile(dir, 'understand', 'problems', round, 'md');
    writeFileAtomic(note, ['# The last run left no usable work order', '', ...why.map((w) => `- ${w}`),
      ...(fs.existsSync(reportFile) ? ['', `The report of that run: \`${reportFile}\`.`] : []), ''].join('\n'));
    state.notes.push(note);
    state.step = 'ready';
    return null;
  }

  const old = state.size;
  state.redo = 0;
  state.size = order.size;
  state.notes = [];
  state.fix = null;
  const m = model(c, state.orchestrator);
  const agents = withKeys(order).map((a) => `${a.key} in ${repoOf(c, a.repo).name}`).join(', ');
  const context = readContext(dir);
  const facts = [
    `Size ${order.size}: ${order.summary}`, `Build agents: ${agents}.`,
    context.context ? `The Explorer found ${context.context.found.length} ${context.context.found.length === 1 ? 'place' : 'places'}.` : 'The Explorer left no usable context.json.',
    ...context.problems, ...order.risks.map((r) => `Risk: ${r}`),
  ];
  const open = [...order.open_points];
  if (order.size !== 'S') open.push(`The Design and Plan stages are not in this version: this ${order.size} task goes from the work order straight to Build.`);
  const entries = [{ key: 'orchestrator', agent: 'orchestrator', model: m, path: reportFile, limit: lineLimit(c.config, m), report: readReport(reportFile) }];
  const report = stageReport(c, 'understand', entries, facts, open, `Build: ${agents}.`);
  const grew = old !== null && RANK.indexOf(order.size) > RANK.indexOf(old);
  return raise(c, {
    checkpoint: grew ? 'task_grew' : 'work_order',
    produced: grew ? `The task grew from ${old} to ${order.size}: ${order.summary}` : `The task is sized ${order.size}: ${order.summary}`,
    report: report.file, affected: affects(c, order.repos), next: `Build starts: ${agents}.`, openPoints: report.points,
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
  if (invalid.length) return blocked(c, `The work order cannot be used. ${invalid.join(' ')}`);

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
  if (!order) return blocked(c, 'The work order is gone.');
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
  const exceptions = got.items.flatMap((i) => i.report.markers.exceptions.map((x) => `${i.key}: ${x}`));
  const facts = [
    ...measures.map((m) => `${m.name}: ${m.product_files} product files, ${m.product_lines} product lines and ${m.test_lines} test lines changed on ${m.branch}.`),
    `Sensitive change: ${sensitive}.`,
    ...Object.values(state.repos).flatMap((r) => r.warnings || []),
    ...(judged ? (judged.trivial ? ['Measured as trivial.'] : judged.reasons.map((r) => `Not trivial: ${r}`)) : []),
    ...exceptions.map((x) => `Not done, a policy needs your yes: ${x}`),
  ];
  const report = stageReport(c, 'build', got.items, facts, [], changed ? `${title(after.stage)}.` : 'Nothing: Build changed no file.');
  if (!changed) return blocked(c, 'Build changed no file.');
  state.notes = [];
  state.fix = null;

  if (judged && !judged.trivial) {
    state.path = 'full';
    state.size = 'S';
    state.orchestrator = 'orchestrator_small';
    state.grew = judged.reasons;
    return raise(c, {
      checkpoint: 'task_grew', produced: `The change is not trivial. ${judged.reasons.join(' ')}`, report: report.file, affected: affects(c, order.repos),
      next: 'The Orchestrator plans what is left. Then the task goes on, on the full path.', openPoints: report.points,
      then: { stage: 'understand', step: 'ready' }, change: { stage: 'understand', step: 'ready' },
    });
  }
  if (exceptions.length) {
    return raise(c, {
      checkpoint: 'policy_exception', produced: 'A Build agent left something undone because a pod policy needs your yes for it.', report: report.file,
      affected: affects(c, order.repos), next: `${title(after.stage)} starts without it. To allow it, choose "Continue with a change" and say so.`,
      openPoints: exceptions, then: after, change: { stage: 'build', step: 'ready' },
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
  const next = !failed ? `${title(after.stage)}.` : again ? 'Back to Build with what failed.' : reroute ? 'The Orchestrator routes the task again.' : 'Nothing: the task is blocked.';
  const report = stageReport(c, 'test', items, facts, result.open, next);
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
  return blocked(c, `The tests still fail after two returns to Build and a new plan from the Orchestrator. See ${report.file}.`);
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
  const then = approve ? { stage: 'close', step: 'ready' }
    : state.returns.review < LIMITS.review ? { stage: 'build', step: 'ready', bump: 'review', fix: findings }
      : { block: 'The review still asks for changes after two returns to Build.' };
  const next = approve ? 'The task closes. The work stays uncommitted on its branch.'
    : then.block ? 'The task is blocked: the review asked for changes three times. You take over.' : 'Build runs again with the review\'s findings.';
  const report = stageReport(c, 'review', got.items, [`Verdict: ${approve ? 'approve' : 'changes'}.`, ...item.report.summary], [], next);
  state.notes = [];
  return raise(c, {
    checkpoint: 'review_result', produced: approve ? 'The Reviewer approves the change.' : 'The Reviewer asks for changes.', report: report.file,
    affected: affects(c, Object.keys(state.repos)), next,
    // What the Test stage skipped has no checkpoint of its own: it is put before the developer here.
    openPoints: [...report.points, ...(state.round.test > 0 && fs.existsSync(resultFile(c)) ? readJson(resultFile(c)).open : [])],
    then, change: { stage: 'build', step: 'ready', ...(approve ? {} : { fix: findings }) },
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

  if (state.status === 'done' || state.status === 'blocked') return done(ended(c));
  const request = path.join(ctx.dir, 'request.md');
  if (!fs.existsSync(request) || fs.readFileSync(request, 'utf8').trim() === '') {
    return done(fix([{ message: 'The task has no request yet.', fix: `Write what is asked to ${request}, then continue.` }]));
  }
  if (recordedMode(c) === 'plan') return done(fix([{ message: 'Plan mode is on. The harness cannot write in Plan mode.', fix: 'Leave Plan mode, then continue.' }]));

  if (state.status === 'stopped') state.status = 'running';
  if (state.asking) return done({ action: { type: 'ask', checkpoint: state.asking.checkpoint, ...state.asking.ask }, say: `Checkpoint: ${state.asking.ask.header}.` });

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
  if (!CHOICES.includes(choice)) throw new ConfigError('bad-choice', `The answer must be one of: ${CHOICES.join(', ')}.`);
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
