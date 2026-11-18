'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), path = require('node:path');
const ado = require('../hooks/lib/ado');
const facts = require('../../../docs/research/2026-11-11-harness-facts/ado.json');
const S1 = 'mcp__azure-devops__', S2 = 'mcp__plugin_agentic-midas_azure-devops__';
const WEF = 'WEF_36778208447642C48B0A0F72C104A5C5';
const FX = path.join(__dirname, 'fixtures', 'inputs');
const get = (o, k) => k.split('.').reduce((v, p) => (v == null ? v : v[p]), o);

test('T22 READS is the read list in ado.json', () => {
  const want = {};
  for (const t of facts.write_tools) {
    if (!t.on_servers.includes('azure-devops') || t.read_actions.length === 0) continue;
    if (t.action_param.startsWith('action')) want[t.tool] = t.read_actions; else if (t.write_actions.length === 0) want[t.tool] = null;
  }
  assert.deepStrictEqual(ado.READS, want);
});

const BLOCKED = new Set(['wiki_upsert_page', 'work_capacity_write', 'work_iteration_write', 'repo_create_branch', 'repo_file_write', 'testplan_test_plan_write', 'testplan_test_suite_write']);
const CLS = { wit_work_item_write: 'item', wit_work_item_comment_write: 'comments', wit_work_item_link_write: 'link', testplan_test_case_write: 'testcase', repo_pull_request_write: 'pr', repo_pull_request_thread_write: 'thread', pipelines_write: 'pipeline' };
const ALWAYS1 = { 'pipelines_write create_pipeline': 'pipeline change', 'pipelines_write rename_pipeline': 'pipeline change', 'pipelines_write update_build_stage': 'pipeline change', 'wit_work_item_write add_child': 'add_child', 'wit_backlog reorder': 'backlog reorder' };
for (const t of facts.write_tools.filter(t => t.on_servers.includes('azure-devops'))) {
  const acts = t.action_param.startsWith('action');
  for (const [prefix, server] of [[S1, 1], [S2, 2]]) {
    for (const a of acts ? t.read_actions : (t.write_actions.length ? [] : [null]))
      test(`T22 ${prefix}${t.tool} ${a ?? ''} is a read`, () => assert.deepStrictEqual(ado.classify(prefix + t.tool, a ? { action: a } : {}), { read: true }));
    for (const a of acts ? t.write_actions : (t.write_actions.length ? [null] : []))
      test(`T86 ${prefix}${t.tool} ${a ?? ''} is outward`, () => {
        const c = ado.classify(prefix + t.tool, a ? { action: a } : {});
        const cls = t.tool === 'repo_pull_request_write' && a === 'vote' ? 'vote' : t.tool === 'wit_work_item_write' && a === 'create' ? 'create' : CLS[t.tool] ?? 'item';
        assert.deepStrictEqual([c.read, c.server, c.op, c.cls], [false, server, a ?? t.tool, cls]);
        assert.equal(c.always, server === 2 ? 'server-2 write' : BLOCKED.has(t.tool) ? 'blocked tool' : ALWAYS1[a ? `${t.tool} ${a}` : t.tool]);
      });
  }
}

const ROWS = [ // [T id, fixture name, tool_name, tool_input, expected values by dotted key]
  ['T22', 'ado-item-string-id', S1 + 'wit_work_item_write', { action: 'Update', id: '999999001', updates: [{ op: 'Test', path: '/Rev', value: 3 }, { op: 'Replace', path: '/Fields/System.State', value: 'Active' }] },
    { cls: 'item', op: 'update', ids: [999999001], paths: ['/rev', '/fields/system.state'], fields: ['system.state'], states: ['Active'], columns: [], dupField: false, always: undefined }],
  ['T22', 'ado-item-batch', S1 + 'wit_work_item_write', { action: 'update_batch', batchUpdates: [{ id: 999999001, op: 'Add', path: '/fields/System.Title', value: 'a' }, { id: '999999002', op: 'Replace', path: '/fields/System.State', value: 'Approval' }, { id: 999999001, path: '/fields/Custom.Release#', value: '26.11.02' }] },
    { ids: [999999001, 999999002], states: ['Approval'], dupField: false, always: undefined }],
  ['T22', 'ado-item-field-twice', S1 + 'wit_work_item_write', { action: 'update', id: 999999001, updates: [{ path: '/fields/System.Title', value: 'a' }, { op: 'replace', path: '/fields/system.title', value: 'b' }] }, { dupField: true, always: undefined }],
  ['T22', 'ado-item-friendly-field', S1 + 'wit_work_item_write', { action: 'update', id: 999999001, updates: [{ path: '/fields/State', value: 'Closed' }] }, { always: 'patch path' }],
  ['T22', 'ado-create-friendly-field', S1 + 'wit_work_item_write', { action: 'create', workItemType: 'Bug', fields: [{ name: 'Title', value: 'x' }] }, { cls: 'create', always: 'patch path' }],
  ['T22', 'ado-item-boardcolumn', S1 + 'wit_work_item_write', { action: 'update', id: 999999001, updates: [{ path: '/fields/System.BoardColumn', value: 'Testing' }] }, { columns: ['Testing'], states: [] }],
  ['T22', 'ado-item-boardcolumndone', S1 + 'wit_work_item_write', { action: 'update', id: 999999001, updates: [{ path: '/fields/System.BoardColumnDone', value: true }] }, { columns: ['true'] }],
  ['T22', 'ado-item-kanban-column', S1 + 'wit_work_item_write', { action: 'update', id: 999999001, updates: [{ path: `/fields/${WEF}_Kanban.Column`, value: 'Ready for testing' }] }, { columns: ['Ready for testing'], states: [] }],
  ['T22', 'ado-item-kanban-column-done', S1 + 'wit_work_item_write', { action: 'update', id: 999999001, updates: [{ op: 'add', path: `/fields/${WEF.toLowerCase()}_kanban.column.done`, value: false }] }, { columns: ['false'] }],
  ['T22', 'ado-item-rev-replace', S1 + 'wit_work_item_write', { action: 'update', id: 999999001, updates: [{ op: 'replace', path: '/rev', value: 4 }] }, { always: 'patch path' }],
  ['T22', 'ado-item-relations', S1 + 'wit_work_item_write', { action: 'update', id: 999999001, updates: [{ op: 'add', path: '/relations/-', value: { rel: 'ArtifactLink', url: 'vstfs:///Git/PullRequestId/x%2Fy%2F999999090', attributes: { name: 'Pull Request' } } }] }, { cls: 'item', always: 'patch path' }],
  ['T22', 'ado-merge-defaults', S1 + 'repo_pull_request_write', { action: 'update', repositoryId: 'BigChange.JobFinance', project: 'BigChange', pullRequestId: 999999090, autoComplete: true, mergeStrategy: 'Squash' },
    { cls: 'merge', pr: 999999090, repo: 'BigChange.JobFinance', 'flags.transitionWorkItems': true, 'flags.deleteSourceBranch': false, 'flags.bypassPolicy': false, always: undefined }],
  ['T22', 'ado-pr-repo-name', S1 + 'repo_pull_request_write', { action: 'vote', repositoryId: 'bigchange.jobfinance', project: 'BigChange', pullRequestId: 999999090, vote: 'Approved' }, { cls: 'vote', repo: 'BigChange.JobFinance', 'flags.vote': 'Approved' }],
  ['T22', 'ado-pr-repo-guid', S1 + 'repo_pull_request_write', { action: 'vote', repositoryId: ado.REPO_IDS['BigChange.JobFinance'].toUpperCase(), pullRequestId: 999999090, vote: 'Approved' }, { repo: 'BigChange.JobFinance' }],
  ['T22', 'ado-pr-repo-unknown-guid', S1 + 'repo_pull_request_write', { action: 'vote', repositoryId: '00000000-0000-4000-8000-000000000000', pullRequestId: 999999090, vote: 'Approved' }, { repo: '00000000-0000-4000-8000-000000000000' }],
  ['T22', 'ado-pr-update-server1', S1 + 'repo_pull_request_write', { action: 'update', repositoryId: 'BigChange.JobFinance', project: 'BigChange', pullRequestId: 999999090, title: 'x' }, { server: 1, cls: 'pr', 'flags.isDraft': null, always: undefined }],
  ['T86', 'ado-pr-update-server2', S2 + 'repo_pull_request_write', { action: 'update', repositoryId: 'BigChange.JobFinance', project: 'BigChange', pullRequestId: 999999090, title: 'x' }, { server: 2, cls: 'pr', 'flags.isDraft': false, always: 'server-2 write' }],
  ['T22', 'ado-pr-abandon', S1 + 'repo_pull_request_write', { action: 'update', repositoryId: 'BigChange.JobFinance', project: 'BigChange', pullRequestId: 999999090, status: 'Abandoned' }, { cls: 'pr', 'flags.status': 'Abandoned', always: 'abandon' }],
  ['T22', 'ado-pr-cancel-autocomplete', S1 + 'repo_pull_request_write', { action: 'update', repositoryId: 'BigChange.JobFinance', project: 'BigChange', pullRequestId: 999999090, autoComplete: false }, { cls: 'pr', 'flags.autoComplete': false, always: 'cancel auto-complete' }],
  ['T22', 'ado-pr-create', S1 + 'repo_pull_request_write', { action: 'create', repositoryId: 'BigChange.JobFinance', project: 'BigChange', sourceRefName: 'refs/heads/feature/999999001-x', targetRefName: 'refs/heads/main', title: 'x', workItems: '999999001 999999002' },
    { cls: 'pr', op: 'create', ids: [999999001, 999999002], 'flags.isDraft': false, 'flags.sourceRefName': 'refs/heads/feature/999999001-x', 'flags.targetRefName': 'refs/heads/main' }],
  ['T22', 'ado-pr-create-array', S1 + 'repo_pull_request_write', { action: 'create', repositoryId: 'BigChange.JobFinance', project: 'BigChange', sourceRefName: 'refs/heads/feature/999999001-x', targetRefName: 'refs/heads/main', isDraft: true, title: 'x', workItems: ['999999001'] },
    { cls: 'pr', op: 'create', ids: [999999001], 'flags.isDraft': true, always: undefined }],
  ['T23', 'ado-pipeline-run', S1 + 'pipelines_write', { action: 'run_pipeline', project: 'BigChange', pipelineId: 429, resources: { repositories: { self: { refName: 'refs/heads/midas/dev' } } } },
    { cls: 'pipeline', pipeline: 429, 'flags.refName': 'refs/heads/midas/dev', 'flags.keys': ['action', 'pipelineId', 'project', 'resources.repositories.self.refName'], always: undefined }],
  ['T23', 'ado-pipeline-preview', S1 + 'pipelines_write', { action: 'run_pipeline', project: 'BigChange', pipelineId: 429, previewRun: true }, { read: true }],
  ['T23', 'ado-pipeline-preview-string', S1 + 'pipelines_write', { action: 'run_pipeline', project: 'BigChange', pipelineId: 429, previewRun: 'true' }, { read: false, cls: 'pipeline' }],
  ['T86', 'ado-attachment-savepath', S1 + 'wit_work_item_attachment', { attachmentId: 'a1', savePath: 'evidence.png' }, { read: false, always: 'local download' }],
  ['T86', 'ado-artifact-destination', S1 + 'pipelines_artifact', { action: 'download', project: 'BigChange', buildId: 1, artifactName: 'drop', destinationPath: 'out' }, { read: false, always: 'local download' }],
  ['T86', 'ado-backlog-reorder', S1 + 'wit_backlog', { action: 'reorder', project: 'BigChange', team: 'Midas', ids: [999999001] }, { read: false, always: 'backlog reorder' }],
  ['T86', 'ado-unknown-tool', S1 + 'repo_pull_request_complete', { pullRequestId: 999999090 }, { read: false, always: 'unknown tool' }],
  ['T86', 'ado-unknown-action', S1 + 'wit_work_item', { action: 'delete', id: 999999001 }, { read: false, always: 'unknown action' }],
  ['T22', 'ado-bad-id', S1 + 'wit_work_item_write', { action: 'update', id: '99999900x', updates: [] }, { always: 'bad id' }],
];
const CODE_ONLY = new Set(['ado-pr-repo-guid']); // holds a real repository GUID, so R49 keeps it out of fixtures/inputs
for (const [tid, file, tool_name, tool_input, want] of ROWS)
  test(`${tid} ${file}`, () => {
    const fx = CODE_ONLY.has(file) ? { tool_name, tool_input } : JSON.parse(fs.readFileSync(path.join(FX, file + '.json'), 'utf8'));
    assert.equal(fx.tool_name, tool_name);
    assert.deepStrictEqual(fx.tool_input, tool_input);
    const got = ado.classify(fx.tool_name, fx.tool_input);
    for (const [k, v] of Object.entries(want)) assert.deepStrictEqual(get(got, k), v, k);
  });

test('T22 TRUNKS, REPO_IDS and DATABASE_REPO_ID come from build check 16', () => {
  assert.deepStrictEqual(ado.TRUNKS, { BigChange: 'WebRelease2', 'BigChange.JobFinance': 'main', 'BigChange.Xero': 'main', 'BigChange.MFE.Suite': 'main', 'BigChange.ExportCsv': 'main', 'BigChange.BatchDataProcess': 'main', 'BigChange.BO.RestApi': 'main', 'BigChange.Database': 'main', 'BigChange.Sage50': 'legacy' }); // 'BigChange.Sage50' = task 5's "Sage50 repo name"; 'BigChange.ExportCsv' = task 5's recorded Azure DevOps name
  assert.deepStrictEqual(Object.keys(ado.REPO_IDS).sort(), Object.keys(ado.TRUNKS).sort());
  for (const g of Object.values(ado.REPO_IDS)) assert.match(g, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(ado.DATABASE_REPO_ID, ado.REPO_IDS['BigChange.Database']);
});
test('T22 COLUMN_FIELDS covers every board column field and nothing else; TESTED_BY_FIELD is a reference name', () => {
  const hit = f => ado.COLUMN_FIELDS.some(r => r.test(f));
  for (const f of ['System.BoardColumn', 'system.boardcolumndone', `${WEF}_Kanban.Column`, `${WEF.toLowerCase()}_kanban.column.done`]) assert.ok(hit(f), f);
  for (const f of ['System.State', 'System.BoardLane', `${WEF}_Kanban.Lane`, 'Custom.BoardColumn']) assert.ok(!hit(f), f);
  assert.equal(ado.TESTED_BY_FIELD, 'Custom.TestedBy');
});

const { spawnSync } = require('node:child_process');
const gates = require('../hooks/lib/gates');
const ledgerLib = require('../hooks/lib/ledger');
const rules = require('../hooks/lib/rules');
const { armOf, ctxOf, line, tempEnv } = require('./fixtures/arm');
// reuses task 13's top-level S1, fs and path; never redeclare task 13's names: test, assert, fs, path, ado, facts, S1, S2, WEF, FX, get, BLOCKED, CLS, ALWAYS1, ROWS, CODE_ONLY
const GUARD = path.join(__dirname, '..', 'hooks', 'guard.js');
const ID = 999999001, MATE = 999999002, MIDAS = 'BigChange\\Finance\\Midas';
const MIDAS_COL = 'WEF_36778208447642C48B0A0F72C104A5C5_Kanban.Column';
const DENY = /^midas-sdlc blocked .+\. Needs: .+\. Stop and ask the developer; do not try another way\.$/;
const pass = (input, arm, ledger = [], extra) => assert.strictEqual(ado.check(input, ctxOf(arm, ledger, extra)), null);
const deny = (input, arm, ledger = [], form) => {
  const r = ado.check(input, ctxOf(arm, ledger));
  assert.match(r, DENY);
  if (form) assert.ok(r.includes(form), r);
};
const set = (field, value) => ({ op: 'add', path: `/fields/${field}`, value });
const upd = (id, ...updates) => ({ tool_name: S1 + 'wit_work_item_write', tool_input: { action: 'update', id, updates } });
const create = (workItemType, area, extra = []) => ({ tool_name: S1 + 'wit_work_item_write', tool_input: { action: 'create', workItemType,
  fields: [{ name: 'System.Title', value: 'x' }, ...(area ? [{ name: 'System.AreaPath', value: area }] : []), ...extra] } });
const comment = (workItemId) => ({ tool_name: S1 + 'wit_work_item_comment_write', tool_input: { action: 'add', workItemId, text: 'x' } });
const upload = (fileName) => ({ tool_name: S1 + 'wit_work_item_attachment_upload', tool_input: { fileName, content: 'eA==' } });
const link = (id, linkToId) => ({ tool_name: S1 + 'wit_work_item_link_write', tool_input: { action: 'link', updates: [{ id, linkToId, type: 'related' }] } });
const tc = (tool_input) => ({ tool_name: S1 + 'testplan_test_case_write', tool_input });
const own = [line('accept', 'G8 999999001')];
const close = upd(ID, set('System.State', 'Closed'));
const g13 = (l) => armOf('Accept G13 999999001', l);

test('T22 an unarmed item update is denied and names Approve: update', () =>
  deny(upd(ID, set('System.Title', 'x')), null, [], 'Approve: update 999999001'));
test('T22 rules.decide sends both ADO prefixes to ado.check', () => {
  const base = { session_id: 's-test', prompt_id: 'p-test', cwd: 'C:/dev/Projects/BigChange', hook_event_name: 'PreToolUse' };
  for (const p of [S1, 'mcp__plugin_agentic-midas_azure-devops__'])
    assert.match(rules.decide({ ...base, ...upd(ID, set('System.Title', 'x')), tool_name: p + 'wit_work_item_write' }, tempEnv()), DENY);
  assert.strictEqual(rules.decide({ ...base, tool_name: S1 + 'wit_work_item', tool_input: { action: 'get', id: ID } }, tempEnv()), null);
});
test('T22 an armed call from a subagent is denied', () =>
  assert.match(ado.check(upd(ID, set('System.Title', 'x')), ctxOf(armOf('Accept G1 999999001'), [], { subagent: true })), DENY));
test('T3 Create it. allows one create in the Midas area only', () => {
  pass(create('Bug', MIDAS), armOf('Create it.'));
  deny(create('Bug', 'BigChange\\Finance'), armOf('Create it.'));
  deny(create('Bug', null), armOf('Create it.'));
  deny(create('Bug', MIDAS), armOf('Create it.', [], { item: [999999050] }), [], 'Approve: create item');
  deny(create('Bug', MIDAS, [{ name: 'System.State', value: 'Closed' }]), armOf('Create it.'));
  deny(create('Bug', MIDAS, [{ name: ado.TESTED_BY_FIELD, value: 'x' }]), armOf('Create it.'));
});
test('T3 G12 allows one Change Request and no other type', () => {
  pass(create('Change Request', MIDAS), armOf('Accept G12 999999001'));
  deny(create('Bug', MIDAS), armOf('Accept G12 999999001'));
});
test('T22 G1 edits fields on its own id, with no state or column change', () => {
  const a = armOf('Accept G1 999999001');
  pass(upd(ID, set('System.Title', 'x')), a);
  deny(upd(MATE, set('System.Title', 'x')), a);
  deny({ tool_name: S1 + 'wit_work_item_write', tool_input: { action: 'update_batch', batchUpdates: [
    { id: ID, op: 'Add', path: '/fields/System.Title', value: 'x' }, { id: MATE, op: 'Add', path: '/fields/System.Title', value: 'x' }] } }, a);
  deny(upd(ID, set('System.Title', 'x'), set('System.Title', 'y')), a);
  deny(upd(ID, set('System.State', 'Active')), a);
  deny(upd(ID, set('System.BoardColumn', 'Reviewing')), a);
  deny(upd(ID, set(MIDAS_COL, 'Reviewing')), a);
});
test('T22 G0, G4, G8b and G9b allow only their itemMoves', () => {
  for (const text of ['Accept G0 999999001', 'Accept G4 999999001', 'Accept G8b 999999001', 'Accept G9b 999999001']) {
    const a = armOf(text), m = gates.itemMoves(a);
    for (const s of m.states) pass(upd(ID, set('System.State', s)), a);
    for (const c of m.columns) pass(upd(ID, set(MIDAS_COL, c)), a);
    deny(upd(ID, set('System.State', 'Testing')), a);
    deny(upd(ID, set('System.Title', 'x')), a);
    (m.assign ? pass : deny)(upd(ID, set('System.AssignedTo', 'dev@example.com')), a);
  }
});
test('T22 Approve: update allows any state except Testing, Approved, Closing, Done, Closed and Removed', () => {
  const a = armOf('Approve: update 999999001');
  pass(upd(ID, set('System.State', 'Active'), set('System.Title', 'x')), a);
  for (const s of ['Testing', 'Approved', 'Closing', 'Done', 'Closed', 'Removed']) deny(upd(ID, set('System.State', s)), a);
  deny(upd(ID, set(MIDAS_COL, 'Done')), a);
});
test('T22 attachments need a fileName starting with the id', () => {
  deny(upload('evidence.png'), armOf('Accept G1 999999001'));
  pass(upload('999999001-evidence.png'), armOf('Accept G1 999999001'));
});
test('T22 an attachment link needs its id and an attachmentUrl fileName starting with the id', () => {
  const al = (workItemId, fileName) => ({ tool_name: S1 + 'wit_work_item_attachment_link', tool_input: { workItemId,
    attachmentUrl: `https://dev.azure.com/bigchange/_apis/wit/attachments/00000000-0000-4000-8000-000000000001${fileName ? `?fileName=${fileName}` : ''}` } });
  const a = armOf('Accept G1 999999001');
  pass(al(ID, '999999001-evidence.png'), a);
  deny(al(ID, 'evidence.png'), a);
  deny(al(ID, null), a);
  deny(al(MATE, '999999002-evidence.png'), a);
});
test('T22 Approve: comment allows a comment on its id and nothing else', () => {
  const a = armOf('Approve: comment 999999001');
  pass(comment(ID), a); deny(comment(MATE), a, [], 'Approve: comment 999999002'); deny(upd(ID, set('System.Title', 'x')), a);
});
test('T22 links: G1 links its id to another item; Create it. links the created item', () => {
  pass(link(ID, 999999003), armOf('Accept G1 999999001'));
  deny(link(MATE, 999999003), armOf('Accept G1 999999001'));
  pass(link(999999050, ID), armOf('Create it.', [], { item: [999999050] }));
  deny(link(999999051, ID), armOf('Create it.', [], { item: [999999050] }));
});
test('T22 G9b creates test cases for its id and edits steps only on cases created this message', () => {
  const a = armOf('Accept G9b 999999001', [], { testcase: [999999060] });
  pass(tc({ action: 'create', testsWorkItemId: ID, title: 'x' }), a);
  deny(tc({ action: 'create', testsWorkItemId: MATE, title: 'x' }), a);
  pass(tc({ action: 'update_steps', id: 999999060, steps: 'x' }), a);
  deny(tc({ action: 'update_steps', id: 999999061, steps: 'x' }), a, [], 'Accept G9b');
});
test('T49 G13 on an own item denies Tested By and Approved', () => {
  deny(upd(ID, set(ado.TESTED_BY_FIELD, 'mate@example.com')), g13(own), own);
  deny(upd(ID, set('System.State', 'Approved')), g13(own), own);
});
test('T50 Take on an own item arms nothing and the Testing move is denied', () => {
  const a = armOf('Take 999999001', own);
  assert.deepStrictEqual(a.classes, []);
  deny(upd(ID, set(MIDAS_COL, 'Testing')), a, own);
});
test('T51 RW: an item is closed while its work was never built: no G10 answer denies the close', () =>
  deny(close, g13(own), own, 'Accept G13 999999001'));
test('T51 a ledger read error denies the close', () =>
  assert.match(ado.check(close, ctxOf(g13(own), own, { ledger: () => { throw new Error('bad ledger line'); } })), DENY));
test('T52 a G10 accept followed by a newer G9, push of the id branch or G9b denies the close', () => {
  for (const ev of [line('accept', 'G9 999999001'), line('approve', 'push bugfix/999999001-x'), line('accept', 'G9b 999999001')]) {
    const l = [...own, line('accept', 'G10 999999001'), ev];
    deny(close, g13(l), l);
  }
});
test('T53 a human typed G10 skip with a reason allows the close, by state or by Done column', () => {
  const l = [...own, line('skip', 'G10 999999001: tested in production')];
  pass(close, g13(l), l);
  pass(upd(ID, set('System.State', 'Removed')), g13(l), l);
  pass(upd(ID, set(MIDAS_COL, 'Done')), g13(l), l);
  deny(close, armOf('Approve: update 999999001', l), l);
});
test('T53 the same skip from origin other or unverified pending does not count', () => {
  for (const origin of ['other', 'pending']) {
    const l = [...own, line('skip', 'G10 999999001: tested in production', origin, 'p5')];
    deny(close, g13(l), l);
  }
  const v = [...own, line('skip', 'G10 999999001: tested in production', 'pending', 'p5'), ledgerLib.verifiedLine('p5')];
  pass(close, g13(v), v);
});
test('T73 Take on a teammate item allows the Testing move, as a column', () => {
  const a = armOf('Take 999999002');
  pass(upd(MATE, set(MIDAS_COL, 'Testing')), a);
  pass(upd(MATE, set('System.State', 'Approval'), set(MIDAS_COL, 'Testing')), a);
  deny(upd(MATE, set('System.State', 'Testing')), a); // states and columns are checked separately, never pooled
  deny(upd(MATE, set(MIDAS_COL, 'Approval')), a);
});
test('T74 Tested By is denied under Take and when Tested has no open take', () => {
  deny(upd(MATE, set(ado.TESTED_BY_FIELD, 'dev@example.com')), armOf('Take 999999002'), [], 'Tested 999999002');
  deny(upd(MATE, set(ado.TESTED_BY_FIELD, 'dev@example.com')), armOf('Tested 999999002'), [], 'Tested 999999002');
});
test('T75 Tested after a take allows Tested By, Approved, a comment and a named attachment', () => {
  const l = [line('take', '999999002')], a = armOf('Tested 999999002', l);
  pass(upd(MATE, set(ado.TESTED_BY_FIELD, 'dev@example.com'), set('System.State', 'Approved')), a, l);
  pass(comment(MATE), a, l);
  pass(upload('999999002-QA-01.png'), a, l);
  deny(upd(MATE, set('System.Title', 'x')), a, l);
});
test('T75 Tested after a take allows the fail-path moves to Ready for testing and Implementing, and no other column', () => {
  const l = [line('take', '999999002')], a = armOf('Tested 999999002', l);
  for (const c of ['Closing', 'Ready for testing', 'Implementing']) pass(upd(MATE, set(MIDAS_COL, c)), a, l);
  pass(upd(MATE, set('System.State', 'Implementation'), set(MIDAS_COL, 'Implementing')), a, l);
  deny(upd(MATE, set(MIDAS_COL, 'Done')), a, l);
});
test('T22 stdin: each ado-*.json fixture prints one deny line when outward and nothing when a read', () => {
  const dir = path.join(__dirname, 'fixtures', 'inputs');
  for (const f of fs.readdirSync(dir).filter((n) => /^ado-.*\.json$/.test(n))) {
    const fx = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), env = tempEnv();
    const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(fx), encoding: 'utf8', timeout: 5000,
      env: { CLAUDE_PLUGIN_DATA: env.dataDir, MIDAS_SDLC_WORKROOT: env.workRoot, SystemRoot: process.env.SystemRoot } });
    assert.strictEqual(r.status, 0, f);
    if (ado.classify(fx.tool_name, fx.tool_input).read) assert.strictEqual(r.stdout, '', f);
    else {
      const out = r.stdout.trim().split('\n');
      assert.strictEqual(out.length, 1, f);
      assert.strictEqual(JSON.parse(out[0]).hookSpecificOutput.permissionDecision, 'deny', f);
    }
  }
});
test('T51 RW: a padded "Closed " state under G13 with no G10 answer is still a close and denies', () =>
  deny(upd(ID, set('System.State', 'Closed ')), g13(own), own, 'Accept G13 999999001'));
test('T22 padded states and columns under Approve: update are still forbidden', () => {
  const a = armOf('Approve: update 999999001');
  for (const s of [' Testing', 'Closed ']) deny(upd(ID, set('System.State', s)), a);
  deny(upd(ID, set(MIDAS_COL, 'Done ')), a);
});
test('T22 a field name with surrounding whitespace is a patch path and always denies', () => {
  deny(upd(ID, set('System.State ', 'Closed')), armOf('Accept G1 999999001'));
  assert.strictEqual(ado.classify(S1 + 'wit_work_item_write', upd(ID, set('System.State ', 'Closed')).tool_input).always, 'patch path');
  assert.strictEqual(ado.classify(S1 + 'wit_work_item_write', create('Bug', MIDAS, [{ name: ' System.State', value: 'Active' }]).tool_input).always, 'patch path');
});

const REPO = Object.keys(ado.REPO_IDS).find((n) => /jobfinance/i.test(n));
const DB = Object.keys(ado.REPO_IDS).find((n) => ado.REPO_IDS[n].toLowerCase() === ado.DATABASE_REPO_ID.toLowerCase());
const PR = 999999070, OTHER_PR = 999999071, NO_REPO = '00000000-0000-0000-0000-000000000000';
const prw = (i) => ({ tool_name: S1 + 'repo_pull_request_write', tool_input: { repositoryId: REPO, ...i } });
const thw = (i) => ({ tool_name: S1 + 'repo_pull_request_thread_write', tool_input: { repositoryId: REPO, pullRequestId: PR, ...i } });
const prLink = (action, i) => ({ tool_name: S1 + 'wit_work_item_link_write', tool_input: { action, workItemId: 999999001, ...i } });
const run = (pipelineId, refName, extra = {}) => ({ tool_name: S1 + 'pipelines_write', tool_input: { action: 'run_pipeline',
  project: 'BigChange', pipelineId, resources: { repositories: { self: { refName } } }, ...extra } });
const CREATE = { action: 'create', sourceRefName: 'refs/heads/bugfix/999999001-x', targetRefName: `refs/heads/${ado.TRUNKS[REPO]}`,
  isDraft: true, workItems: '999999001', title: '999999001 Fix x', description: 'x' };
const MERGE = { action: 'update', pullRequestId: PR, autoComplete: true, mergeStrategy: 'Squash', deleteSourceBranch: true, transitionWorkItems: false };

test('T28 the test repo has a trunk', () => assert.ok(REPO && ado.TRUNKS[REPO]));
test('T28 ALLOWED gives each answer only its own PR-side pairs', () => assert.deepStrictEqual(ado.ALLOWED, {
  G8: [{ cls: 'pr', op: 'create', target: 'id' }, { cls: 'link', op: 'pr', target: 'created.pr' }],
  'G8b-id': [{ cls: 'pr', op: 'publish', target: 'prsFor(id)' }, { cls: 'pr', op: 'reviewers', target: 'prsFor(id)' }],
  'G8b-pr': [{ cls: 'pr', op: 'publish', target: 'pr' }, { cls: 'pr', op: 'reviewers', target: 'pr' }],
  review: [{ cls: 'thread', op: 'create', target: 'pr' }, { cls: 'thread', op: 'reply', target: 'pr' },
    { cls: 'thread', op: 'status', target: 'pr' }, { cls: 'vote', op: 'vote', target: 'pr' }],
  reply: [{ cls: 'thread', op: 'reply', target: 'pr' }, { cls: 'thread', op: 'status', target: 'pr' }, { cls: 'pr', op: 'edit', target: 'pr' }],
  G11: [{ cls: 'merge', op: 'complete', target: 'pr' }],
}));
test('T29 T77 Approve: review posts comments and a vote on its PR', () => {
  const a = armOf('Approve: review PR999999070');
  pass(thw({ action: 'create', content: 'x' }), a);
  pass(thw({ action: 'reply', threadId: 1, content: 'x' }), a);
  pass(prw({ action: 'vote', pullRequestId: PR, vote: 'Approved' }), a);
});
test('T30 Approve: review denies a vote on another PR', () =>
  deny(prw({ action: 'vote', pullRequestId: OTHER_PR, vote: 'Approved' }), armOf('Approve: review PR999999070'), [], 'Approve: review PR999999071'));
test('T31 Approve: reply resolves a thread and edits the title, but never votes or edits a comment', () => {
  const a = armOf('Approve: reply PR999999070');
  pass(thw({ action: 'update_status', threadId: 1, status: 'Fixed' }), a);
  pass(prw({ action: 'update', pullRequestId: PR, title: '999999001 Fix x' }), a);
  deny(prw({ action: 'vote', pullRequestId: PR, vote: 'Approved' }), a, [], 'Approve: review PR999999070');
  deny(thw({ action: 'update', threadId: 1, commentId: 1, content: 'x' }), a);
  deny(prw({ action: 'update', pullRequestId: PR, title: 'Fixes #999999001' }), a);
  deny(prw({ action: 'update', pullRequestId: PR, title: 'fix #999999001' }), a);
});
test('T28 G8 opens a draft PR from its id branch into the trunk or release/*', () => {
  const g8 = armOf('Accept G8 999999001');
  pass(prw(CREATE), g8);
  pass(prw({ ...CREATE, targetRefName: 'refs/heads/release/26.11.02' }), g8);
  pass(prw({ ...CREATE, workItems: ['999999001'] }), g8); // array form
  pass(prw({ ...CREATE, workItems: '999999001 999999002' }), g8); // guard design: the work items include the id
});
test('T28 G8 denies a non-draft, a wrong target, a Fixes title, work items without the id and a branch without the id', () => {
  const g8 = armOf('Accept G8 999999001');
  for (const bad of [{ isDraft: false }, { isDraft: undefined }, { targetRefName: 'refs/heads/feature/x' },
    { title: 'Fixes #999999001' }, { title: 'Fixed #12' }, { title: 'x closes #5' }, { description: 'Resolves #12' },
    { title: 'Fix #12' }, { description: 'closed #12' },
    { workItems: '999999002' }, { workItems: '9999990010' }, { workItems: undefined },
    { sourceRefName: 'refs/heads/bugfix/9999990011-x' }, { repositoryId: NO_REPO }])
    deny(prw({ ...CREATE, ...bad }), g8);
  deny(prw(CREATE), null, [], 'Accept G8 999999001');
});
test('T28 G8 links its item only to a PR created in this message, and only by link_to_pull_request', () => {
  const g8 = armOf('Accept G8 999999001', [], { pr: [PR] });
  pass(prLink('link_to_pull_request', { pullRequestId: PR, repositoryId: ado.REPO_IDS[REPO], projectId: 'p' }), g8);
  deny(prLink('link_to_pull_request', { pullRequestId: OTHER_PR, repositoryId: ado.REPO_IDS[REPO], projectId: 'p' }), g8);
  deny(prLink('add_artifact_link', { artifactUri: 'vstfs:///Git/PullRequestId/p%2Fr%2F999999070' }), g8);
});
test('T28 G8b by id publishes and adds reviewers only on PRs the ledger records for its id', () => {
  const l = [line('created', 'pr 999999070 999999001')], a = armOf('Accept G8b 999999001', l);
  pass(prw({ action: 'update', pullRequestId: PR, isDraft: false }), a, l);
  pass(prw({ action: 'update_reviewers', pullRequestId: PR, reviewerIds: ['r'], reviewerAction: 'add' }), a, l);
  deny(prw({ action: 'update', pullRequestId: OTHER_PR, isDraft: false }), a, l);
  deny(prw({ action: 'update', pullRequestId: PR, isDraft: false, title: 'x' }), a, l);
});
test('T28 G8b by PR publishes only that PR', () => {
  pass(prw({ action: 'update', pullRequestId: PR, isDraft: false }), armOf('Accept G8b PR999999070'));
  deny(prw({ action: 'update', pullRequestId: OTHER_PR, isDraft: false }), armOf('Accept G8b PR999999070'));
});
test('T40 G11 completes its PR as a squash that deletes the branch and leaves work items alone', () =>
  pass(prw(MERGE), armOf('Accept G11 PR999999070')));
test('T41 RW: a PR\'s auto-complete closes its item before testing: G11 denies every other completion', () => {
  const g11 = armOf('Accept G11 PR999999070');
  for (const bad of [{ transitionWorkItems: undefined }, { transitionWorkItems: true }, { bypassPolicy: true, bypassReason: 'x' },
    { mergeStrategy: 'NoFastForward' }, { deleteSourceBranch: undefined }, { mergeCommitMessage: 'x' }, { pullRequestId: OTHER_PR },
    { repositoryId: ado.DATABASE_REPO_ID }, { repositoryId: DB }, { repositoryId: NO_REPO }])
    deny(prw({ ...MERGE, ...bad }), g11);
  deny(prw(MERGE), armOf('Accept G11 999999001'), [], 'Accept G11 PR999999070');
});
test('T41 abandoning a PR and cancelling auto-complete are denied under G11 and Approve: reply on that PR', () => {
  const abandon = prw({ action: 'update', pullRequestId: PR, status: 'Abandoned' });
  const cancel = prw({ action: 'update', pullRequestId: PR, autoComplete: false });
  for (const text of ['Accept G11 PR999999070', 'Approve: reply PR999999070', 'Approve: review PR999999070']) {
    deny(abandon, armOf(text)); deny(cancel, armOf(text));
  }
});
test('T23 an unarmed pipeline run is denied, and previewRun true is a read', () => {
  deny(run(gates.G9_PIPELINES[0], 'refs/heads/midas/dev'), null);
  pass(run(gates.G9_PIPELINES[0], 'refs/heads/midas/dev', { previewRun: true }), null);
});
test('T28 G9 runs only the container pipelines on midas/dev; Approve: pipeline runs only its definition', () => {
  const g9 = armOf('Accept G9 999999001');
  for (const p of gates.G9_PIPELINES) pass(run(p, 'refs/heads/midas/dev'), g9);
  deny(run(1317, 'refs/heads/midas/dev'), g9);
  deny(run(gates.G9_PIPELINES[0], 'refs/heads/WebRelease2'), g9);
  deny(run(gates.G9_PIPELINES[0], 'refs/heads/midas/dev', { templateParameters: { a: 'b' } }), g9);
  deny(run(gates.G9_PIPELINES[0], 'refs/heads/midas/dev', { variables: { a: { value: 'b' } } }), g9);
  pass(run(1317, 'refs/heads/WebRelease2'), armOf('Approve: pipeline 1317'));
  deny(run(gates.G9_PIPELINES[0], 'refs/heads/WebRelease2'), armOf(`Approve: pipeline ${gates.G9_PIPELINES[0]}`));
});
test('T3 a 0 created-item placeholder is not a link end; a real created id still is', () => {
  const l = (id) => ({ tool_name: S1 + 'wit_work_item_link_write', tool_input: { action: 'link', updates: [{ id, linkToId: 999999001, type: 'related' }] } });
  deny(l(null), armOf('Create it.', [], { item: [0] }));
  pass(l(999999050), armOf('Create it.', [], { item: [999999050] }));
});
