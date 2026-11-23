'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pluginRoot, fixture } = require('./helpers');
const { parseConfigFile } = require('../scripts/lib/configfile.js');
const { resolveConfig } = require('../scripts/lib/resolve.js');
const { readDefaults } = require('../scripts/lib/store.js');
const { commandFor, validateConfig, validateBase, sanitize, compareVersions, checkReadable } = require('../scripts/lib/validate.js');

const APP = 'dev.azure.com/org/proj/_git/app';
const exists = () => true; // the example paths are not on this machine
const good = (...extra) => resolveConfig([
  readDefaults(pluginRoot).sections,
  parseConfigFile(fixture('base-example.md')).sections,
  { Repos: [{ id: APP, path: 'C:/src/app' }] },
  ...extra,
]);
const brief = (problems) => problems.map((x) => [x.path, x.level, x.step]);

test('a complete configuration has no problems', () => {
  assert.deepEqual(validateConfig(good(), { platform: 'win32', exists }), []);
});

test('a command missing for this platform is an error on the repo step', () => {
  assert.deepEqual(brief(validateConfig(good(), { platform: 'darwin', exists })), [[`repos[${APP}].test`, 'error', 'repo']]);
});

test('a repo folder that does not exist is an error', () => {
  assert.deepEqual(brief(validateConfig(good(), { platform: 'win32', exists: () => false })), [[`repos[${APP}].path`, 'error', 'repo']]);
});

test('sanitize drops a leftover personal record and reports it', () => {
  const { config, problems } = sanitize(good({ Repos: [{ id: 'gone', path: 'C:/src/gone' }] }));
  assert.deepEqual(config.repos.map((r) => r.id), [APP]);
  assert.deepEqual(brief(problems), [['repos[gone]', 'info', 'repo']]);
});

test('sanitize replaces wrongly shaped settings so nothing after it can crash', () => {
  const { config, problems } = sanitize({ repos: [null], policies: {}, approvals: [], delivery: { webhooks: 'x', remotes: 7 } });
  assert.deepEqual([config.repos, config.policies, config.approvals, config.delivery], [[], [], {}, { webhooks: [], remotes: [] }]);
  assert.deepEqual(brief(problems), [
    ['repos', 'error', 'repo'], ['policies', 'error', 'policies'], ['approvals', 'error', 'approvals'],
    ['delivery.webhooks', 'error', 'delivery'], ['delivery.remotes', 'error', 'delivery'],
  ]);
  assert.doesNotThrow(() => validateConfig(config, { platform: 'win32', exists }));
});

test('sanitize reports a repo whose env or specialists are not lists', () => {
  const { config, problems } = sanitize({ repos: [{ id: 'a', name: 'A', env: 'NUGET_TOKEN', specialists: 'backend' }] });
  assert.deepEqual([config.repos[0].env, config.repos[0].specialists], [[], []]);
  assert.deepEqual(brief(problems), [['repos[a].env', 'error', 'repo'], ['repos[a].specialists', 'error', 'repo']]);
});

test('validateBase refuses wrong shapes and a webhook URL', () => {
  assert.deepEqual(brief(validateBase({ Pod: {}, Repos: [null] })), [['repos', 'error', 'repo']]);
  const base = { ...parseConfigFile(fixture('base-example.md')).sections, Delivery: { webhooks: [{ id: 'teams', env: 'https://example.invalid/hook' }] } };
  assert.deepEqual(brief(validateBase(base)), [['delivery.webhooks', 'error', 'delivery']]);
});

test('"none" is a valid command, and commandFor picks the platform', () => {
  assert.deepEqual(validateConfig(good({ Repos: [{ id: APP, build: 'none' }] }), { platform: 'win32', exists }), []);
  assert.equal(commandFor('none', 'win32'), 'none');
  assert.equal(commandFor({ win32: 'w', linux: 'l' }, 'linux'), 'l');
  assert.equal(commandFor({ win32: 'w' }, 'linux'), null);
  assert.equal(commandFor(undefined, 'linux'), null);
  assert.equal(commandFor('', 'linux'), null);
});

test('a repo that is not cloned is info, not an error', () => {
  assert.deepEqual(brief(validateConfig(good({ Repos: [{ id: APP, path: null }] }), { platform: 'win32', exists })),
    [[`repos[${APP}].path`, 'info', 'repo']]);
});

test('a leftover personal record for a repo the base dropped is reported as info', () => {
  const problems = validateConfig(good({ Repos: [{ id: 'gone', path: 'C:/src/gone' }] }), { platform: 'win32', exists });
  assert.deepEqual(brief(problems), [['repos[gone]', 'info', 'repo']]);
});

test('a configuration with no repo is an error', () => {
  const c = good();
  c.repos = [];
  assert.deepEqual(brief(validateConfig(c, { platform: 'win32', exists })), [['repos', 'error', 'repo']]);
});

test('a webhook URL in the configuration is an error', () => {
  const problems = validateConfig(good({ Delivery: { webhooks: [{ id: 'teams', env: 'https://example.invalid/hook' }] } }), { platform: 'win32', exists });
  assert.ok(problems.length >= 1);
  assert.ok(problems.every((x) => x.level === 'error' && x.step === 'delivery' && x.path.startsWith('delivery.webhooks')));
  assert.deepEqual(validateConfig(good({ Delivery: { webhooks: [{ id: 'teams', env: 'TEAMS_WEBHOOK_URL' }] } }), { platform: 'win32', exists }), []);
});

test('an unknown approval value and a bad policy are errors', () => {
  const problems = validateConfig(good(
    { Approvals: { plan: 'yes' } },
    { Policies: [{ id: 'pod-dod', check: 'hook', source: 'http://example.invalid' }, { id: 'p2', check: 'review', statement: '' }] },
  ), { platform: 'win32', exists });
  assert.deepEqual(brief(problems), [
    ['policies[pod-dod].check', 'error', 'policies'],
    ['policies[pod-dod].source', 'error', 'policies'],
    ['policies[p2].statement', 'error', 'policies'],
    ['approvals.plan', 'error', 'approvals'],
  ]);
});

test('wrong numbers, models, stages and actor are errors with their step', () => {
  const problems = validateConfig(good(
    { Trivial: { max_lines: 0 } }, { Teams: { max_same_kind: 1.5, models: { reviewer: 'gpt' } } },
    { Budget: { max_turns: -1 } }, { Stages: { design: 'no' } }, { Delivery: { actor: 'robot' } },
    { Pod: { tracker: { type: 'jira' } } }, { Repos: [{ id: APP, env: ['BAD NAME'] }] },
  ), { platform: 'win32', exists });
  assert.deepEqual(brief(problems).map((x) => `${x[0]}>${x[2]}`).sort(), [
    'budget.max_turns>teams', 'delivery.actor>delivery', 'pod.tracker.type>pod', `repos[${APP}].env>repo`,
    'stages.design>pod', 'teams.max_same_kind>teams', 'teams.models.reviewer>teams', 'trivial.max_lines>trivial',
  ]);
});

test('validateBase reports personal-only keys and missing Pod or Repos', () => {
  assert.deepEqual(brief(validateBase({ Repos: [{ id: 'a', path: 'p' }], Reports: { work_dir: 'w' } })),
    [['repos[a].path', 'error', 'repo'], ['reports.work_dir', 'error', 'pod'], ['Pod', 'error', 'pod']]);
  assert.deepEqual(brief(validateBase({})), [['Pod', 'error', 'pod'], ['Repos', 'error', 'repo']]);
  assert.deepEqual(validateBase(parseConfigFile(fixture('base-example.md')).sections), []);
});

test('checkReadable refuses a newer format and a higher min_plugin with the exact message', () => {
  assert.equal(checkReadable({ format: 1, min_plugin: '0.3.0' }, '0.1.0').message,
    'This file needs pod-harness 0.3.0 or later. You have 0.1.0. Update the plugin, then run /pod-harness:setup again.');
  assert.equal(checkReadable({ format: 2, min_plugin: '0.1.0' }, '0.1.0').ok, false);
  assert.deepEqual(checkReadable({ format: 1, min_plugin: '0.1.0' }, '0.1.0'), { ok: true });
});

test('compareVersions orders 0.9.0 before 0.10.0', () => {
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(compareVersions('1.0.0', '0.10.0'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
});
