'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, tempHome, fixture, makeRepo } = require('./helpers');
const { podDir, getActivePod, getActiveRole, readLayer, writeLayerText, patchLayer } = require('../scripts/lib/store.js');
const { importBase, exportBase } = require('../scripts/lib/share.js');

const opts = (h) => ({ env: h.env, pluginVersion: '0.1.0' });

// Writes a variant of the example base to a temp file and returns its path.
function baseFile(change = (t) => t) {
  const file = path.join(tempDir(), 'pod base.md');
  fs.writeFileSync(file, change(fixture('base-example.md')));
  return file;
}

test('import writes the base unchanged, creates personal and sets the active pod', () => {
  const h = tempHome();
  const result = importBase(baseFile(), opts(h));
  assert.deepEqual(result, { pod: 'example', problems: [] });
  assert.equal(readLayer('example', 'base', h.env).text, fixture('base-example.md'));
  assert.deepEqual(readLayer('example', 'personal', h.env).sections, {});
  assert.equal(getActivePod(h.env), 'example');
});

test('import of a file with broken JSON names the heading and writes nothing', () => {
  const h = tempHome();
  const file = baseFile((t) => t.replace('"check": "review",', '"check": "review",,'));
  assert.throws(() => importBase(file, opts(h)), (e) => e.code === 'bad-json' && e.heading === 'Policies');
  assert.equal(fs.existsSync(podDir('example', h.env)), false);
  assert.equal(getActivePod(h.env), null);
});

test('import of a newer base throws too-new with the message', () => {
  const h = tempHome();
  const file = baseFile((t) => t.replace('min_plugin: 0.1.0', 'min_plugin: 9.0.0'));
  assert.throws(() => importBase(file, opts(h)), (e) => e.code === 'too-new'
    && e.message === 'This file needs pod-harness 9.0.0 or later. You have 0.1.0. Update the plugin, then run /pod-harness:setup again.');
  assert.equal(fs.existsSync(podDir('example', h.env)), false);
});

test('import refuses a personal file, a missing file and a pod name that leaves the home folder', () => {
  const h = tempHome();
  assert.throws(() => importBase(baseFile((t) => t.replace('layer: base', 'layer: personal')), opts(h)), (e) => e.code === 'not-a-base');
  assert.throws(() => importBase(path.join(tempDir(), 'nothing.md'), opts(h)), (e) => e.code === 'no-file');
  assert.throws(() => importBase(baseFile((t) => t.replace('pod: example', 'pod: ../../evil')), opts(h)), (e) => e.code === 'bad-pod-name');
});

test('import keeps an existing personal file', () => {
  const h = tempHome();
  importBase(baseFile(), opts(h));
  patchLayer('example', 'personal', 'Approvals', { plan: false }, h.env);
  importBase(baseFile((t) => t.replace('"trunk": "main"', '"trunk": "develop"')), opts(h));
  assert.deepEqual(readLayer('example', 'personal', h.env).sections.Approvals, { plan: false });
  assert.equal(readLayer('example', 'base', h.env).sections.Repos[0].trunk, 'develop');
});

test('import refuses a base that holds a local path and writes nothing', () => {
  const h = tempHome();
  const result = importBase(baseFile((t) => t.replace('"name": "App",', '"name": "App", "path": "C:/src/app",')), opts(h));
  assert.deepEqual(result.problems.map((p) => p.path), ['repos[dev.azure.com/org/proj/_git/app].path']);
  assert.equal(fs.existsSync(podDir('example', h.env)), false);
});

test('import marks this machine as a member of the pod', () => {
  const h = tempHome();
  importBase(baseFile(), opts(h));
  assert.equal(getActiveRole(h.env), 'member');
});

test('import refuses wrongly shaped settings and a webhook URL, and writes nothing', () => {
  const h = tempHome();
  const shaped = importBase(baseFile((t) => t.replace(/# Repos\n\n```json\n[\s\S]*?\n```/, '# Repos\n\n```json\n[null]\n```')), opts(h));
  assert.deepEqual(shaped.problems.map((p) => p.path), ['repos']);
  const hook = importBase(baseFile((t) => t + '\n# Delivery\n\n```json\n{ "webhooks": [ { "id": "teams", "env": "https://example.invalid/SECRET" } ] }\n```\n'), opts(h));
  assert.deepEqual(hook.problems.map((p) => p.path), ['delivery.webhooks']);
  assert.equal(fs.existsSync(podDir('example', h.env)), false);
});

test('export refuses a base that holds a webhook URL', () => {
  const h = tempHome();
  importBase(baseFile(), opts(h));
  const text = readLayer('example', 'base', h.env).text + '\n# Delivery\n\n```json\n{ "webhooks": [ { "id": "teams", "env": "https://example.invalid/SECRET" } ] }\n```\n';
  writeLayerText('example', 'base', text, h.env);
  const out = path.join(tempDir(), 'b.md');
  assert.throws(() => exportBase('example', out, { env: h.env }), (e) => e.code === 'invalid-base');
  assert.equal(fs.existsSync(out), false);
});

test('export copies the base to a folder outside any repo, creating the folder', () => {
  const h = tempHome();
  importBase(baseFile(), opts(h));
  const out = path.join(tempDir(), 'to share', 'example base.md');
  assert.deepEqual(exportBase('example', out, { env: h.env }), { path: out });
  assert.equal(fs.readFileSync(out, 'utf8'), fixture('base-example.md'));
});

test('export into a git repo is refused', () => {
  const h = tempHome();
  importBase(baseFile(), opts(h));
  const repo = makeRepo(tempDir(), 'some repo');
  const out = path.join(repo, 'docs', 'base.md');
  assert.throws(() => exportBase('example', out, { env: h.env }), (e) => e.code === 'inside-repo');
  assert.equal(fs.existsSync(out), false);
});

test('export of a pod with no base is refused', () => {
  const h = tempHome();
  assert.throws(() => exportBase('example', path.join(tempDir(), 'b.md'), { env: h.env }), (e) => e.code === 'no-base');
});
