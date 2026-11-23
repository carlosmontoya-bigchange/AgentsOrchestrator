'use strict';
const { spawnSync } = require('node:child_process');

function finish(result) {
  return {
    code: typeof result.status === 'number' ? result.status : 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || '') || (result.error ? String(result.error.message) : ''),
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
  };
}

const options = (opts) => ({
  cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, encoding: 'utf8', windowsHide: true,
  maxBuffer: 64 * 1024 * 1024, // a build can print far more than the 1 MB default
});

// A program with its arguments, no shell.
function run(cmd, args, opts = {}) {
  return finish(spawnSync(cmd, args, options(opts)));
}

// One command line, as the developer would type it.
function runShell(command, opts = {}) {
  return finish(spawnSync(command, { ...options(opts), shell: true }));
}

module.exports = { run, runShell };
