'use strict';
const runner = require('./run.js');
const { commandFor } = require('./validate.js');

const check = (name, ok, detail, fix) => ({ name, ok, detail, fix: ok ? '' : fix });

// Only what a script can read. Claude Code's own version and models are probed where the agents are.
function checkEnvironment(opts = {}) {
  const env = opts.env || process.env;
  const nodeVersion = opts.nodeVersion || process.version;
  const run = opts.run || runner.run;
  const major = Number(/^v?(\d+)/.exec(nodeVersion)?.[1] || 0);
  const depth = env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
  const forced = env.CLAUDE_CODE_SUBAGENT_MODEL;
  return [
    check('node', major >= 20, `Node ${nodeVersion}`, 'Install Node 20 or later.'),
    check('git', run('git', ['--version'], { timeoutMs: 20000 }).code === 0, 'git --version', 'Install git and make sure it is on the PATH.'),
    check('spawn-depth', depth === undefined || depth === '' || Number(depth) >= 2,
      depth === undefined ? 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH is not set' : `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH is ${depth}`,
      'Remove CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH or set it to 2 or more: the Orchestrator must be able to start the Explorer.'),
    check('subagent-model', !forced,
      forced ? `CLAUDE_CODE_SUBAGENT_MODEL is ${forced}, which forces one model on every agent` : 'CLAUDE_CODE_SUBAGENT_MODEL is not set',
      'Remove CLAUDE_CODE_SUBAGENT_MODEL so each agent runs on its own model.'),
  ];
}

function checkAccess(config, opts = {}) {
  const run = opts.run || runner.run;
  return (config.repos || []).filter((r) => r.path).map((repo) => {
    const result = run('git', ['-C', repo.path, 'ls-remote', '--exit-code', 'origin', 'HEAD'], { timeoutMs: 20000 });
    return check(`remote:${repo.name}`, result.code === 0, repo.path,
      result.timedOut ? 'The remote did not answer in 20 seconds. Check the VPN or network.' : 'git cannot reach this repo\'s remote. Check your git sign-in for it.');
  });
}

// Runs a repo's build and test command once on this machine.
function proveRepo(repo, opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const runShell = opts.runShell || runner.runShell;
  const now = opts.now || (() => new Date().toISOString());
  const result = { build: 'not-run', test: 'not-run', missing_env: (repo.env || []).filter((name) => !env[name]), tail: '', at: now() };
  if (result.missing_env.length || !repo.path) return result;

  const step = (key) => {
    const command = commandFor(repo[key], platform);
    if (command === 'none') return 'none';
    if (command === null) return 'not-run';
    const r = runShell(command, { cwd: repo.path, timeoutMs: opts.timeoutMs || 600000, env });
    if (r.timedOut) return 'not-run';
    if (r.code === 0) return 'pass';
    result.tail = (r.stdout + r.stderr).slice(-2000);
    return 'fail';
  };
  result.build = step('build');
  if (result.build === 'pass' || result.build === 'none') result.test = step('test');
  return result;
}

module.exports = { checkEnvironment, checkAccess, proveRepo };
