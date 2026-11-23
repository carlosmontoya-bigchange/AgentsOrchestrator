'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pluginRoot = path.join(__dirname, '..');
const made = [];
process.on('exit', () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

// The folder name has a space on purpose: home folders like "C:\Users\First Last" must work.
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pod harness '));
  made.push(dir);
  return dir;
}

function tempHome() {
  const dir = tempDir();
  return { dir, env: { POD_HARNESS_HOME: dir } };
}

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

module.exports = { pluginRoot, tempDir, tempHome, fixture };
