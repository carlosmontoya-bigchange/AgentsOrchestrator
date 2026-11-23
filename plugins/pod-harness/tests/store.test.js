'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pluginRoot, tempHome, fixture } = require('./helpers');
const store = require('../scripts/lib/store.js');
const { homeDir, podDir, getActivePod, initPod, readLayer, writeLayerText, patchLayer, readDefaults, loadConfig, hasPersonalOnly } = store;

test('homeDir honours POD_HARNESS_HOME and defaults to ~/.pod-harness', () => {
  const h = tempHome();
  assert.equal(homeDir(h.env), h.dir);
  assert.equal(homeDir({}), path.join(os.homedir(), '.pod-harness'));
});

test('initPod creates both files and the active pod, in a path with a space', () => {
  const h = tempHome();
  assert.ok(h.dir.includes(' '));
  assert.equal(getActivePod(h.env), null);
  initPod('example', h.env);
  assert.equal(getActivePod(h.env), 'example');
  assert.equal(readLayer('example', 'base', h.env).meta.layer, 'base');
  assert.deepEqual(readLayer('example', 'personal', h.env).sections, {});
});

test('the active pod remembers whether this machine wrote the base or imported it', () => {
  const h = tempHome();
  assert.equal(store.getActiveRole(h.env), null);
  initPod('example', h.env);
  assert.equal(store.getActiveRole(h.env), 'author');
  initPod('example', h.env, 'member');
  assert.equal(store.getActiveRole(h.env), 'member');
  assert.equal(getActivePod(h.env), 'example');
});

test('initPod does not overwrite files that exist', () => {
  const h = tempHome();
  initPod('example', h.env);
  patchLayer('example', 'personal', 'Approvals', { plan: false }, h.env);
  initPod('example', h.env);
  assert.deepEqual(readLayer('example', 'personal', h.env).sections.Approvals, { plan: false });
});

test('a pod name that would leave the home folder is refused', () => {
  const h = tempHome();
  assert.throws(() => initPod('../outside', h.env), (e) => e.code === 'bad-pod-name');
  assert.throws(() => podDir('', h.env), (e) => e.code === 'bad-pod-name');
});

test('patchLayer writes one section and keeps the rest of the file', () => {
  const h = tempHome();
  initPod('example', h.env);
  patchLayer('example', 'personal', 'Approvals', { plan: false }, h.env);
  fs.appendFileSync(path.join(podDir('example', h.env), 'personal.md'), '\nMy own note.\n');
  patchLayer('example', 'personal', 'Approvals', { design: false }, h.env);
  const layer = readLayer('example', 'personal', h.env);
  assert.deepEqual(layer.sections.Approvals, { plan: false, design: false });
  assert.ok(layer.text.includes('My own note.'));
});

test('patchLayer keeps an off record in the personal file', () => {
  const h = tempHome();
  initPod('example', h.env);
  patchLayer('example', 'personal', 'Policies', [{ id: 'pod-dod', off: true }], h.env);
  assert.equal(readLayer('example', 'personal', h.env).sections.Policies[0].off, true);
});

test('patchLayer refuses a personal-only key in the base and writes nothing', () => {
  const h = tempHome();
  initPod('example', h.env);
  assert.throws(() => patchLayer('example', 'base', 'Repos', [{ id: 'a', path: 'C:/x' }], h.env), (e) => e.code === 'personal-only');
  assert.throws(() => patchLayer('example', 'base', 'Reports', { work_dir: 'C:/w' }, h.env), (e) => e.code === 'personal-only');
  assert.deepEqual(readLayer('example', 'base', h.env).sections, {});
});

test('hasPersonalOnly finds the keys under heading names and lower-case names', () => {
  const found = ['repos[a].path', 'repos[a].proof', 'reports.work_dir'];
  assert.deepEqual(hasPersonalOnly({ Repos: [{ id: 'a', path: 'p', proof: {} }], Reports: { work_dir: 'w' } }), found);
  assert.deepEqual(hasPersonalOnly({ repos: [{ id: 'a', path: 'p', proof: {} }], reports: { work_dir: 'w' } }), found);
  assert.deepEqual(hasPersonalOnly({ Repos: [{ id: 'a', trunk: 'main' }] }), []);
});

test('writeLayerText leaves no temp file, and a failed write cleans up and leaves the other layer alone', () => {
  const h = tempHome();
  initPod('example', h.env);
  const dir = podDir('example', h.env);
  const base = readLayer('example', 'base', h.env).text;
  writeLayerText('example', 'base', base, h.env);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')), []);

  const personalBefore = fs.readFileSync(path.join(dir, 'personal.md'), 'utf8');
  fs.rmSync(path.join(dir, 'base.md'));
  fs.mkdirSync(path.join(dir, 'base.md')); // a folder in the way makes the final rename fail
  assert.throws(() => writeLayerText('example', 'base', base, h.env));
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')), []);
  assert.equal(fs.readFileSync(path.join(dir, 'personal.md'), 'utf8'), personalBefore);
});

test('the shipped defaults parse and hold the four stage checkpoints as true', () => {
  const d = readDefaults(pluginRoot);
  assert.equal(d.meta.layer, 'defaults');
  assert.equal(Object.keys(d.sections.Approvals).length, 4);
  assert.ok(Object.values(d.sections.Approvals).every((v) => v === true));
  assert.equal(d.sections.Trivial.max_lines, 50);
  assert.equal(d.sections.Policies.length, 3);
  // Outward actions are left to Claude's own permission prompts, so no org policy asks for them.
  assert.ok(d.sections.Policies.every((p) => p.check === 'review'));
  assert.deepEqual([d.sections.Delivery.never, d.sections.Delivery.always_ask], [[], []]);
  assert.equal(d.sections.Pod, undefined);
});

test('loadConfig merges defaults, base and personal', () => {
  const h = tempHome();
  initPod('example', h.env);
  writeLayerText('example', 'base', fixture('base-example.md'), h.env);
  patchLayer('example', 'personal', 'Repos', [{ id: 'dev.azure.com/org/proj/_git/app', path: 'C:/src/app' }], h.env);
  patchLayer('example', 'personal', 'Approvals', { plan: false }, h.env);
  const { config, base, personal } = loadConfig('example', { env: h.env, pluginRoot });
  assert.equal(config.pod.name, 'example');
  assert.equal(config.repos[0].trunk, 'main');
  assert.equal(config.repos[0].path, 'C:/src/app');
  assert.equal(config.approvals.plan, false);
  assert.equal(config.approvals.design, true);
  assert.equal(config.policies.length, 4);
  assert.equal(base.Repos[0].path, undefined);
  assert.deepEqual(personal.Approvals, { plan: false });
});
