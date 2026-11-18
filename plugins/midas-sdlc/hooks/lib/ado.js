'use strict';
// Azure DevOps call classifier: a read, or an AdoCall the item and PR rules (tasks 14, 15) judge.
const answers = require('./answers');
const gates = require('./gates');
const ledgerLib = require('./ledger');

// Read (tool, action) pairs from the ADO facts; null = the tool has no action parameter. Same as guard.FALLBACK.ADO_READS.
const READS = {
  advsec_get_alert_details: null, advsec_get_alerts: null, core_get_identity_ids: null, core_list_project_teams: null,
  core_list_projects: null, pipelines_artifact: ['list', 'download'], pipelines_build: ['list', 'get_status', 'get_changes'],
  pipelines_build_log: ['list', 'get_content'], pipelines_definition: ['list', 'list_revisions'], pipelines_run: ['get', 'list'],
  repo_branch: ['get', 'list', 'list_mine'], repo_file: ['get_content', 'list_directory'],
  repo_pull_request: ['get', 'list', 'list_by_commits'], repo_pull_request_org: null,
  repo_pull_request_thread: ['list', 'list_comments'], repo_repository: ['get', 'list'], repo_search_commits: null,
  search_code: null, search_wiki: null, search_workitem: null, testplan: ['list_plans', 'list_suites', 'list_cases'],
  testplan_show_test_results_from_build_id: null,
  wiki: ['list_wikis', 'get_wiki', 'list_pages', 'get_page', 'get_page_content'], wit_backlog: ['list', 'list_work_items'],
  wit_query: ['get', 'get_results', 'wiql'],
  wit_work_item: ['get', 'get_batch', 'list_comments', 'my', 'list_revisions', 'list_for_iteration', 'get_type'],
  wit_work_item_attachment: null,
  work: ['list_iterations', 'list_team_iterations', 'get_team_settings', 'get_team_capacity', 'get_iteration_capacities'],
};
const WRITE_ACTIONS = {
  pipelines_write: ['run_pipeline', 'create_pipeline', 'rename_pipeline', 'update_build_stage'], repo_create_branch: null,
  repo_file_write: ['create', 'update'], repo_pull_request_thread_write: ['create', 'reply', 'update', 'update_status'],
  repo_pull_request_write: ['create', 'update', 'update_reviewers', 'vote'], testplan_test_case_write: ['create', 'update_steps'],
  testplan_test_plan_write: ['create'], testplan_test_suite_write: ['create', 'add_test_cases'], wiki_upsert_page: null,
  wit_backlog: ['reorder'], wit_work_item_attachment_link: null, wit_work_item_attachment_upload: null,
  wit_work_item_comment_write: ['add', 'update'], wit_work_item_link_write: ['link', 'unlink', 'link_to_pull_request', 'add_artifact_link'],
  wit_work_item_write: ['create', 'update', 'update_batch', 'add_child'], work_capacity_write: ['update'], work_iteration_write: ['create', 'assign'],
};
const BLOCKED = new Set(['wiki_upsert_page', 'work_capacity_write', 'work_iteration_write', 'repo_create_branch', 'repo_file_write', 'testplan_test_plan_write', 'testplan_test_suite_write']);

// Guard design, Constants (build check 16). Keys are Azure DevOps repository names.
const REPO_IDS = {
  BigChange: '1fc9a900-b3cf-4d25-a849-b69c0879a860',
  'BigChange.JobFinance': '37b53924-b4e3-47cd-9244-76a39a19b259',
  'BigChange.Xero': 'bd877eb4-5e6a-4bab-b57c-7703558a0d9d',
  'BigChange.MFE.Suite': '781963ca-4b97-499b-bbef-3e3d9b126680',
  'BigChange.ExportCsv': '48c808b7-98dc-4150-96fd-3c965117d1bc',
  'BigChange.BatchDataProcess': '6441bcfa-58c2-4171-b4fc-1fb74159fa2e',
  'BigChange.BO.RestApi': 'a03de750-a0e5-4b54-bfb9-6ba34b1a2167',
  'BigChange.Database': 'e3274a22-f709-45af-a46f-aa7e21008b18',
  'BigChange.Sage50': '434e7aa2-2eb8-4d70-af8f-5bdfef37cda7',
};
const TRUNKS = {
  BigChange: 'WebRelease2', 'BigChange.JobFinance': 'main', 'BigChange.Xero': 'main', 'BigChange.MFE.Suite': 'main', 'BigChange.ExportCsv': 'main',
  'BigChange.BatchDataProcess': 'main', 'BigChange.BO.RestApi': 'main', 'BigChange.Database': 'main', 'BigChange.Sage50': 'legacy',
};
const DATABASE_REPO_ID = REPO_IDS['BigChange.Database'];
const COLUMN_FIELDS = [/^system\.boardcolumn$/i, /^system\.boardcolumndone$/i, /^wef_[0-9a-f]{32}_kanban\.column$/i, /^wef_[0-9a-f]{32}_kanban\.column\.done$/i];
const TESTED_BY_FIELD = 'Custom.TestedBy';

const PREFIX = /^mcp__(plugin_agentic-midas_)?azure-devops__(.*)$/;
const has = (o, k) => Object.hasOwn(o, k);
const listHas = (o, tool, op) => has(o, tool) && (o[tool] === null || o[tool].includes(op));
const goodId = (v) => Number.isInteger(Number(v)) && Number(v) > 0;

// The REPO_IDS key a repositoryId names (by name or GUID, any case), or null.
function repoName(r) {
  const l = String(r).toLowerCase();
  return Object.keys(REPO_IDS).find((k) => k.toLowerCase() === l || REPO_IDS[k].toLowerCase() === l) ?? null;
}

// Sorted dotted leaf paths; arrays, nulls and empty objects are leaves.
function leafKeys(o, pre = '', out = []) {
  for (const [k, v] of Object.entries(o)) {
    const p = pre + k;
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) leafKeys(v, p + '.', out); else out.push(p);
  }
  return pre ? out : out.sort();
}

function classify(toolName, toolInput) {
  const ti = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const m = PREFIX.exec(String(toolName));
  const server = m && m[1] ? 2 : 1;
  const tool = m ? m[2] : String(toolName);
  const action = ti.action == null ? undefined : String(ti.action).toLowerCase();
  const nullList = READS[tool] === null && has(READS, tool) || WRITE_ACTIONS[tool] === null && has(WRITE_ACTIONS, tool);
  const op = nullList ? tool : action ?? tool;
  const local = ti.savePath !== undefined || ti.destinationPath !== undefined;
  if ((listHas(READS, tool, op) && !local) || (tool === 'pipelines_write' && op === 'run_pipeline' && ti.previewRun === true)) return { read: true };

  // cls, raw ids and whether pr/repo apply, per the Fields table.
  let cls = 'item', raw = [], refs = false;
  const wi = tool === 'wit_work_item_write';
  if (wi) {
    if (op === 'create') cls = 'create';
    else if (op === 'update') raw = [ti.id];
    else if (op === 'update_batch') raw = (Array.isArray(ti.batchUpdates) ? ti.batchUpdates : []).map((u) => u && u.id);
    else if (op === 'add_child') raw = [ti.parentId];
  } else if (tool === 'wit_work_item_comment_write') { cls = 'comments'; raw = [ti.workItemId]; }
  else if (tool === 'wit_work_item_link_write') {
    cls = 'link';
    if (op === 'link') raw = (Array.isArray(ti.updates) ? ti.updates : []).flatMap((u) => (u ? [u.id, u.linkToId] : []));
    else if (op === 'unlink') raw = [ti.id];
    else if (op === 'link_to_pull_request' || op === 'add_artifact_link') { raw = [ti.workItemId]; refs = true; }
  } else if (tool === 'wit_work_item_attachment_link') raw = [ti.workItemId];
  else if (tool === 'testplan_test_case_write') { cls = 'testcase'; raw = [op === 'update_steps' ? ti.id : ti.testsWorkItemId]; }
  else if (tool === 'repo_pull_request_write') {
    refs = true;
    if (op === 'create') {
      cls = 'pr';
      if (ti.workItems != null) raw = (Array.isArray(ti.workItems) ? ti.workItems.join(' ') : String(ti.workItems)).split(/[\s,]+/).filter(Boolean);
    } else cls = op === 'vote' ? 'vote' : op === 'update' && ti.autoComplete === true ? 'merge' : 'pr';
  } else if (tool === 'repo_pull_request_thread_write') { cls = 'thread'; refs = true; }
  else if (tool === 'pipelines_write') cls = 'pipeline';
  raw = raw.filter((v) => v !== undefined);
  const ids = [...new Set(raw.map(Number))];

  // Patch fields: wit_work_item_write only (a link write's updates[] holds links, not patches).
  const paths = [], fields = [], states = [], columns = [], seen = new Set();
  let dupField = false, badPatch = false;
  if (wi) {
    const entries = [];
    for (const u of Array.isArray(ti.updates) ? ti.updates : []) entries.push([ti.id, u]);
    for (const u of Array.isArray(ti.batchUpdates) ? ti.batchUpdates : []) entries.push([u && u.id, u]);
    if (op === 'create') for (const f of Array.isArray(ti.fields) ? ti.fields : []) entries.push(['new', { path: '/fields/' + (f && f.name), value: f && f.value }]);
    for (const [id, u] of entries) {
      const e = u && typeof u === 'object' ? u : {};
      const p = String(e.path ?? '').toLowerCase(), eop = String(e.op ?? 'add').toLowerCase();
      paths.push(p);
      const f = /^\/fields\/([^/]+)$/.exec(p);
      // a reference name never has surrounding whitespace; a padded one would dodge the state and column checks
      if (!((p === '/rev' && eop === 'test') || (f && f[1].includes('.') && f[1] === f[1].trim() && ['add', 'replace', 'remove', 'test'].includes(eop)))) badPatch = true;
      if (!f || eop === 'test') continue;
      const name = f[1], value = eop === 'remove' ? '' : String(e.value);
      fields.push(name);
      if (name === 'system.state') states.push(value);
      if (COLUMN_FIELDS.some((r) => r.test(name))) columns.push(value);
      const key = `${Number(id)}|${name}`;
      if (seen.has(key)) dupField = true;
      seen.add(key);
    }
  }

  const flags = { keys: leafKeys(ti) };
  if (cls === 'create') {
    const area = (Array.isArray(ti.fields) ? ti.fields : []).find((f) => f && String(f.name).toLowerCase() === 'system.areapath');
    Object.assign(flags, { workItemType: ti.workItemType, areaPath: area ? area.value : null });
  }
  if (tool === 'wit_work_item_attachment_upload') flags.fileName = ti.fileName;
  if (tool === 'wit_work_item_attachment_link') flags.attachmentUrl = ti.attachmentUrl;
  if (tool === 'repo_pull_request_write' && op === 'create') {
    Object.assign(flags, { isDraft: ti.isDraft ?? false, sourceRefName: ti.sourceRefName, targetRefName: ti.targetRefName, title: ti.title, description: ti.description });
  }
  if (tool === 'repo_pull_request_write' && op === 'update') {
    Object.assign(flags, { isDraft: ti.isDraft ?? (server === 2 ? false : null), title: ti.title, description: ti.description, status: ti.status, autoComplete: ti.autoComplete });
  }
  if (cls === 'merge') {
    Object.assign(flags, { mergeStrategy: ti.mergeStrategy, deleteSourceBranch: ti.deleteSourceBranch ?? false, transitionWorkItems: ti.transitionWorkItems ?? true, bypassPolicy: ti.bypassPolicy ?? false });
  }
  if (tool === 'repo_pull_request_write' && op === 'update_reviewers') flags.reviewerAction = ti.reviewerAction;
  if (cls === 'vote') flags.vote = ti.vote;
  if (cls === 'thread') Object.assign(flags, { threadId: ti.threadId, status: ti.status });
  if (cls === 'link') flags.linkType = ti.type ?? ti.linkType;
  if (cls === 'pipeline') {
    const self = ti.resources && ti.resources.repositories && ti.resources.repositories.self;
    Object.assign(flags, { refName: (self && self.refName) ?? null, previewRun: ti.previewRun });
  }
  if (cls === 'testcase') flags.testsWorkItemId = ti.testsWorkItemId;

  const known = has(READS, tool) || has(WRITE_ACTIONS, tool);
  const pr1 = tool === 'repo_pull_request_write';
  const always = [
    [!known, 'unknown tool'],
    [!listHas(READS, tool, op) && !listHas(WRITE_ACTIONS, tool, op), 'unknown action'],
    [server === 2, 'server-2 write'],
    [[...raw, ti.pullRequestId, ti.pipelineId].some((v) => v !== undefined && !goodId(v)), 'bad id'],
    [BLOCKED.has(tool), 'blocked tool'],
    [tool === 'pipelines_write' && ['create_pipeline', 'rename_pipeline', 'update_build_stage'].includes(op), 'pipeline change'],
    [wi && op === 'add_child', 'add_child'],
    [tool === 'wit_backlog' && op === 'reorder', 'backlog reorder'],
    [local, 'local download'],
    [pr1 && ti.bypassPolicy === true, 'bypassPolicy'],
    [pr1 && ti.status != null && String(ti.status).toLowerCase() === 'abandoned', 'abandon'],
    [pr1 && ti.autoComplete === false, 'cancel auto-complete'],
    [badPatch, 'patch path'], // a create fields[].name without a dot fails the '/fields/<name>' check
  ].find(([hit]) => hit)?.[1];

  const call = { read: false, server, cls, op };
  if (always) call.always = always;
  call.ids = ids;
  if (refs && ti.pullRequestId !== undefined) call.pr = Number(ti.pullRequestId);
  if (refs && ti.repositoryId !== undefined) call.repo = repoName(ti.repositoryId) ?? ti.repositoryId;
  if (cls === 'pipeline' && ti.pipelineId !== undefined) call.pipeline = Number(ti.pipelineId);
  return Object.assign(call, { states, columns, fields, paths, dupField, flags });
}

// Item side of the ADO policy (task 14). PR, vote, thread, merge, pipeline and PR-link calls follow the PR side below (task 15).
const FIELD_GATES = ['G1', 'G2', 'G12'];
const FORBIDDEN = ['testing', 'approved', 'closing', 'done', 'closed', 'removed'];
const CLOSE_STATES = ['closed', 'removed'], CLOSE_COLUMNS = ['done'];
const MIDAS_AREA = 'bigchange\\finance\\midas';
const lc = (v) => String(v).trim().toLowerCase();
const inList = (list, v) => list.some((x) => lc(x) === lc(v));
const isColumn = (name) => COLUMN_FIELDS.some((r) => r.test(name));
const BY_HAND = 'nothing; the developer does this by hand in Azure DevOps';

// The approval a deny names (C11: an item update's form comes from the most specific thing it sets).
function formFor(call, ti, arm) {
  const target = arm && arm.target ? arm.target.id : undefined;
  if (call.cls === 'testcase') return `Accept G9b ${ti.testsWorkItemId ?? target ?? '<id>'}`; // update_steps' id is the case, not the item
  const id = call.ids[0] ?? target ?? '<id>';
  if (call.cls === 'comments') return `Approve: comment ${id}`;
  if (call.cls === 'create') return lc(call.flags.workItemType) === 'change request' ? `Accept G12 ${id}` : 'Approve: create item';
  if (call.fields.includes(lc(TESTED_BY_FIELD))) return `Tested ${id}, after Take ${id}`;
  if (call.columns.some((c) => lc(c) === 'testing')) return `Take ${id}`;
  if (call.states.some((s) => inList(CLOSE_STATES, s)) || call.columns.some((c) => inList(CLOSE_COLUMNS, c))) {
    return `Accept G13 ${id}, after a G10 accept or typed G10 skip that follows the latest push or deploy`;
  }
  return `Approve: update ${id}, or the stage's Accept G<n> ${id}`;
}

// The reason an armed item-side call fails, or null when it passes.
function itemRule(call, ti, arm, ctx, tool) {
  const T = (arm.target || {}).id, has = (c) => arm.classes.includes(c);
  const m = gates.itemMoves(arm);
  const edits = has('item') && (m.any || FIELD_GATES.includes(arm.gate));
  const isT = (v) => T !== undefined && v !== undefined && v !== null && Number(v) === T;
  const named = (f) => T !== undefined && typeof f === 'string' && f.startsWith(`${T}-`);

  if (tool === 'wit_work_item_write' && (call.op === 'update' || call.op === 'update_batch')) {
    if (!call.ids.length || !call.ids.every(isT)) return `the update touches an item other than ${T ?? 'the armed item'}`;
    if (call.dupField) return 'the update sets one field twice';
    if (!has('item') && !has('take') && !has('tested')) return 'no item, take or tested arm';
    for (const s of call.states) {
      const r = inList(CLOSE_STATES, s) ? closeRule(arm, ctx, T) : inList(m.states, s) || (m.any && !inList(FORBIDDEN, s)) ? null : `state ${s} is not allowed by this answer`;
      if (r) return r;
    }
    for (const c of call.columns) {
      const r = inList(CLOSE_COLUMNS, c) ? closeRule(arm, ctx, T) : inList(m.columns, c) || (m.any && !inList(FORBIDDEN, c)) ? null : `column ${c} is not allowed by this answer`;
      if (r) return r;
    }
    for (const f of call.fields) {
      if (f === 'system.state' || isColumn(f)) continue;
      if (f === lc(TESTED_BY_FIELD)) { if (!has('tested')) return 'Tested By needs Tested after an open Take'; }
      else if (f === 'system.assignedto') { if (!m.assign && !edits) return 'this answer does not assign the item'; }
      else if (!edits) return `this answer does not edit field ${f}`;
    }
    return null;
  }
  if (tool === 'wit_work_item_attachment_upload') {
    if (!edits && !has('tested')) return 'no edit or tested arm';
    return named(ti.fileName) ? null : `the fileName must start with ${T ?? '<id>'}-`;
  }
  if (tool === 'wit_work_item_attachment_link') {
    if (!edits && !has('tested')) return 'no edit or tested arm';
    if (!isT(ti.workItemId)) return `the link is not on ${T ?? 'the armed item'}`;
    let f = null;
    try { f = new URL(String(ti.attachmentUrl)).searchParams.get('fileName'); } catch { /* bad URL denies below */ }
    return named(f) ? null : `the attachmentUrl fileName must start with ${T ?? '<id>'}-`;
  }
  if (call.cls === 'comments') {
    if (!has('comments') && !has('tested')) return 'no comment arm';
    return call.ids.length === 1 && isT(call.ids[0]) ? null : `the comment is not on ${T ?? 'the armed item'}`;
  }
  if (call.cls === 'create') {
    if (!has('create')) return 'no create arm';
    if (arm.created && arm.created.item && arm.created.item.length) return 'one item is already created in this message';
    if (call.flags.areaPath == null || lc(call.flags.areaPath) !== MIDAS_AREA) return 'the area path must be BigChange\\Finance\\Midas';
    if (call.states.some((s) => inList(FORBIDDEN, s))) return 'a new item cannot start in that state';
    if (call.fields.includes(lc(TESTED_BY_FIELD))) return 'a new item cannot set Tested By';
    if (arm.gate === 'G12' && lc(call.flags.workItemType) !== 'change request') return 'G12 creates a Change Request only';
    return null;
  }
  if (call.cls === 'link' && call.op === 'link') {
    const ups = Array.isArray(ti.updates) ? ti.updates : [];
    const created = (arm.created && arm.created.item) || [];
    const ok = (u) => u && u.linkToId !== undefined && u.linkToId !== null &&
      ((edits && (isT(u.id) || isT(u.linkToId))) || (has('create') && [u.id, u.linkToId].some((v) => Number(v) > 0 && created.includes(Number(v)))));
    return ups.length && ups.every(ok) ? null : 'each link needs one end on the armed or created item';
  }
  if (call.cls === 'link' && call.op === 'unlink') return edits && isT(ti.id) ? null : `unlink needs an edit arm on ${T ?? 'the item'}`;
  if (call.cls === 'testcase' && call.op === 'create') return has('testcase') && isT(ti.testsWorkItemId) ? null : `test cases need G9b on ${ti.testsWorkItemId ?? 'the item'}`;
  if (call.cls === 'testcase' && call.op === 'update_steps') {
    const created = (arm.created && arm.created.testcase) || [];
    return has('testcase') && created.includes(Number(ti.id)) ? null : 'steps change only on test cases created in this message';
  }
  return 'no rule allows this call';
}

function closeRule(arm, ctx, T) {
  if (!arm.classes.includes('close')) return 'closing needs G13';
  let r;
  try { r = ledgerLib.closeAllowed(ctx.ledger(), T); } catch { return 'the gate record could not be read'; }
  return r.ok ? null : r.why;
}

// PR side (task 15): the PR-side (cls, op, target) pairs each answer allows. tests/matrix.test.js checks it by hand.
const ALLOWED = {
  G8: [{ cls: 'pr', op: 'create', target: 'id' }, { cls: 'link', op: 'pr', target: 'created.pr' }],
  'G8b-id': [{ cls: 'pr', op: 'publish', target: 'prsFor(id)' }, { cls: 'pr', op: 'reviewers', target: 'prsFor(id)' }],
  'G8b-pr': [{ cls: 'pr', op: 'publish', target: 'pr' }, { cls: 'pr', op: 'reviewers', target: 'pr' }],
  review: [{ cls: 'thread', op: 'create', target: 'pr' }, { cls: 'thread', op: 'reply', target: 'pr' },
    { cls: 'thread', op: 'status', target: 'pr' }, { cls: 'vote', op: 'vote', target: 'pr' }],
  reply: [{ cls: 'thread', op: 'reply', target: 'pr' }, { cls: 'thread', op: 'status', target: 'pr' }, { cls: 'pr', op: 'edit', target: 'pr' }],
  G11: [{ cls: 'merge', op: 'complete', target: 'pr' }],
};
const FIXES = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s*:?\s*#\d+/i;
const UNCHANGED = ['action', 'repositoryId', 'pullRequestId', 'project'];
const MERGE_KEYS = [...UNCHANGED, 'autoComplete', 'mergeStrategy', 'deleteSourceBranch', 'transitionWorkItems'];
const PIPELINE_KEYS = ['action', 'project', 'pipelineId', 'resources.repositories.self.refName'];
const THREAD_OPS = { create: 'create', reply: 'reply', update_status: 'status' };
const isDatabase = (name) => name !== null && REPO_IDS[name].toLowerCase() === DATABASE_REPO_ID.toLowerCase();

function armKey(arm) {
  if (!arm.classes.length) return null; // C1: Refuse, Skip, Pause and Accept G11 <id> keep the gate but arm nothing
  const t = arm.target || {};
  if (arm.gate === 'G8') return 'G8';
  if (arm.gate === 'G8b') return t.pr !== undefined ? 'G8b-pr' : 'G8b-id';
  if (arm.gate === 'G11') return t.pr !== undefined ? 'G11' : null;
  const a = answers.parseAnswer(arm.answer);
  return a && a.kind === 'approve' && (a.verb === 'review' || a.verb === 'reply') ? a.verb : null;
}

function pairOf(tool, ti) {
  const op = String(ti.action).toLowerCase();
  if (tool === 'repo_pull_request_write') {
    if (op === 'create') return { cls: 'pr', op: 'create' };
    if (op === 'update_reviewers') return { cls: 'pr', op: 'reviewers' };
    if (op === 'vote') return { cls: 'vote', op: 'vote' };
    if (op !== 'update') return null;
    const changed = Object.keys(ti).filter((k) => !UNCHANGED.includes(k));
    if (changed.length === 1 && changed[0] === 'isDraft' && ti.isDraft === false) return { cls: 'pr', op: 'publish' };
    if (changed.length && changed.every((k) => k === 'title' || k === 'description')) return { cls: 'pr', op: 'edit' };
    if (ti.autoComplete === true) return { cls: 'merge', op: 'complete' };
    return null;
  }
  if (tool === 'repo_pull_request_thread_write') return Object.hasOwn(THREAD_OPS, op) ? { cls: 'thread', op: THREAD_OPS[op] } : null;
  if (tool === 'wit_work_item_link_write' && op === 'link_to_pull_request') return { cls: 'link', op: 'pr' };
  return null;
}

// The approval a PR-side or pipeline deny names, armed or not.
function prForm(call, pair, ti, arm) {
  const id = call.ids[0] ?? (arm && arm.target ? arm.target.id : undefined) ?? '<id>';
  const n = call.pr ?? '<n>', k = pair ? `${pair.cls} ${pair.op}` : '';
  if (call.cls === 'pipeline') return `Accept G9 ${id} or Approve: pipeline ${call.pipeline ?? '<id>'}`;
  if (k === 'pr create' || k === 'link pr') return `Accept G8 ${id}`;
  if (k === 'pr publish' || k === 'pr reviewers') return `Accept G8b ${id} or Accept G8b PR${n}`;
  if (k === 'vote vote' || k === 'thread create') return `Approve: review PR${n}`;
  if (k === 'thread reply' || k === 'thread status') return `Approve: review PR${n} or Approve: reply PR${n}`;
  if (k === 'pr edit') return `Approve: reply PR${n}`;
  if (k === 'merge complete') return isDatabase(repoName(ti.repositoryId)) ? 'nothing; a DBA completes Database PRs' : `Accept G11 PR${n}`;
  return "nothing; this PR change isn't one the harness allows";
}

// The reason an armed PR-side call fails, or null when it passes.
function prRule(call, pair, ti, arm, ctx) {
  const key = armKey(arm);
  if (!key) return 'this answer arms no PR change';
  if (!pair) return 'the harness allows no such PR change';
  const entry = ALLOWED[key].find((e) => e.cls === pair.cls && e.op === pair.op);
  if (!entry) return `this answer does not allow ${pair.cls} ${pair.op}`;
  const t = arm.target || {}, pr = call.pr ?? Number(ti.pullRequestId);
  let onTarget = true;
  if (entry.target === 'pr') onTarget = pr === t.pr;
  else if (entry.target === 'created.pr') onTarget = ((arm.created && arm.created.pr) || []).includes(pr) && Number(ti.workItemId) === t.id;
  else if (entry.target === 'prsFor(id)') {
    try { onTarget = ledgerLib.prsFor(ctx.ledger(), t.id).includes(pr); } catch { return 'the gate record could not be read'; }
  }
  if (!onTarget) return `PR${Number.isNaN(pr) ? '' : pr} is not one this answer names`;

  const fixes = [ti.title, ti.description].some((v) => v != null && FIXES.test(String(v)));
  if (pair.cls === 'pr' && pair.op === 'create') {
    const src = String(ti.sourceRefName ?? ''), tgt = String(ti.targetRefName ?? ''), name = repoName(ti.repositoryId);
    if (ti.isDraft !== true) return 'the PR must open as a draft';
    if (!src.startsWith('refs/heads/') || !new RegExp(`(^|/)${t.id}(-|$)`).test(src.slice('refs/heads/'.length))) return `the source branch must name ${t.id}`;
    if (!call.ids.includes(t.id)) return `the work items must include ${t.id}`;
    if (name === null) return 'the repository is not one the harness knows';
    if (tgt !== `refs/heads/${TRUNKS[name]}` && !/^refs\/heads\/release\//i.test(tgt)) return `the target must be ${TRUNKS[name]} or release/*`;
  }
  if ((pair.op === 'create' && pair.cls === 'pr') || pair.op === 'edit') {
    if (fixes) return 'a Fixes, Closes or Resolves #n link would close an item on merge';
  }
  if (pair.op === 'complete') {
    const name = repoName(ti.repositoryId);
    if (Object.keys(ti).some((k) => !MERGE_KEYS.includes(k))) return 'a completion sets only autoComplete, mergeStrategy, deleteSourceBranch and transitionWorkItems';
    if (String(ti.mergeStrategy).toLowerCase() !== 'squash' || ti.deleteSourceBranch !== true || ti.transitionWorkItems !== false) {
      return 'a completion must squash, delete the source branch and leave work items alone';
    }
    if (name === null) return 'the repository is not one the harness knows';
    if (isDatabase(name)) return 'a DBA completes Database PRs';
  }
  return null;
}

// The reason an armed pipeline run fails, or null when it passes.
function pipelineRule(call, arm) {
  if (!arm.classes.includes('pipeline')) return 'no pipeline arm';
  const p = call.pipeline, g9 = gates.G9_PIPELINES.includes(p);
  if (arm.gate === 'G9' ? !g9 : p !== (arm.target || {}).pipeline) return `pipeline ${p} is not one this answer runs`;
  if (g9 && String(call.flags.refName).toLowerCase() !== 'refs/heads/midas/dev') return `pipeline ${p} runs on midas/dev only`;
  if (call.flags.keys.some((k) => !PIPELINE_KEYS.includes(k))) return 'a run sets only project, pipelineId and the self refName';
  return null;
}

function check(input, ctx) {
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const call = classify(input.tool_name, ti);
  if (call.read) return null;
  const tool = String(input.tool_name).replace(PREFIX, '$2');
  const action = `${tool}${call.op === tool ? '' : ` ${call.op}`}${call.ids.length ? ` on ${call.ids.join(', ')}` : ''}`;
  if (call.always) return answers.needs(action, `${call.always} is always blocked`, BY_HAND);
  if (ctx.subagent) return answers.needs(action, 'a subagent never writes to Azure DevOps', "the main session, after the developer's answer");
  const arm = ctx.arm();
  if (['pr', 'vote', 'thread', 'merge', 'pipeline'].includes(call.cls) || (call.cls === 'link' && call.op !== 'link' && call.op !== 'unlink')) {
    const pair = call.cls === 'pipeline' ? null : pairOf(tool, ti);
    const form = prForm(call, pair, ti, arm);
    if (!arm) return answers.needs(action, 'no answer in this message arms it', form);
    const r = call.cls === 'pipeline' ? pipelineRule(call, arm) : prRule(call, pair, ti, arm, ctx);
    return r ? answers.needs(action, r, form) : null;
  }
  if (!arm) return answers.needs(action, 'no answer in this message arms it', formFor(call, ti, null));
  const rule = itemRule(call, ti, arm, ctx, tool);
  return rule ? answers.needs(action, rule, formFor(call, ti, arm)) : null;
}

module.exports = { READS, ALLOWED, classify, check, DATABASE_REPO_ID, REPO_IDS, TRUNKS, COLUMN_FIELDS, TESTED_BY_FIELD };
