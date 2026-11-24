#!/usr/bin/env node
'use strict';
// One JSON document per command, for one task. The task skill calls this and acts on what it prints.
const fs = require('node:fs');
const path = require('node:path');
const { ConfigError } = require('./lib/configfile.js');
const store = require('./lib/store.js');
const { sanitize, validateConfig } = require('./lib/validate.js');
const { firstMatch } = require('./lib/glob.js');
const tasks = require('./lib/taskstore.js');
const { fastOrder, writeWorkOrder } = require('./lib/workorder.js');
const { runTests, isRunning } = require('./lib/testrun.js');
const engine = require('./lib/engine.js');

const TASK_COMMANDS = ['start', 'status', 'quiet', 'test', 'next', 'answer'];
const PREDICTIONS = ['trivial', 'small', 'full'];
const pluginRoot = path.join(__dirname, '..');

const bad = (message) => new ConfigError('bad-argument', message);

// spec: { name: 'one' | 'many' | 'flag' }. Everything that is not a flag is returned under "rest".
function parseFlags(args, spec) {
  const out = { rest: [] };
  for (const [name, kind] of Object.entries(spec)) out[name] = kind === 'many' ? [] : kind === 'flag' ? false : undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      out.rest.push(arg);
      continue;
    }
    const kind = spec[arg.slice(2)];
    if (!kind) throw bad(`"${arg}" is not an option of this command.`);
    if (kind === 'flag') out[arg.slice(2)] = true;
    else if (i + 1 >= args.length) throw bad(`"${arg}" needs a value.`);
    else if (kind === 'many') out[arg.slice(2)].push(args[++i]);
    else out[arg.slice(2)] = args[++i];
  }
  return out;
}

function findRepo(config, wanted) {
  const w = String(wanted).toLowerCase();
  const repo = (config.repos || []).find((r) => r.id.toLowerCase() === w || r.name.toLowerCase() === w);
  if (!repo) throw new ConfigError('no-repo', `No repo named "${wanted}" is set up. Repos: ${(config.repos || []).map((r) => r.name).join(', ')}.`);
  return repo;
}

// Why a task predicted trivial cannot take the fast path, or null when it can.
function notTrivial(config, repos, places, force) {
  if (repos.length !== 1) return 'A trivial task names exactly one repo.';
  if (places.length === 0) return 'A trivial task names the place to change.';
  if (force) return null;
  const never = Array.isArray(config.trivial && config.trivial.never) ? config.trivial.never : [];
  for (const place of places) {
    const glob = firstMatch(never, place);
    if (glob) return `${place} is on a path that is never trivial (${glob}).`;
  }
  return null;
}

const handlers = {
  start: (args, c) => {
    const f = parseFlags(args, { item: 'one', name: 'one', predict: 'one', repo: 'many', place: 'many', force: 'flag', session: 'one' });
    if (!f.item && !f.name) throw new ConfigError('missing-argument', 'This command needs --item <id> or --name <short name>.');
    if (f.rest.length) throw bad(`"${f.rest.join(' ')}" does not belong to an option. Put a name of several words in quotes: --name "fix the label".`);
    if (!PREDICTIONS.includes(f.predict)) throw bad(`--predict must be one of: ${PREDICTIONS.join(', ')}.`);
    const config = c.load();
    const id = tasks.taskId({ item: f.item, name: f.name, now: c.now() });
    const dir = tasks.taskDir(config, id);
    const repos = f.repo.map((wanted) => findRepo(config, wanted));

    const reason = f.predict === 'trivial' ? notTrivial(config, repos, f.place, f.force) : null;
    const predicted = reason ? 'small' : f.predict;
    const fast = predicted === 'trivial';

    const problems = [
      ...validateConfig(config, { platform: c.platform }).filter((p) => p.level === 'error' && p.step !== 'repo')
        .map((p) => ({ message: p.message, fix: `Run /pod-harness:setup ${p.step}.` })),
      ...tasks.preflight(config, repos.map((r) => r.id), c.platform, c.env),
    ];
    if (problems.length) return { problems };

    tasks.createTask(dir, {
      id, pod: config.pod.name, created: c.now().toISOString(), item: f.item || null, predicted, forced: f.force,
      path: fast ? 'fast' : 'full', size: fast ? 'trivial' : null,
      orchestrator: predicted === 'small' ? 'orchestrator_small' : 'orchestrator', stage: fast ? 'build' : 'understand',
    });
    if (fast) writeWorkOrder(dir, fastOrder(repos[0], f.place));
    tasks.registerSession(c.env, f.session || c.env.CLAUDE_CODE_SESSION_ID, dir);
    return { id, dir, request_file: path.join(dir, 'request.md'), item_file: path.join(dir, 'item.md'), predicted, ...(reason ? { reason } : {}) };
  },

  status: (args, c) => ({ tasks: tasks.listTasks(c.load()) }),

  // Runs the build and test commands of the repos Build changed. The skill starts it in the background.
  test: async ([id], c) => {
    const config = c.load();
    const dir = tasks.taskDir(config, id);
    const state = tasks.readState(dir);
    if (state.status !== 'running' || state.stage !== 'test' || state.step !== 'ready') {
      throw new ConfigError('not-testing', `Task ${id} is not waiting for its tests. Run "next" to see what it needs.`);
    }
    if (isRunning(dir, c.now())) throw new ConfigError('tests-running', `The tests of task ${id} are already running.`);
    const diff = JSON.parse(fs.readFileSync(tasks.stageFile(dir, 'build', 'diff', state.round.build, 'json'), 'utf8'));
    const round = state.round.test + 1;
    // The round is raised first: a run that dies half-way never shares its files with the next one.
    tasks.writeState(dir, { ...state, round: { ...state.round, test: round } });
    const result = await runTests(config, dir, diff.repos.filter((r) => r.files.length > 0).map((r) => r.id), round, { env: c.env, platform: c.platform, now: c.now });
    tasks.writeState(dir, { ...tasks.readState(dir), step: 'ran' });
    return result;
  },

  // The next thing only the main session can do for this task.
  next: (args, c) => {
    const f = parseFlags(args, { session: 'one' });
    const config = c.load();
    const dir = tasks.taskDir(config, f.rest[0]);
    const session = f.session || c.env.CLAUDE_CODE_SESSION_ID;
    // A stopped task runs again on this call, so its session is registered too: the hook then records for it.
    if (!['done', 'blocked'].includes(tasks.readState(dir).status)) tasks.registerSession(c.env, session, dir);
    return engine.next({ config, dir, env: c.env, platform: c.platform, pluginRoot, now: c.now, session });
  },

  // The developer's answer to the open checkpoint. A change comes with a note file: @<file>.
  answer: ([id, checkpoint, choice, note], c) => {
    const config = c.load();
    const notePath = note && note.startsWith('@') ? path.resolve(c.cwd, note.slice(1)) : undefined;
    return engine.answer({ config, dir: tasks.taskDir(config, id), env: c.env, platform: c.platform, pluginRoot, now: c.now, session: c.env.CLAUDE_CODE_SESSION_ID }, checkpoint, choice, notePath);
  },

  quiet: ([id, value], c) => {
    if (value !== 'on' && value !== 'off') throw bad('Say "on" or "off".');
    const dir = tasks.taskDir(c.load(), id);
    const state = tasks.readState(dir);
    tasks.writeState(dir, { ...state, quiet: value === 'on' });
    return { id: state.id, quiet: value === 'on' };
  },
};

async function main(argv, io) {
  const print = (value) => io.stdout.write(JSON.stringify(value, null, 2) + '\n');
  const [command, ...args] = argv;
  try {
    if (!TASK_COMMANDS.includes(command)) throw new ConfigError('unknown-command', `Unknown command "${command}". Commands: ${TASK_COMMANDS.join(', ')}.`);
    const pod = store.getActivePod(io.env);
    if (!pod) throw new ConfigError('no-pod', 'No pod is set up on this machine yet. Run /pod-harness:setup.');
    const context = {
      env: io.env, cwd: io.cwd, pod, pluginRoot,
      platform: io.platform || process.platform,
      now: io.now || (() => new Date()),
      load: () => sanitize(store.loadConfig(pod, { env: io.env, pluginRoot }).config).config,
    };
    const out = await handlers[command](args, context);
    print(out);
    return Array.isArray(out.problems) && out.problems.length ? 1 : 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      print({ error: { code: e.code, message: e.message, heading: e.heading, file: e.file } });
      return 1;
    }
    print({ error: { code: 'internal', message: e.message } });
    return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2), { env: process.env, stdout: process.stdout, cwd: process.cwd() }).then((code) => { process.exitCode = code; });
}

module.exports = { TASK_COMMANDS, main };
