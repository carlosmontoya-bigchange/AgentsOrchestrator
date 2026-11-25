'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { matchGlob, firstMatch } = require('../scripts/lib/glob.js');

test('** crosses folders and matches none', () => {
  assert.equal(matchGlob('**/migrations/**', 'db/Migrations/001.sql'), true);
  assert.equal(matchGlob('**/migrations/**', 'migrations/a.sql'), true);
  assert.equal(matchGlob('**/*.sql', 'a.sql'), true);
  assert.equal(matchGlob('src/**/b.cs', 'src/b.cs'), true);
  assert.equal(matchGlob('src/**/b.cs', 'src/x/y/b.cs'), true);
  assert.equal(matchGlob('**', 'any/thing.txt'), true);
});

test('case is ignored', () => assert.equal(matchGlob('**/web.config', 'Site/Web.Config'), true));

test('* stays inside one segment', () => {
  assert.equal(matchGlob('src/*.cs', 'src/a/b.cs'), false);
  assert.equal(matchGlob('src/*.cs', 'src/b.cs'), true);
  assert.equal(matchGlob('**/*Auth*', 'src/MyAuthService.cs'), true);
});

test('braces and a Windows path', () => assert.equal(matchGlob('**/*.{tsx,jsx}', 'ui\\App.TSX'), true));

test('a dot in a glob is a dot', () => assert.equal(matchGlob('**/*.sql', 'a/bsql'), false));

test('? is one character, and other regex characters are plain text', () => {
  assert.equal(matchGlob('a?.txt', 'ab.txt'), true);
  assert.equal(matchGlob('a?.txt', 'a/.txt'), false);
  assert.equal(matchGlob('a+(b).txt', 'a+(b).txt'), true);
  assert.equal(matchGlob('a+(b).txt', 'aab.txt'), false);
});

test('firstMatch returns the first glob that matches, or null', () => {
  assert.equal(firstMatch(['**/*.sql', '**'], 'db/X.SQL'), '**/*.sql');
  assert.equal(firstMatch(['**/*.sql', '**'], 'src/a.cs'), '**');
  assert.equal(firstMatch(['**/*.sql'], 'src/a.cs'), null);
  assert.equal(firstMatch([], 'src/a.cs'), null);
});
