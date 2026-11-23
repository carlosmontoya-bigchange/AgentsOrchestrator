'use strict';
const { hasPersonalOnly } = require('./store.js');

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

function validateConfig(config, opts = {}) {
  const platform = opts.platform || process.platform;
  const problems = [];
  const add = (path, step, message, level = 'error') => problems.push({ path, level, message, step });

  const pod = config.pod || {};
  if (!filled(pod.name)) add('pod.name', 'pod', 'The pod has no name.');
  if (!TRACKERS.includes(pod.tracker && pod.tracker.type)) add('pod.tracker.type', 'pod', `The tracker type must be one of: ${TRACKERS.join(', ')}.`);

  const repos = Array.isArray(config.repos) ? config.repos : [];
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
    if (!(repo.env || []).every((name) => ENV_NAME.test(name))) add(`${at}.env`, 'repo', `${repo.name} lists something that is not an environment variable name.`);
  }

  const trivial = config.trivial || {};
  for (const key of ['max_files', 'max_lines', 'max_test_lines']) {
    if (!positiveInt(trivial[key])) add(`trivial.${key}`, 'trivial', `${key} must be a whole number above zero.`);
  }
  if (!Array.isArray(trivial.never) || !trivial.never.every(filled)) add('trivial.never', 'trivial', 'The "never trivial" paths must be a list of globs.');

  for (const policy of Array.isArray(config.policies) ? config.policies : []) {
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
  const webhooks = Array.isArray(delivery.webhooks) ? delivery.webhooks : [];
  for (const hook of webhooks) {
    if (!ENV_NAME.test(hook.env || '')) add(`delivery.webhooks[${hook.id}].env`, 'delivery', 'A webhook holds the name of the environment variable that has its URL.');
  }
  if (hasUrl(delivery.webhooks)) add('delivery.webhooks', 'delivery', 'A webhook URL is in the configuration. Keep the URL in an environment variable and store only its name.');

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
  return problems;
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

module.exports = { SUPPORTED_FORMAT, APPROVAL_KEYS, STAGE_KEYS, commandFor, validateConfig, validateBase, compareVersions, checkReadable };
