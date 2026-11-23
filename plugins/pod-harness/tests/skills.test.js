'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pluginRoot } = require('./helpers');
const { COMMANDS } = require('../scripts/cli.js');
const { APPROVAL_KEYS } = require('../scripts/lib/validate.js');

const skills = ['setup', 'doctor', 'export'];
const read = (file) => fs.readFileSync(path.join(pluginRoot, file), 'utf8');

test('each skill has frontmatter with its name and a description', () => {
  for (const s of skills) {
    const text = read(`skills/${s}/SKILL.md`);
    assert.match(text, new RegExp(`^---\\r?\\nname: ${s}\\r?\\n`));
    assert.match(text, /\ndescription: .{40,}/);
  }
});

test('every cli.js command a skill names exists, and each skill calls the CLI', () => {
  for (const s of skills) {
    const named = [...read(`skills/${s}/SKILL.md`).matchAll(/cli\.js" ([a-z-]+)/g)].map((m) => m[1]);
    assert.ok(named.length > 0, `${s} never calls the CLI`);
    for (const command of named) assert.ok(COMMANDS.includes(command), `${s}: ${command}`);
  }
});

test('setup names its twelve steps in order and every part it can re-run', () => {
  const text = read('skills/setup/SKILL.md');
  const steps = [...text.matchAll(/^### (\d+)\. /gm)].map((m) => Number(m[1]));
  assert.deepEqual(steps, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  for (const part of ['pod', 'repo', 'trivial', 'policies', 'approvals', 'delivery', 'teams']) {
    assert.ok(text.includes(`setup ${part}`), `no "setup ${part}"`);
  }
});

test('setup names every approval scenario the configuration holds', () => {
  const text = read('skills/setup/SKILL.md');
  for (const key of APPROVAL_KEYS) assert.ok(text.includes(key), `no ${key}`);
});

test('no skill tells Claude to write a configuration file directly, and each forbids secrets', () => {
  for (const s of skills) {
    const text = read(`skills/${s}/SKILL.md`);
    assert.doesNotMatch(text, /(Write|Edit) tool.*(base|personal)\.md/);
    assert.match(text, /secret/i);
  }
});

test('the README documents the three commands and where the files live', () => {
  const text = read('README.md');
  for (const s of skills) assert.ok(text.includes(`/pod-harness:${s}`));
  assert.ok(text.includes('~/.pod-harness'));
});
