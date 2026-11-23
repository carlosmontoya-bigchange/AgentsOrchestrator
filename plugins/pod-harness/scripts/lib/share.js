'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ConfigError, parseConfigFile } = require('./configfile.js');
const { podDir, readLayer, writeLayerText, initPod } = require('./store.js');
const { validateBase, checkReadable } = require('./validate.js');

// Takes a pod lead's base file. Writes nothing unless the whole file is usable.
function importBase(filePath, opts) {
  if (!fs.existsSync(filePath)) throw new ConfigError('no-file', `There is no file at ${filePath}.`);
  const text = fs.readFileSync(filePath, 'utf8');
  const { meta, sections } = parseConfigFile(text);
  const readable = checkReadable(meta, opts.pluginVersion);
  if (!readable.ok) throw new ConfigError('too-new', readable.message);
  if (meta.layer !== 'base') throw new ConfigError('not-a-base', `This file is a "${meta.layer}" file, not a pod base file.`);
  podDir(meta.pod, opts.env); // refuses a pod name that would leave the home folder
  const problems = validateBase(sections);
  if (problems.some((p) => p.level === 'error')) return { pod: meta.pod, problems };
  writeLayerText(meta.pod, 'base', text, opts.env);
  initPod(meta.pod, opts.env); // creates personal.md if absent, sets the active pod
  return { pod: meta.pod, problems };
}

function insideRepo(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return true;
    if (path.dirname(d) === d) return false;
  }
}

// Writes the pod base to a file for sharing. Never into a repo: the base must not be pushed.
function exportBase(pod, outPath, opts = {}) {
  const base = readLayer(pod, 'base', opts.env);
  if (!base) throw new ConfigError('no-base', `The pod "${pod}" has no base file yet. Run /pod-harness:setup first.`);
  const problems = validateBase(base.sections).filter((p) => p.level === 'error');
  if (problems.length) throw new ConfigError('invalid-base', `The base cannot be shared yet: ${problems.map((p) => p.message).join(' ')}`);
  const out = path.resolve(outPath);
  if (insideRepo(path.dirname(out))) {
    throw new ConfigError('inside-repo', `${path.dirname(out)} is inside a git repo. Choose a folder outside every repo, so the base file cannot be committed.`);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, base.text);
  return { path: out };
}

module.exports = { importBase, exportBase };
