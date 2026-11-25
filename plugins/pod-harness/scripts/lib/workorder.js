'use strict';
// A work order is written by a model, so every field is checked before anything is dispatched from it.
const fs = require('node:fs');
const path = require('node:path');
const { isObject } = require('./resolve.js');
const { writeFileAtomic } = require('./store.js');
const { matchGlob } = require('./glob.js');

const BUILD_AGENTS = ['backend', 'frontend', 'database'];
const SIZES = ['S', 'M', 'L'];
const EFFORTS = ['low', 'medium', 'high'];
const filled = (v) => typeof v === 'string' && v.trim() !== '';
const sentences = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

function readJson(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { value: null, problems: [] };
  }
  try {
    return { value: JSON.parse(text.replace(/^﻿/, '')), problems: [] };
  } catch (e) {
    return { value: null, problems: [`${what} is not valid JSON: ${e.message}`] };
  }
}

function readWorkOrder(dir) {
  const { value, problems } = readJson(path.join(dir, 'work-order.json'), 'work-order.json');
  return { order: value, problems };
}

function writeWorkOrder(dir, order) {
  writeFileAtomic(path.join(dir, 'work-order.json'), JSON.stringify(order, null, 2) + '\n');
}

// opts.script: the order was written by the harness itself, which is the only writer allowed to say "trivial".
function validateWorkOrder(order, config, opts = {}) {
  if (!isObject(order)) return ['The work order is not a JSON object.'];
  const problems = [];
  if (order.format !== 1) problems.push('The format must be 1.');
  if (!SIZES.includes(order.size) && !(opts.script && order.size === 'trivial')) problems.push('The size must be S, M or L.');
  if (!filled(order.summary) || order.summary.length > 200) problems.push('The summary must be one sentence of at most 200 characters.');

  const repos = sentences(order.repos) ? order.repos : [];
  const agents = Array.isArray(order.agents) ? order.agents : [];
  // No agent is right when nothing can be built until a person answers: the questions then say what is missing.
  // Such an order may name no repo either: which repo it is can be the question.
  const asks = sentences(order.questions) && order.questions.some(filled);
  const onlyAsks = agents.length === 0 && asks;
  if (repos.length === 0 && !onlyAsks) problems.push('The work order names no repo.');
  for (const id of repos) {
    const repo = (config.repos || []).find((r) => r.id === id);
    if (!repo) problems.push(`The repo ${id} is not set up for this pod.`);
    else if (!repo.path || !fs.existsSync(repo.path)) problems.push(`${repo.name} has no folder on this machine.`);
  }

  if (agents.length === 0 && !asks) problems.push('The work order names no Build agent and asks no question.');
  agents.forEach((a, i) => {
    const at = `Agent ${i + 1}`;
    if (!isObject(a)) {
      problems.push(`${at}: it is not a record.`);
      return;
    }
    if (a.stage !== 'build') problems.push(`${at}: the stage must be "build".`);
    if (!BUILD_AGENTS.includes(a.agent)) problems.push(`${at}: "${a.agent}" is not a Build agent. Use ${BUILD_AGENTS.slice(0, -1).join(', ')} or ${BUILD_AGENTS.at(-1)}.`);
    if (!repos.includes(a.repo)) problems.push(`${at}: its repo is not in "repos".`);
    if (!filled(a.job)) problems.push(`${at}: it has no job.`);
    if (a.effort !== undefined && !EFFORTS.includes(a.effort)) problems.push(`${at}: the effort must be low, medium or high.`);
    if (a.read !== undefined && !sentences(a.read)) problems.push(`${at}: "read" must be a list of places.`);
  });
  const teams = config.teams || {};
  if (agents.length > teams.max_agents_per_stage) {
    problems.push(`The work order has ${agents.length} Build agents. This pod allows ${teams.max_agents_per_stage} in one stage.`);
  } else {
    for (const kind of BUILD_AGENTS) {
      const count = agents.filter((a) => isObject(a) && a.agent === kind).length;
      if (count > teams.max_same_kind) problems.push(`The work order has ${count} ${kind} agents. This pod allows ${teams.max_same_kind} of one kind.`);
    }
  }
  for (const key of ['checks', 'risks', 'questions']) {
    if (!sentences(order[key])) problems.push(`"${key}" must be a list of sentences.`);
  }
  return problems;
}

// Each agent gets a key that names its files: backend, backend-2, database.
function withKeys(order) {
  const seen = {};
  return order.agents.map((a) => {
    seen[a.agent] = (seen[a.agent] || 0) + 1;
    return { ...a, key: seen[a.agent] === 1 ? a.agent : `${a.agent}-${seen[a.agent]}` };
  });
}

// Two agents never work in one repo at the same time: an agent's wave is how many earlier agents share its repo.
function waves(agents) {
  const out = [];
  agents.forEach((a, i) => {
    const wave = agents.slice(0, i).filter((b) => b.repo === a.repo).length;
    (out[wave] = out[wave] || []).push(a);
  });
  return out;
}

function specialistFor(repo, filePath) {
  const hit = (repo.specialists || []).find((s) => matchGlob(s.glob, filePath));
  return hit && BUILD_AGENTS.includes(hit.agent) ? hit.agent : 'backend';
}

// The fast path has no Orchestrator: the script writes the order for one specialist.
function fastOrder(repo, places) {
  return {
    format: 1, size: 'trivial', summary: `A trivial change in ${repo.name}.`, repos: [repo.id],
    agents: [{ stage: 'build', agent: specialistFor(repo, places[0]), repo: repo.id, job: 'Make the change in the request, with its automated tests.', read: places }],
    checks: [], risks: [], questions: [], debate: false,
  };
}

function readContext(dir) {
  const { value, problems } = readJson(path.join(dir, 'context.json'), 'context.json');
  if (problems.length || value === null) return { context: null, problems };
  const ok = isObject(value) && Array.isArray(value.found) && value.found.every((f) => isObject(f) && filled(f.path));
  return ok ? { context: value, problems: [] } : { context: null, problems: ['context.json must hold a "found" list whose entries each have a "path".'] };
}

module.exports = { BUILD_AGENTS, readWorkOrder, writeWorkOrder, validateWorkOrder, withKeys, waves, specialistFor, fastOrder, readContext };
