'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./helpers');
const { runShell } = require('../scripts/lib/run.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('runShell resolves with the code and the output', async () => {
  const pending = runShell('node -e "console.log(41+1); console.error(\'warn\'); process.exit(3)"');
  assert.ok(pending instanceof Promise);
  const r = await pending;
  assert.deepEqual([r.code, r.stdout.trim(), r.stderr.trim(), r.timedOut], [3, '42', 'warn', false]);
});

test('runShell runs in the folder it is given, with the environment it is given', async () => {
  const dir = tempDir();
  const r = await runShell('node -e "console.log(process.cwd() + \'|\' + process.env.POD_TEST_VALUE)"', { cwd: dir, env: { ...process.env, POD_TEST_VALUE: 'here' } });
  const [cwd, value] = r.stdout.trim().split('|');
  assert.deepEqual([path.basename(cwd), value], [path.basename(dir), 'here']);
});

test('a timed-out command leaves no child running', async () => {
  const dir = tempDir();
  const pidFile = path.join(dir, 'pid.txt');
  const script = path.join(dir, 'parent.js');
  // The parent starts a child of its own, then both wait. Ending only the shell would leave both running.
  fs.writeFileSync(script, [
    'const { spawn } = require("node:child_process");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const started = Date.now();
  const r = await runShell(`node "${script}"`, { timeoutMs: 3000 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.code, 0);
  assert.ok(Date.now() - started < 20000, 'runShell did not return soon after the timeout');
  const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 50 && alive(childPid); i++) await sleep(100);
  assert.equal(alive(childPid), false, 'the child of the timed-out command is still running');
});

test('a command that leaves a process holding its output still ends when the command ends', async () => {
  const dir = tempDir();
  const pidFile = path.join(dir, 'pid.txt');
  const script = path.join(dir, 'leaves-a-server.js');
  // Like a build that starts a compile server: the child inherits the output pipe and outlives its parent.
  fs.writeFileSync(script, [
    'const { spawn } = require("node:child_process");',
    'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "inherit", detached: true });',
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    'child.unref();',
    'console.log("built");',
  ].join('\n'));
  const started = Date.now();
  const r = await runShell(`node "${script}"`, { timeoutMs: 60000 });
  const took = Date.now() - started;
  try {
    process.kill(Number(fs.readFileSync(pidFile, 'utf8')));
  } catch { /* already gone */ }
  assert.deepEqual([r.code, r.timedOut, r.stdout.trim()], [0, false, 'built']);
  assert.ok(took < 15000, `runShell waited ${took} ms for a process it did not start`);
});
