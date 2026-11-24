#!/usr/bin/env node
'use strict';
// Builds a small pretend workspace for the live checks of /pod-harness:setup and /pod-harness:task.
// usage: node tests/live/make-workspace.js <empty folder>
const path = require('node:path');
const { git, makeRepo } = require('../helpers');

const pkg = (name, scripts) => JSON.stringify({ name, private: true, scripts }, null, 2) + '\n';

// One commit on main, so a task can branch from it. The remotes are made up and nothing can be fetched from
// them, so the trunk the harness branches from (origin/main) is set by hand.
function seed(dir) {
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=Pod Harness', '-c', 'user.email=pod-harness@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Live check workspace');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
}

function makeWorkspace(dir) {
  const repos = [
    makeRepo(dir, 'app', {
      remote: 'https://dev.azure.com/example/p/_git/app',
      trunk: 'main',
      files: { 'App.slnx': '<Solution />\n', 'src/App.cs': '// placeholder\n', 'db/001_init.sql': '-- placeholder\n' },
    }),
    makeRepo(dir, 'web', {
      remote: 'git@github.com:example/web.git',
      trunk: 'main',
      files: {
        'package.json': pkg('web', { build: 'node -e ""', test: 'node --test' }),
        'pnpm-lock.yaml': '',
        '.gitignore': 'node_modules/\n', // running the commands leaves it behind; it is not the task's change
        'src/app.tsx': '// placeholder\n',
        'src/greeting.js': '\'use strict\';\n\nfunction greeting() {\n  return \'hello\';\n}\n\nmodule.exports = { greeting };\n',
        'tests/greeting.test.js': '\'use strict\';\nconst test = require(\'node:test\');\nconst assert = require(\'node:assert/strict\');\nconst { greeting } = require(\'../src/greeting.js\');\n\ntest(\'the greeting\', () => assert.equal(greeting(), \'hello\'));\n',
      },
    }),
    // Its tests always fail: for the live check of the Tester, the returns to Build and "blocked".
    makeRepo(dir, 'broken', {
      remote: 'git@github.com:example/broken.git',
      trunk: 'main',
      files: { 'package.json': pkg('broken', { test: 'node -e "process.exit(1)"' }), '.gitignore': 'node_modules/\n', 'src/thing.js': '// placeholder\n' },
    }),
  ];
  repos.forEach(seed);
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
