'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers');
const { SECTION_NAMES, parseConfigFile, renderConfigFile, replaceSection } = require('../scripts/lib/configfile.js');

const block = (heading, json) => `\n# ${heading}\n\n\`\`\`json\n${json}\n\`\`\`\n`;

test('parses frontmatter and sections', () => {
  const { meta, sections } = parseConfigFile(fixture('base-example.md'));
  assert.deepEqual(meta, { format: 1, min_plugin: '0.1.0', layer: 'base', pod: 'example' });
  assert.equal(sections.Pod.name, 'example');
  assert.equal(sections.Repos[0].trunk, 'main');
  assert.equal(SECTION_NAMES.length, 11);
});

test('names the heading when its JSON is broken', () => {
  const text = fixture('base-example.md').replace('"type": "none" }', '"type": "none", }');
  assert.throws(() => parseConfigFile(text), (e) => e.code === 'bad-json' && e.heading === 'Pod');
});

test('rejects an unknown heading by name', () => {
  assert.throws(() => parseConfigFile(fixture('base-example.md') + block('Budgets', '{}')),
    (e) => e.code === 'unknown-heading' && e.heading === 'Budgets');
});

test('rejects a duplicate heading, a heading with no block, and a file with no frontmatter', () => {
  const text = fixture('base-example.md');
  assert.throws(() => parseConfigFile(text + block('Pod', '{}')), (e) => e.code === 'duplicate-heading' && e.heading === 'Pod');
  assert.throws(() => parseConfigFile(text + '\n# Budget\n\nNo block here.\n'), (e) => e.code === 'missing-block' && e.heading === 'Budget');
  assert.throws(() => parseConfigFile(text.replace(/^---\n[\s\S]*?\n---\n/, '')), (e) => e.code === 'no-frontmatter');
});

test('a "# " line inside a fenced block is not a heading', () => {
  const text = fixture('base-example.md').replace('Free notes are allowed anywhere outside the fenced block.',
    '```text\n# Not a heading\n```');
  assert.equal(parseConfigFile(text).sections.Pod.name, 'example');
});

test('reads a file with Windows line endings', () => {
  const { sections } = parseConfigFile(fixture('base-example.md').replace(/\n/g, '\r\n'));
  assert.equal(sections.Policies[0].id, 'pod-dod');
});

test('render then parse returns the same meta and sections', () => {
  const parsed = parseConfigFile(fixture('base-example.md'));
  assert.deepEqual(parseConfigFile(renderConfigFile(parsed.meta, parsed.sections)), parsed);
});

test('replaceSection changes one block and keeps notes and other sections byte for byte', () => {
  const before = fixture('base-example.md');
  const after = replaceSection(before, 'Pod', { name: 'example', tracker: { type: 'azure-devops' } });
  assert.equal(parseConfigFile(after).sections.Pod.tracker.type, 'azure-devops');
  assert.ok(after.includes('Free notes are allowed anywhere outside the fenced block.'));
  assert.equal(after.slice(after.indexOf('# Repos')), before.slice(before.indexOf('# Repos')));
});

test('replaceSection appends a heading the file does not have', () => {
  const after = replaceSection(fixture('base-example.md'), 'Budget', { max_turns: 40 });
  const { sections } = parseConfigFile(after);
  assert.deepEqual(sections.Budget, { max_turns: 40 });
  assert.equal(sections.Pod.name, 'example');
  assert.throws(() => replaceSection(after, 'Budgets', {}), (e) => e.code === 'unknown-heading');
});
