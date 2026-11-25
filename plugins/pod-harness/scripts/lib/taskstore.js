'use strict';
// One task's files: <work>/<id>/. Only scripts write state.json, mode.json and approvals.log.
const fs = require('node:fs');
const path = require('node:path');
const { ConfigError } = require('./configfile.js');
const { homeDir, writeFileAtomic } = require('./store.js');
const { commandFor } = require('./validate.js');

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SESSION_ID = /^[A-Za-z0-9-]+$/;

function taskId({ item, name, now }) {
  if (item) return String(item);
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');
  if (!slug) throw new ConfigError('bad-task-name', 'The task needs a short name with at least one letter or digit.');
  return `${new Date(now).toISOString().slice(0, 10)}-${slug}`;
}

// The id comes from a tracker or a person and becomes a folder name.
function taskDir(config, id) {
  const work = config.reports && config.reports.work_dir;
  if (typeof work !== 'string' || work.trim() === '') {
    throw new ConfigError('no-work-dir', 'No work folder is set on this machine. Run /pod-harness:setup pod and say where task reports go.');
  }
  if (typeof id !== 'string' || !TASK_ID.test(id)) {
    throw new ConfigError('bad-task-id', `"${id}" is not a usable task id. Use letters, digits, ".", "_" and "-".`);
  }
  return path.join(work, id);
}

// The one place that builds the path of a stage file. Round 2 and later carry -rN.
function stageFile(dir, stage, name, round, ext) {
  return path.join(dir, stage, `${name}${round > 1 ? `-r${round}` : ''}.${ext}`);
}

const stateFile = (dir) => path.join(dir, 'state.json');
const writeJson = (file, value) => writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');

function writeState(dir, state) {
  writeJson(stateFile(dir), state);
}

function createTask(dir, fields) {
  if (fs.existsSync(stateFile(dir))) throw new ConfigError('task-exists', `A task already exists in ${dir}. Continue it with /pod-harness:resume.`);
  const state = {
    format: 1, id: null, pod: null, created: null, status: 'running', item: null, predicted: 'full', forced: false,
    path: 'full', size: null, orchestrator: 'orchestrator', stage: 'understand', step: 'ready',
    round: { understand: 0, build: 0, test: 0, review: 0 }, returns: { test: 0, review: 0, reroute: 0 }, redo: 0,
    repos: {}, asking: null, asked: [], notes: [], fix: null, grew: [], quiet: false, blocked: null,
    ...fields,
  };
  writeState(dir, state);
  return state;
}

function readState(dir) {
  let text;
  try {
    text = fs.readFileSync(stateFile(dir), 'utf8');
  } catch {
    throw new ConfigError('no-task', `There is no task in ${dir}.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ConfigError('bad-state', `The state file in ${dir} cannot be read. It is written only by the harness: do not edit it.`);
  }
}

// What the hook last saw. Null when it never ran or the file is not usable: the caller then asks everything.
function readMode(dir) {
  try {
    const mode = JSON.parse(fs.readFileSync(path.join(dir, 'mode.json'), 'utf8'));
    return mode && typeof mode.value === 'string' ? mode : null;
  } catch {
    return null;
  }
}

function writeMode(dir, mode) {
  writeJson(path.join(dir, 'mode.json'), mode);
}

function logApproval(dir, entry) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'approvals.log'), JSON.stringify(entry) + '\n');
}

function readApprovals(dir) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(dir, 'approvals.log'), 'utf8');
  } catch { /* no checkpoint was reached yet */ }
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

// Which task a Claude session is working on, so a hook can find it from the session id alone.
const sessionsDir = (env) => path.join(homeDir(env), 'sessions');
const sessionFile = (env, id) => (typeof id === 'string' && SESSION_ID.test(id) ? path.join(sessionsDir(env), `${id}.json`) : null);

function registerSession(env, sessionId, dir) {
  const file = sessionFile(env, sessionId);
  if (file) writeFileAtomic(file, JSON.stringify({ dir }) + '\n');
}

function sessionTask(env, sessionId) {
  const file = sessionFile(env, sessionId);
  if (!file) return null;
  try {
    const dir = JSON.parse(fs.readFileSync(file, 'utf8')).dir;
    return typeof dir === 'string' ? dir : null;
  } catch {
    return null;
  }
}

function unregisterTask(env, dir) {
  let names = [];
  try {
    names = fs.readdirSync(sessionsDir(env));
  } catch { /* no session was ever registered */ }
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    if (sessionTask(env, name.slice(0, -5)) === dir) fs.rmSync(path.join(sessionsDir(env), name), { force: true });
  }
}

function listTasks(config) {
  const work = config.reports && config.reports.work_dir;
  let names = [];
  try {
    names = fs.readdirSync(work).sort();
  } catch { /* no work folder yet: no tasks */ }
  return names.flatMap((name) => {
    try {
      const s = readState(path.join(work, name));
      return [{ id: s.id, stage: s.stage, step: s.step, status: s.status }];
    } catch {
      return []; // a folder of notes, not a harness task
    }
  });
}

function appendTaskNote(dir, line) {
  const file = path.join(dir, 'task.md');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, `# Task ${path.basename(dir)}\n\n`);
  fs.appendFileSync(file, line + '\n');
}

// What a task needs from each repo it touches, checked before an agent is paid to find out.
function preflight(config, repoIds, platform, env = process.env) {
  const problems = [];
  for (const id of repoIds) {
    const repo = (config.repos || []).find((r) => r.id === id);
    if (!repo) {
      problems.push({ message: `The repo ${id} is not set up.`, fix: 'Run /pod-harness:setup repo <its folder>.' });
      continue;
    }
    const fix = `Run /pod-harness:setup repo ${repo.path || '<its folder>'}.`;
    if (!repo.path || !fs.existsSync(repo.path)) {
      problems.push({ message: `${repo.name} has no folder on this machine${repo.path ? `: ${repo.path}` : '.'}`, fix });
      continue;
    }
    for (const key of ['build', 'test']) {
      if (commandFor(repo[key], platform) === null) problems.push({ message: `${repo.name} has no ${key} command for ${platform}.`, fix });
    }
    for (const name of (repo.env || []).filter((n) => !env[n])) {
      problems.push({ message: `${repo.name} needs the environment variable ${name}, which is not set.`, fix: `Set ${name} where Claude Code starts, then continue.` });
    }
  }
  return problems;
}

module.exports = {
  taskId, taskDir, stageFile, createTask, readState, writeState, readMode, writeMode, logApproval, readApprovals,
  registerSession, sessionTask, unregisterTask, listTasks, appendTaskNote, preflight,
};
