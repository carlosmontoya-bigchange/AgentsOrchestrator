'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const ado = require('../hooks/lib/ado');
const gates = require('../hooks/lib/gates');
const { armOf, ctxOf, line } = require('./fixtures/arm');

const S1 = 'mcp__azure-devops__', ID = 999999001, MATE = 999999002, PR = 999999070, OTHER_PR = 999999071;
const REPO = Object.keys(ado.REPO_IDS).find((n) => /jobfinance/i.test(n));
const G = (n) => `Accept G${n} 999999001`;
const LEDGER = [line('take', '999999001'), line('created', 'pr 999999070 999999001')];
const ARMS = [...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(G), G('8b'), G('9b'),
  'Accept G8b PR999999070', 'Accept G11 PR999999070', 'Refuse G8 999999001', 'Refuse G8b PR999999070',
  'Skip G8 999999001: not needed', 'Pause 999999001', 'Take 999999001', 'Tested 999999001',
  'Approve: comment 999999001', 'Approve: update 999999001', 'Approve: create item', 'Create it.',
  'Approve: review PR999999070', 'Approve: reply PR999999070', 'Approve: push bugfix/999999001-x',
  'Approve: pipeline 1317', 'Approve: edit harness'];
const call = (tool, tool_input) => ({ tool_name: S1 + tool, tool_input });
const set = (field, value) => call('wit_work_item_write', { action: 'update', id: ID, updates: [{ op: 'add', path: `/fields/${field}`, value }] });
const runP = (pipelineId, refName) => call('pipelines_write', { action: 'run_pipeline', project: 'BigChange', pipelineId, resources: { repositories: { self: { refName } } } });
const ACTIONS = {
  'pr.create': call('repo_pull_request_write', { action: 'create', repositoryId: REPO, sourceRefName: 'refs/heads/bugfix/999999001-x',
    targetRefName: `refs/heads/${ado.TRUNKS[REPO]}`, isDraft: true, workItems: '999999001', title: '999999001 x', description: 'x' }),
  'link.pr': call('wit_work_item_link_write', { action: 'link_to_pull_request', workItemId: ID, pullRequestId: PR, repositoryId: ado.REPO_IDS[REPO], projectId: 'p' }),
  'pr.publish': call('repo_pull_request_write', { action: 'update', repositoryId: REPO, pullRequestId: PR, isDraft: false }),
  'pr.publish.other': call('repo_pull_request_write', { action: 'update', repositoryId: REPO, pullRequestId: OTHER_PR, isDraft: false }),
  'pr.reviewers': call('repo_pull_request_write', { action: 'update_reviewers', repositoryId: REPO, pullRequestId: PR, reviewerIds: ['r'], reviewerAction: 'add' }),
  'pr.vote': call('repo_pull_request_write', { action: 'vote', repositoryId: REPO, pullRequestId: PR, vote: 'Approved' }),
  'pr.vote.other': call('repo_pull_request_write', { action: 'vote', repositoryId: REPO, pullRequestId: OTHER_PR, vote: 'Approved' }),
  'thread.create': call('repo_pull_request_thread_write', { action: 'create', repositoryId: REPO, pullRequestId: PR, content: 'x' }),
  'thread.reply': call('repo_pull_request_thread_write', { action: 'reply', repositoryId: REPO, pullRequestId: PR, threadId: 1, content: 'x' }),
  'thread.status': call('repo_pull_request_thread_write', { action: 'update_status', repositoryId: REPO, pullRequestId: PR, threadId: 1, status: 'Fixed' }),
  'pr.edit': call('repo_pull_request_write', { action: 'update', repositoryId: REPO, pullRequestId: PR, title: '999999001 x' }),
  merge: call('repo_pull_request_write', { action: 'update', repositoryId: REPO, pullRequestId: PR, autoComplete: true,
    mergeStrategy: 'Squash', deleteSourceBranch: true, transitionWorkItems: false }),
  'pipeline.g9': runP(gates.G9_PIPELINES[0], 'refs/heads/midas/dev'),
  'pipeline.1317': runP(1317, 'refs/heads/WebRelease2'),
  'item.title': set('System.Title', 'x'),
  'item.title.other': call('wit_work_item_write', { action: 'update', id: MATE, updates: [{ op: 'add', path: '/fields/System.Title', value: 'x' }] }),
  'item.assign': set('System.AssignedTo', 'dev@example.com'),
  'move.testing': set('WEF_36778208447642C48B0A0F72C104A5C5_Kanban.Column', 'Testing'),
  'move.approved': set('System.State', 'Approved'),
  'move.readyfortesting': set('WEF_36778208447642C48B0A0F72C104A5C5_Kanban.Column', 'Ready for testing'),
  'move.implementing': set('WEF_36778208447642C48B0A0F72C104A5C5_Kanban.Column', 'Implementing'),
  testedby: set(ado.TESTED_BY_FIELD, 'mate@example.com'),
  close: set('System.State', 'Closed'),
  comment: call('wit_work_item_comment_write', { action: 'add', workItemId: ID, text: 'x' }),
  create: call('wit_work_item_write', { action: 'create', workItemType: 'Bug', fields: [{ name: 'System.Title', value: 'x' }, { name: 'System.AreaPath', value: 'BigChange\\Finance\\Midas' }] }),
  'create.cr': call('wit_work_item_write', { action: 'create', workItemType: 'Change Request', fields: [{ name: 'System.Title', value: 'x' }, { name: 'System.AreaPath', value: 'BigChange\\Finance\\Midas' }] }),
  testcase: call('testplan_test_case_write', { action: 'create', testsWorkItemId: ID, title: 'x' }),
};
const REVIEW = 'Approve: review PR999999070', REPLY = 'Approve: reply PR999999070';
const EXPECT = {
  'pr.create': [G(8)], 'link.pr': [G(8)],
  'pr.publish': [G('8b'), 'Accept G8b PR999999070'], 'pr.publish.other': [],
  'pr.reviewers': [G('8b'), 'Accept G8b PR999999070'],
  'pr.vote': [REVIEW], 'pr.vote.other': [], 'thread.create': [REVIEW],
  'thread.reply': [REVIEW, REPLY], 'thread.status': [REVIEW, REPLY], 'pr.edit': [REPLY],
  merge: ['Accept G11 PR999999070'], 'pipeline.g9': [G(9)], 'pipeline.1317': ['Approve: pipeline 1317'],
  'item.title': [G(1), G(2), G(12), G(13), 'Approve: update 999999001'], 'item.title.other': [],
  'item.assign': [G(0), G(1), G(2), G(4), G(12), G(13), 'Approve: update 999999001'],
  'move.testing': ['Take 999999001'], 'move.approved': ['Tested 999999001'], testedby: ['Tested 999999001'], close: [],
  'move.readyfortesting': [G('9b'), G(13), 'Approve: update 999999001', 'Tested 999999001'],
  'move.implementing': [G(4), G(13), 'Approve: update 999999001', 'Tested 999999001'],
  comment: [G(1), G(2), G('9b'), G(13), 'Approve: comment 999999001', 'Tested 999999001'],
  create: [G(13), 'Approve: create item', 'Create it.'],
  'create.cr': [G(12), G(13), 'Approve: create item', 'Create it.'],
  testcase: [G('9b')],
};
const verdict = (input, text) => ado.check(input, ctxOf(armOf(text, LEDGER, { pr: [PR] }), LEDGER));

test('T28 matrix: every EXPECT arm is in ARMS and every action has a row', () => {
  assert.deepStrictEqual(Object.keys(EXPECT).sort(), Object.keys(ACTIONS).sort());
  for (const list of Object.values(EXPECT)) for (const t of list) assert.ok(ARMS.includes(t), t);
});
for (const [name, input] of Object.entries(ACTIONS)) {
  test(`T28 matrix: ${name} passes only for ${EXPECT[name].join(', ') || 'no answer'}`, () => {
    for (const text of ARMS) {
      const r = verdict(input, text);
      if (EXPECT[name].includes(text)) assert.strictEqual(r, null, `${text} should pass ${name}: ${r}`);
      else assert.match(r ?? '', /^midas-sdlc blocked /, `${text} should not pass ${name}`);
    }
  });
}
test('T28 review focus: a vote passes only under Approve: review on its own PR, and Approve: reply never votes', () => {
  for (const text of ARMS) {
    assert.strictEqual(verdict(ACTIONS['pr.vote'], text) === null, text === REVIEW, text);
    assert.notStrictEqual(verdict(ACTIONS['pr.vote.other'], text), null, text);
  }
  assert.notStrictEqual(verdict(ACTIONS['pr.vote'], REPLY), null);
});
