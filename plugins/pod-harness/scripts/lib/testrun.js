'use strict';
// The Test stage's mechanical part: run each touched repo's build and test command. No agent is involved.
const fs = require('node:fs');
const path = require('node:path');
const runner = require('./run.js');
const { writeFileAtomic } = require('./store.js');
const { commandFor } = require('./validate.js');
const { stageFile } = require('./taskstore.js');

// shortcut: one fixed limit, make it a Budget setting when a pod's suite needs longer
const TIMEOUT_MS = 30 * 60 * 1000;
const STALE_MS = 70 * 60 * 1000;
const FAILED = ['fail', 'timeout'];

const runningFile = (dir) => path.join(dir, 'test', 'running.json');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // it exists, under another user
  }
}

// True while a test run of this task is in flight. A run whose process is gone, or that has started no command
// for 70 minutes, no longer counts, so a crashed run does not block the task.
function isRunning(dir, now = new Date()) {
  try {
    const { pid, at } = JSON.parse(fs.readFileSync(runningFile(dir), 'utf8'));
    return now - new Date(at) < STALE_MS && alive(pid);
  } catch {
    return false;
  }
}

async function runTests(config, dir, repoIds, round, opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const runShell = opts.runShell || runner.runShell;
  const now = opts.now || (() => new Date());
  // Written again before each command, so "70 minutes" is measured from the last command that started.
  const mark = () => writeFileAtomic(runningFile(dir), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n');
  const result = { at: now().toISOString(), round, result: 'pass', repos: [], open: [] };

  mark();
  try {
    for (const repo of (config.repos || []).filter((r) => repoIds.includes(r.id))) {
      const entry = { id: repo.id, name: repo.name, build: 'not-run', test: 'not-run', seconds: 0 };
      result.repos.push(entry);
      const missing = (repo.env || []).filter((name) => !env[name]);
      if (missing.length) {
        entry.missing_env = missing;
        continue;
      }
      const started = Date.now();
      const kept = [];
      const step = async (key) => {
        const command = commandFor(repo[key], platform);
        if (command === 'none') return 'none';
        // "not-here" is the developer's own record at set-up. The set-up's "not-run" only means it never got that far.
        if (repo.proof && repo.proof[key] === 'not-here') {
          result.open.push(`${repo.name}: the ${key} command is recorded as not run on this machine.`);
          return 'skipped';
        }
        if (command === null) {
          result.open.push(`${repo.name}: there is no ${key} command for ${platform}.`);
          return 'not-run';
        }
        mark();
        const r = await runShell(command, { cwd: repo.path, env, timeoutMs: opts.timeoutMs || TIMEOUT_MS });
        if (r.code === 0 && !r.timedOut) return 'pass';
        kept.push(`$ ${command}\n${r.stdout}${r.stderr}${r.timedOut ? '\n(stopped: the command ran longer than the limit)\n' : ''}`);
        return r.timedOut ? 'timeout' : 'fail';
      };
      entry.build = await step('build');
      if (!FAILED.includes(entry.build) && entry.build !== 'not-run') entry.test = await step('test');
      entry.seconds = Math.round((Date.now() - started) / 1000);
      if (kept.length) {
        entry.output = stageFile(dir, 'test', repo.name.replace(/[^A-Za-z0-9._-]/g, '_'), round, 'txt');
        writeFileAtomic(entry.output, kept.join('\n'));
      }
    }
    if (result.repos.some((r) => r.missing_env || FAILED.includes(r.build) || FAILED.includes(r.test))) result.result = 'fail';
    writeFileAtomic(stageFile(dir, 'test', 'result', round, 'json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally {
    fs.rmSync(runningFile(dir), { force: true });
  }
}

module.exports = { runTests, isRunning };
