'use strict';
const fs = require('node:fs');
const { hasPersonalOnly } = require('./store.js');
const { isObject, isIdArray } = require('./resolve.js');

const SUPPORTED_FORMAT = 1;
const TRACKERS = ['azure-devops', 'github', 'none'];
const MODELS = ['haiku', 'sonnet', 'opus'];
const STAGE_KEYS = ['design', 'plan', 'test', 'review', 'deliver'];
const APPROVAL_KEYS = ['work_order', 'design', 'plan', 'review_result', 'outward_action', 'destructive_local', 'policy_exception', 'budget_reached', 'task_grew'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const filled = (v) => typeof v === 'string' && v.trim() !== '';
const positiveInt = (v) => Number.isInteger(v) && v > 0;

// A command is a string, a per-platform object, or "none". Null means: nothing usable here.
function commandFor(cmd, platform) {
  if (filled(cmd)) return cmd;
  if (cmd && typeof cmd === 'object' && filled(cmd[platform])) return cmd[platform];
  return null;
}

function hasUrl(value) {
  if (typeof value === 'string') return /^https?:/i.test(value);
  if (value && typeof value === 'object') return Object.values(value).some(hasUrl);
  return false;
}

const WEBHOOK_URL = 'A webhook URL is in the configuration. Keep the URL in an environment variable and store only its name.';
const LIST_SECTIONS = { repos: 'repo', policies: 'policies' };
const OBJECT_SECTIONS = { pod: 'pod', stages: 'pod', teams: 'teams', reports: 'pod', trivial: 'trivial', skills: 'teams', approvals: 'approvals', delivery: 'delivery', budget: 'teams' };
const stringList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

// Files are written by people. Replaces wrongly shaped settings with empty ones and drops repo records
// that have no name (personal settings left over for a repo the base no longer lists), reporting each.
// Everything after this can rely on the shapes.
function sanitize(config) {
  const out = structuredClone(config);
  const problems = [];
  const add = (path, step, message, level = 'error') => problems.push({ path, level, message, step });
  const fix = (holder, key, good, empty, path, step, message) => {
    if (holder[key] === undefined || good(holder[key])) return;
    add(path, step, message);
    holder[key] = empty;
  };
  for (const [key, step] of Object.entries(LIST_SECTIONS)) fix(out, key, isIdArray, [], key, step, `"${key}" must be a list of records, each with an "id".`);
  for (const [key, step] of Object.entries(OBJECT_SECTIONS)) fix(out, key, isObject, {}, key, step, `"${key}" must be a group of settings between { and }.`);

  for (const repo of out.repos || []) {
    const at = `repos[${repo.id}]`;
    fix(repo, 'env', stringList, [], `${at}.env`, 'repo', 'The environment variables must be a list of names.');
    fix(repo, 'specialists', (v) => Array.isArray(v) && v.every((s) => isObject(s) && filled(s.glob) && filled(s.agent)), [],
      `${at}.specialists`, 'repo', 'The specialists must be a list of records with a "glob" and an "agent".');
  }
  if (out.repos) {
    for (const repo of out.repos.filter((r) => !filled(r.name))) {
      add(`repos[${repo.id}]`, 'repo', 'Personal settings are left over for a repo the pod base no longer lists.', 'info');
    }
    out.repos = out.repos.filter((r) => filled(r.name));
  }
  if (out.delivery) {
    fix(out.delivery, 'webhooks', isIdArray, [], 'delivery.webhooks', 'delivery', 'The webhooks must be a list of records, each with an "id" and an "env".');
    fix(out.delivery, 'remotes', stringList, [], 'delivery.remotes', 'delivery', 'The allowed remotes must be a list of names.');
  }
  return { config: out, problems };
}

const lowerKeys = (sections) => Object.fromEntries(Object.entries(sections || {}).map(([k, v]) => [k.toLowerCase(), v]));

function validateConfig(config, opts = {}) {
  const platform = opts.platform || process.platform;
  const exists = opts.exists || fs.existsSync;
  const problems = [];
  const add = (path, step, message, level = 'error') => problems.push({ path, level, message, step });

  const pod = config.pod || {};
  if (!filled(pod.name)) add('pod.name', 'pod', 'The pod has no name.');
  if (!TRACKERS.includes(pod.tracker && pod.tracker.type)) add('pod.tracker.type', 'pod', `The tracker type must be one of: ${TRACKERS.join(', ')}.`);

  const records = (v) => (Array.isArray(v) ? v.filter(isObject) : []);
  const repos = records(config.repos);
  if (!repos.some((r) => filled(r.name))) add('repos', 'repo', 'No repo is set up.');
  for (const repo of repos) {
    const at = `repos[${repo.id}]`;
    if (!filled(repo.name)) {
      add(at, 'repo', 'Personal settings are left over for a repo the pod base no longer lists.', 'info');
      continue;
    }
    if (!filled(repo.trunk)) add(`${at}.trunk`, 'repo', `${repo.name} has no trunk branch.`);
    for (const key of ['build', 'test']) {
      if (commandFor(repo[key], platform) === null) add(`${at}.${key}`, 'repo', `${repo.name} has no ${key} command for ${platform}. Use "none" if it has none.`);
    }
    if (!filled(repo.path)) add(`${at}.path`, 'repo', `${repo.name} is not cloned on this machine, or its folder is not set.`, 'info');
    else if (!exists(repo.path)) add(`${at}.path`, 'repo', `The folder set for ${repo.name} does not exist: ${repo.path}`);
    if (!(stringList(repo.env) ? repo.env : []).every((name) => ENV_NAME.test(name))) add(`${at}.env`, 'repo', `${repo.name} lists something that is not an environment variable name.`);
  }

  const trivial = config.trivial || {};
  for (const key of ['max_files', 'max_lines', 'max_test_lines']) {
    if (!positiveInt(trivial[key])) add(`trivial.${key}`, 'trivial', `${key} must be a whole number above zero.`);
  }
  if (!Array.isArray(trivial.never) || !trivial.never.every(filled)) add('trivial.never', 'trivial', 'The "never trivial" paths must be a list of globs.');

  for (const policy of records(config.policies)) {
    const at = `policies[${policy.id}]`;
    if (policy.check !== 'approval' && policy.check !== 'review') add(`${at}.check`, 'policies', 'A policy is upheld by "approval" or by "review".');
    if (!filled(policy.statement)) add(`${at}.statement`, 'policies', 'The policy has no one-line statement.');
    if (policy.source !== undefined && !/^https:\/\//.test(policy.source)) add(`${at}.source`, 'policies', 'The source must be an https link.');
  }

  const approvals = config.approvals || {};
  for (const key of APPROVAL_KEYS) {
    if (typeof approvals[key] !== 'boolean') add(`approvals.${key}`, 'approvals', `${key} must be on (true) or off (false).`);
  }

  const delivery = config.delivery || {};
  if (delivery.actor !== 'main' && delivery.actor !== 'agent') add('delivery.actor', 'delivery', 'Outward actions are performed by "main" or by "agent".');
  for (const hook of records(delivery.webhooks)) {
    if (!ENV_NAME.test(hook.env || '')) add(`delivery.webhooks[${hook.id}].env`, 'delivery', 'A webhook holds the name of the environment variable that has its URL.');
  }
  if (hasUrl(delivery.webhooks)) add('delivery.webhooks', 'delivery', WEBHOOK_URL);

  const teams = config.teams || {};
  for (const [agent, model] of Object.entries(teams.models || {})) {
    if (!MODELS.includes(model)) add(`teams.models.${agent}`, 'teams', `The model must be one of: ${MODELS.join(', ')}.`);
  }
  for (const key of ['max_agents_per_stage', 'max_same_kind']) {
    if (!positiveInt(teams[key])) add(`teams.${key}`, 'teams', `${key} must be a whole number above zero.`);
  }
  const budget = config.budget || {};
  for (const key of ['tokens_per_stage', 'max_turns']) {
    if (!positiveInt(budget[key])) add(`budget.${key}`, 'teams', `${key} must be a whole number above zero.`);
  }

  const stages = config.stages || {};
  for (const key of STAGE_KEYS) {
    if (typeof stages[key] !== 'boolean') add(`stages.${key}`, 'pod', `${key} must be on (true) or off (false).`);
  }
  return problems;
}

// A base file is shared, so it may not hold what belongs to one machine.
function validateBase(sections) {
  const problems = hasPersonalOnly(sections).map((path) => ({
    path, level: 'error', step: path.startsWith('repos') ? 'repo' : 'pod',
    message: `${path} belongs to one machine and cannot be in a pod base file.`,
  }));
  for (const [heading, step] of [['Pod', 'pod'], ['Repos', 'repo']]) {
    if (sections[heading] === undefined) problems.push({ path: heading, level: 'error', step, message: `The base file has no "${heading}" heading.` });
  }
  const lower = lowerKeys(sections);
  problems.push(...sanitize(lower).problems.filter((p) => p.level === 'error'));
  if (hasWebhookUrl(lower)) problems.push({ path: 'delivery.webhooks', level: 'error', step: 'delivery', message: WEBHOOK_URL });
  return problems;
}

// True when a settings group (keys in any case) holds a URL where a webhook's variable name belongs.
function hasWebhookUrl(sections) {
  const delivery = lowerKeys(sections).delivery;
  return isObject(delivery) && hasUrl(delivery.webhooks);
}

function compareVersions(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function checkReadable(meta, pluginVersion) {
  if (meta.format > SUPPORTED_FORMAT || compareVersions(meta.min_plugin, pluginVersion) > 0) {
    return { ok: false, message: `This file needs pod-harness ${meta.min_plugin} or later. You have ${pluginVersion}. Update the plugin, then run /pod-harness:setup again.` };
  }
  return { ok: true };
}

module.exports = { SUPPORTED_FORMAT, APPROVAL_KEYS, STAGE_KEYS, commandFor, sanitize, hasWebhookUrl, validateConfig, validateBase, compareVersions, checkReadable };
