#!/usr/bin/env node
'use strict';
// One JSON document per command. The skills call this; they never write the configuration themselves.
const fs = require('node:fs');
const path = require('node:path');
const { ConfigError } = require('./lib/configfile.js');
const { resolveConfig, diffConfigs } = require('./lib/resolve.js');
const store = require('./lib/store.js');
const { validateConfig, sanitize, hasWebhookUrl } = require('./lib/validate.js');
const { detectRepos, dedupeRepos, matchRepos } = require('./lib/detect.js');
const { checkEnvironment, checkAccess, proveRepo } = require('./lib/checks.js');
const { importBase, exportBase } = require('./lib/share.js');
const { matchGlob } = require('./lib/glob.js');
const { run } = require('./lib/run.js');

const COMMANDS = ['env-check', 'init', 'detect', 'match', 'import', 'export', 'show', 'set', 'prove', 'doctor', 'trivial-count'];
const NO_POD_NEEDED = ['env-check', 'init', 'detect', 'import'];
const pluginRoot = path.join(__dirname, '..');
const pluginVersion = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const PERSONAL_PATH = /^(repos\[.*\]\.(path|proof)|reports\.work_dir)$/;

// A repo that only the personal file has differs as a whole record: its folder and proof stay on this machine.
function withoutLocal(d) {
  if (!/^repos\[.*\]$/.test(d.path) || !d.to || typeof d.to !== 'object') return d;
  const { path: _path, proof: _proof, ...rest } = d.to;
  return { ...d, to: rest };
}

function need(value, what) {
  if (!value) throw new ConfigError('missing-argument', `This command needs ${what}.`);
  return value;
}

function readPatch(arg, cwd) {
  const text = arg.startsWith('@') ? fs.readFileSync(path.resolve(cwd, arg.slice(1)), 'utf8').replace(/^﻿/, '') : arg;
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

  detect: ([dir], c) => dedupeRepos(detectRepos(path.resolve(c.cwd, need(dir, 'a folder')))),

  match: ([dir], c) => matchRepos(c.load().config.repos, detectRepos(path.resolve(c.cwd, need(dir, 'a folder')))),

  import: ([file], c) => importBase(path.resolve(c.cwd, need(file, 'the base file')), { env: c.env, pluginVersion }),

  export: (args, c) => {
    const out = args.find((a) => a !== '--force');
    return exportBase(c.pod, path.resolve(c.cwd, need(out, 'a file to write')), { env: c.env, force: args.includes('--force') });
  },

  show: (args, c) => ({ pod: c.pod, role: store.getActiveRole(c.env), config: c.load().config }),

  set: ([layer, heading, json], c) => {
    const patch = readPatch(need(json, 'a layer, a heading and the settings as JSON'), c.cwd);
    if (hasWebhookUrl({ [heading]: patch })) {
      throw new ConfigError('secret', 'That is a webhook URL. Nothing was stored. Keep the URL in an environment variable and give only the variable\'s name.', heading);
    }
    store.patchLayer(c.pod, layer, heading, patch, c.env);
    const section = heading.toLowerCase();
    const loaded = c.load();
    const problems = [...loaded.problems, ...validateConfig(loaded.config)].filter((p) => p.level === 'error' && p.path.toLowerCase().startsWith(section));
    return { ok: true, problems };
  },

  prove: async ([repoId], c) => {
    const repo = (c.load().config.repos || []).find((r) => r.id === repoId);
    if (!repo) throw new ConfigError('no-repo', `No repo with the id "${repoId}" is set up.`);
    const result = await proveRepo(repo, { env: c.env });
    store.patchLayer(c.pod, 'personal', 'Repos', [{ id: repo.id, proof: { build: result.build, test: result.test, at: result.at } }], c.env);
    return result;
  },

  // How many tracked files each "never trivial" glob catches, so the author sees what a glob really covers.
  'trivial-count': (args, c) => {
    const { config } = c.load();
    const repos = (config.repos || []).filter((r) => r.path).map((r) => ({
      name: r.name,
      files: run('git', ['-C', r.path, 'ls-files'], { timeoutMs: 60000 }).stdout.split('\n').filter(Boolean),
    }));
    const globs = Array.isArray(config.trivial && config.trivial.never) ? config.trivial.never : [];
    return { counts: globs.flatMap((glob) => repos.map((r) => ({ glob, repo: r.name, files: r.files.filter((f) => matchGlob(glob, f)).length }))) };
  },

  doctor: (args, c) => {
    const { config, problems, defaults, base, personal } = c.load();
    return {
      environment: checkEnvironment({ env: c.env }),
      problems: [...problems, ...validateConfig(config)],
      access: checkAccess(config),
      differs: diffConfigs(resolveConfig([defaults, base]), resolveConfig([defaults, base, personal])).filter((d) => !PERSONAL_PATH.test(d.path)).map(withoutLocal),
    };
  },
};

async function main(argv, io) {
  const print = (value) => io.stdout.write(JSON.stringify(value, null, 2) + '\n');
  const [command, ...args] = argv;
  try {
    if (!COMMANDS.includes(command)) throw new ConfigError('unknown-command', `Unknown command "${command}". Commands: ${COMMANDS.join(', ')}.`);
    const pod = store.getActivePod(io.env);
    if (!pod && !NO_POD_NEEDED.includes(command)) throw new ConfigError('no-pod', 'No pod is set up on this machine yet. Run /pod-harness:setup.');
    // Every command reads the configuration through sanitize, so a hand-edited file cannot crash one.
    const load = () => {
      const loaded = store.loadConfig(pod, { env: io.env, pluginRoot });
      return { ...loaded, ...sanitize(loaded.config) };
    };
    const context = { env: io.env, cwd: io.cwd, pod, load };
    print(await handlers[command](args, context));
    return 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      print({ error: { code: e.code, message: e.message, heading: e.heading, file: e.file } });
      return 1;
    }
    print({ error: { code: 'internal', message: e.message } });
    return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2), { env: process.env, stdout: process.stdout, cwd: process.cwd() }).then((code) => { process.exitCode = code; });
}

module.exports = { COMMANDS, main };
