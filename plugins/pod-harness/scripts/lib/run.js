'use strict';
const { spawn, spawnSync } = require('node:child_process');

// A program with its arguments, no shell. For short commands such as git.
function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: typeof result.status === 'number' ? result.status : 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || '') || (result.error ? String(result.error.message) : ''),
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
  };
}

// Ends the command and everything it started. Ending only the shell would leave a build or a test host running.
function killTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL'); // the child leads its own process group (detached, below)
  } catch { /* already gone */ }
}

// One command line, as the developer would type it: cmd.exe on Windows, /bin/sh elsewhere.
function runShell(command, opts = {}) {
  return new Promise((resolve) => {
    const out = { code: 1, stdout: '', stderr: '', timedOut: false };
    const child = spawn(command, { cwd: opts.cwd, env: opts.env, shell: true, windowsHide: true, detached: process.platform !== 'win32' });
    const timer = opts.timeoutMs ? setTimeout(() => { out.timedOut = true; killTree(child.pid); }, opts.timeoutMs) : null;
    let grace = null;
    const done = () => { clearTimeout(timer); clearTimeout(grace); resolve(out); };
    for (const name of ['stdout', 'stderr']) {
      child[name].setEncoding('utf8');
      child[name].on('data', (chunk) => { out[name] += chunk; });
    }
    child.on('error', (e) => { out.stderr = out.stderr || String(e.message); done(); });
    // The command is over when its process ends. A process it left behind (a build server, a daemon) can keep
    // the output pipe open for minutes, so the pipe gets a second to drain and is then let go.
    child.on('exit', (code) => {
      out.code = typeof code === 'number' && !out.timedOut ? code : 1;
      grace = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); done(); }, 1000);
    });
    child.on('close', done);
  });
}

module.exports = { run, runShell };
