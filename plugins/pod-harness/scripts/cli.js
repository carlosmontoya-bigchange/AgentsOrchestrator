#!/usr/bin/env node
'use strict';
// One JSON document per command. The skills call this; they never write the configuration themselves.
const fs = require('node:fs');
const path = require('node:path');
const { ConfigError } = require('./lib/configfile.js');
const { resolveConfig, diffConfigs } = require('./lib/resolve.js');
const store = require('./lib/store.js');
const { validateConfig } = require('./lib/validate.js');
const { detectRepos, matchRepos } = require('./lib/detect.js');
const { checkEnvironment, checkAccess, proveRepo } = require('./lib/checks.js');
const { importBase, exportBase } = require('./lib/share.js');

const COMMANDS = ['env-check', 'init', 'detect', 'match', 'import', 'export', 'show', 'set', 'prove', 'doctor'];
const NO_POD_NEEDED = ['env-check', 'init', 'detect', 'import'];
const pluginRoot = path.join(__dirname, '..');
const pluginVersion = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const PERSONAL_PATH = /^(repos\[.*\]\.(path|proof)|reports\.work_dir)$/;

function need(value, what) {
  if (!value) throw new ConfigError('missing-argument', `This command needs ${what}.`);
  return value;
}

function readPatch(arg, cwd) {
  const text = arg.startsWith('@') ? fs.readFileSync(path.resolve(cwd, arg.slice(1)), 'utf8') : arg;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ConfigError('bad-json', `The settings to store are not valid JSON: ${e.message}`);
  }
}

const handlers = {
  'env-check': (args, c) => ({ checks: checkEnvironment({ env: c.env }) }),

  init: ([pod], c) => {
    store.initPod(need(pod, 'a pod name'), c.env);
    return { pod, home: store.homeDir(c.env) };
  },

  detect: ([dir], c) => ({ repos: detectRepos(path.resolve(c.cwd, need(dir, 'a folder'))) }),

  match: ([dir], c) => matchRepos(c.load().config.repos, detectRepos(path.resolve(c.cwd, need(dir, 'a folder')))),

  import: ([file], c) => importBase(path.resolve(c.cwd, need(file, 'the base file')), { env: c.env, pluginVersion }),

  export: ([out], c) => exportBase(c.pod, path.resolve(c.cwd, need(out, 'a file to write')), { env: c.env }),

  show: (args, c) => ({ pod: c.pod, config: c.load().config }),

  set: ([layer, heading, json], c) => {
    const patch = readPatch(need(json, 'a layer, a heading and the settings as JSON'), c.cwd);
    store.patchLayer(c.pod, layer, heading, patch, c.env);
    const section = heading.toLowerCase();
    const problems = validateConfig(c.load().config).filter((p) => p.level === 'error' && p.path.toLowerCase().startsWith(section));
    return { ok: true, problems };
  },

  prove: ([repoId], c) => {
    const repo = (c.load().config.repos || []).find((r) => r.id === repoId);
    if (!repo) throw new ConfigError('no-repo', `No repo with the id "${repoId}" is set up.`);
    const result = proveRepo(repo, { env: c.env });
    store.patchLayer(c.pod, 'personal', 'Repos', [{ id: repo.id, proof: { build: result.build, test: result.test, at: result.at } }], c.env);
    return result;
  },

  doctor: (args, c) => {
    const { config, defaults, base, personal } = c.load();
    return {
      environment: checkEnvironment({ env: c.env }),
      problems: validateConfig(config),
      access: checkAccess(config),
      differs: diffConfigs(resolveConfig([defaults, base]), resolveConfig([defaults, base, personal])).filter((d) => !PERSONAL_PATH.test(d.path)),
    };
  },
};

function main(argv, io) {
  const print = (value) => io.stdout.write(JSON.stringify(value, null, 2) + '\n');
  const [command, ...args] = argv;
  try {
    if (!COMMANDS.includes(command)) throw new ConfigError('unknown-command', `Unknown command "${command}". Commands: ${COMMANDS.join(', ')}.`);
    const pod = store.getActivePod(io.env);
    if (!pod && !NO_POD_NEEDED.includes(command)) throw new ConfigError('no-pod', 'No pod is set up on this machine yet. Run /pod-harness:setup.');
    const context = { env: io.env, cwd: io.cwd, pod, load: () => store.loadConfig(pod, { env: io.env, pluginRoot }) };
    print(handlers[command](args, context));
    return 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      print({ error: { code: e.code, message: e.message, heading: e.heading } });
      return 1;
    }
    print({ error: { code: 'internal', message: e.message } });
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), { env: process.env, stdout: process.stdout, cwd: process.cwd() });
}

module.exports = { COMMANDS, main };
