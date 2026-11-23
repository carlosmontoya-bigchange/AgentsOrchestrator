'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigError, parseConfigFile, renderConfigFile, replaceSection } = require('./configfile.js');
const { mergeValue, resolveConfig } = require('./resolve.js');

const FORMAT = 1;
const MIN_PLUGIN = '0.1.0';
const PERSONAL_ONLY = ['repos[].path', 'repos[].proof', 'reports.work_dir'];

function homeDir(env = process.env) {
  return env.POD_HARNESS_HOME || path.join(os.homedir(), '.pod-harness');
}

// The pod name comes from files other people write, and becomes a folder name.
function podDir(pod, env) {
  if (typeof pod !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(pod)) {
    throw new ConfigError('bad-pod-name', `"${pod}" is not a usable pod name. Use letters, digits, spaces, "-" and "_".`);
  }
  return path.join(homeDir(env), pod);
}

function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

function readActive(env) {
  try {
    return JSON.parse(fs.readFileSync(path.join(homeDir(env), 'active.json'), 'utf8')) || {};
  } catch {
    return {};
  }
}

const getActivePod = (env) => readActive(env).pod || null;

// 'author': this machine wrote the pod base. 'member': it imported one.
const getActiveRole = (env) => readActive(env).role || null;

function setActivePod(pod, env, role = 'author') {
  podDir(pod, env);
  writeFileAtomic(path.join(homeDir(env), 'active.json'), JSON.stringify({ pod, role }) + '\n');
}

function layerFile(pod, layer, env) {
  if (layer !== 'base' && layer !== 'personal') throw new ConfigError('bad-layer', `"${layer}" is not a layer. Use base or personal.`);
  return path.join(podDir(pod, env), `${layer}.md`);
}

const newLayerText = (pod, layer) => renderConfigFile({ format: FORMAT, min_plugin: MIN_PLUGIN, layer, pod }, {});

function initPod(pod, env, role = 'author') {
  for (const layer of ['base', 'personal']) {
    const file = layerFile(pod, layer, env);
    if (!fs.existsSync(file)) writeFileAtomic(file, newLayerText(pod, layer));
  }
  setActivePod(pod, env, role);
}

function readLayer(pod, layer, env) {
  const file = layerFile(pod, layer, env);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  return { ...parseConfigFile(text), text };
}

function writeLayerText(pod, layer, text, env) {
  writeFileAtomic(layerFile(pod, layer, env), text);
}

function hasPersonalOnly(sections) {
  const s = Object.fromEntries(Object.entries(sections || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const found = [];
  for (const repo of Array.isArray(s.repos) ? s.repos : []) {
    for (const key of ['path', 'proof']) if (repo && repo[key] !== undefined) found.push(`repos[${repo.id}].${key}`);
  }
  if (s.reports && s.reports.work_dir !== undefined) found.push('reports.work_dir');
  return found;
}

function patchLayer(pod, layer, heading, patch, env) {
  const current = readLayer(pod, layer, env) || { sections: {}, text: newLayerText(pod, layer) };
  const value = mergeValue(current.sections[heading], patch, { keepMarkers: true });
  if (layer === 'base') {
    const found = hasPersonalOnly({ ...current.sections, [heading]: value });
    if (found.length) {
      throw new ConfigError('personal-only', `These settings belong to one machine and cannot go in the pod base: ${found.join(', ')}.`, heading);
    }
  }
  writeLayerText(pod, layer, replaceSection(current.text, heading, value), env);
}

function readDefaults(pluginRoot) {
  return parseConfigFile(fs.readFileSync(path.join(pluginRoot, 'defaults', 'defaults.md'), 'utf8'));
}

function loadConfig(pod, opts) {
  const defaults = readDefaults(opts.pluginRoot).sections;
  const read = (layer) => (readLayer(pod, layer, opts.env) || { sections: {} }).sections;
  const base = read('base');
  const personal = read('personal');
  return { config: resolveConfig([defaults, base, personal]), defaults, base, personal };
}

module.exports = {
  FORMAT, MIN_PLUGIN, PERSONAL_ONLY,
  homeDir, podDir, getActivePod, getActiveRole, setActivePod, initPod,
  readLayer, writeLayerText, patchLayer, hasPersonalOnly, readDefaults, loadConfig,
};
