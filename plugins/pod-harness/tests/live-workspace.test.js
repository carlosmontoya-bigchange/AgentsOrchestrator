'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDir } = require('./helpers');
const { detectRepos } = require('../scripts/lib/detect.js');
const { makeWorkspace } = require('./live/make-workspace.js');

test('the live-check workspace has the two repos the live checks expect', () => {
  const dir = tempDir();
  makeWorkspace(dir);
  const [app, web] = detectRepos(dir);
  assert.deepEqual([app.id, app.trunk, app.build, app.test], ['dev.azure.com/example/p/_git/app', 'main', 'dotnet build App.slnx', 'dotnet test App.slnx']);
  assert.deepEqual(app.specialists.map((s) => s.agent), ['database', 'backend']);
  assert.deepEqual([web.id, web.trunk, web.build, web.test], ['github.com/example/web', 'main', 'pnpm run build', 'pnpm test']);
  assert.deepEqual(web.specialists, [{ glob: '**', agent: 'frontend' }]);
});
