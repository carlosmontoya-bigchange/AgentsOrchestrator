'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeValue, resolveConfig, diffConfigs } = require('../scripts/lib/resolve.js');

test('personal wins over base, base over defaults', () => {
  const c = resolveConfig([{ Approvals: { design: true, plan: true } }, { Approvals: { plan: false } }, { Approvals: { design: false } }]);
  assert.deepEqual(c.approvals, { design: false, plan: false });
});

test('records merge by id and keep base order', () => {
  const c = resolveConfig([
    { Repos: [{ id: 'a', trunk: 'main' }, { id: 'b', trunk: 'main' }] },
    { Repos: [{ id: 'b', path: 'C:/x y/b' }, { id: 'c', trunk: 'dev' }] },
  ]);
  assert.deepEqual(c.repos.map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(c.repos[1], { id: 'b', trunk: 'main', path: 'C:/x y/b' });
});

test('off removes a record, null removes a key', () => {
  const c = resolveConfig([
    { Policies: [{ id: 'p1', statement: 's' }], Reports: { language: 'en', work_dir: 'x' } },
    { Policies: [{ id: 'p1', off: true }], Reports: { work_dir: null } },
  ]);
  assert.deepEqual(c.policies, []);
  assert.deepEqual(c.reports, { language: 'en' });
});

test('an off record for an id no layer defines is dropped', () => {
  assert.deepEqual(resolveConfig([{ Policies: [{ id: 'gone', off: true }] }]).policies, []);
});

test('arrays of strings are replaced whole', () => {
  const c = resolveConfig([{ Trivial: { max_files: 3, never: ['**/*.sql', '**/*.yml'] } }, { Trivial: { never: ['db/**'] } }]);
  assert.deepEqual(c.trivial, { max_files: 3, never: ['db/**'] });
});

test('nested objects merge key by key', () => {
  const c = resolveConfig([{ Teams: { models: { reviewer: 'opus', tester: 'sonnet' } } }, { Teams: { models: { tester: 'haiku' } } }]);
  assert.deepEqual(c.teams.models, { reviewer: 'opus', tester: 'haiku' });
});

test('resolving does not change the layers it was given', () => {
  const base = { Repos: [{ id: 'a', trunk: 'main' }] };
  resolveConfig([base, { Repos: [{ id: 'a', trunk: 'dev' }] }]);
  assert.deepEqual(base, { Repos: [{ id: 'a', trunk: 'main' }] });
});

test('keepMarkers keeps off records and nulls', () => {
  assert.deepEqual(mergeValue([{ id: 'p1', statement: 's' }], [{ id: 'p1', off: true }], { keepMarkers: true }),
    [{ id: 'p1', statement: 's', off: true }]);
  assert.deepEqual(mergeValue({ a: 1 }, { a: null }, { keepMarkers: true }), { a: null });
});

test('diffConfigs lists changed leaves with record paths', () => {
  assert.deepEqual(
    diffConfigs({ approvals: { plan: true }, repos: [{ id: 'a', trunk: 'main' }] }, { approvals: { plan: false }, repos: [{ id: 'a', trunk: 'dev' }] }),
    [{ path: 'approvals.plan', from: true, to: false }, { path: 'repos[a].trunk', from: 'main', to: 'dev' }]);
});

test('diffConfigs reports a key present on one side only, and a changed list as one leaf', () => {
  assert.deepEqual(
    diffConfigs({ reports: { language: 'en' }, trivial: { never: ['a'] } }, { reports: { language: 'en', work_dir: 'w' }, trivial: { never: ['a', 'b'] } }),
    [{ path: 'reports.work_dir', from: undefined, to: 'w' }, { path: 'trivial.never', from: ['a'], to: ['a', 'b'] }]);
  assert.deepEqual(diffConfigs({ a: { b: 1 } }, { a: { b: 1 } }), []);
});
