#!/usr/bin/env node
'use strict';
// Builds a small pretend workspace for the live checks of /pod-harness:setup.
// usage: node tests/live/make-workspace.js <empty folder>
const path = require('node:path');
const { makeRepo } = require('../helpers');

function makeWorkspace(dir) {
  makeRepo(dir, 'app', {
    remote: 'https://dev.azure.com/example/p/_git/app',
    trunk: 'main',
    files: { 'App.slnx': '<Solution />\n', 'src/App.cs': '// placeholder\n', 'db/001_init.sql': '-- placeholder\n' },
  });
  makeRepo(dir, 'web', {
    remote: 'git@github.com:example/web.git',
    trunk: 'main',
    files: {
      'package.json': JSON.stringify({ name: 'web', private: true, scripts: { build: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' } }, null, 2) + '\n',
      'pnpm-lock.yaml': '',
      'src/app.tsx': '// placeholder\n',
    },
  });
  return dir;
}

if (require.main === module) {
  if (!process.argv[2]) {
    console.error('usage: node tests/live/make-workspace.js <empty folder>');
    process.exitCode = 1;
  } else {
    console.log(makeWorkspace(path.resolve(process.argv[2])));
  }
}

module.exports = { makeWorkspace };
