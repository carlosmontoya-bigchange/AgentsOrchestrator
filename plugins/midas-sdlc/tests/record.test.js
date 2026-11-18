'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const S = require('../hooks/lib/state');
const { userPrompt, writeTranscript } = require('./fixtures/transcript');
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'midas-rec-')).replace(/\\/g, '/');
const ARM = { session_id: 's1', prompt_id: 'p1', answer: 'Accept G8 999999001', gate: 'G8', target: { id: 999999001 },
  classes: ['push', 'pr', 'link'], origin: 'human', created: { pr: [], item: [], testcase: [] } };
let tmp, work, dir, t, tBom, env, childEnv;
beforeEach(() => {
  tmp = mk(); work = mk(); dir = mk();
  t = writeTranscript(dir, [userPrompt('p1', 'x'), userPrompt('p2', 'y')]);
  tBom = writeTranscript(mk(), [userPrompt('p-bom', 'Accept G3 999999000')]);
  env = S.envFrom({ CLAUDE_PLUGIN_DATA: tmp, MIDAS_SDLC_WORKROOT: work }, {});
  childEnv = { CLAUDE_PLUGIN_DATA: tmp, MIDAS_SDLC_WORKROOT: work, NODE_TEST_CONTEXT: 'child', SystemRoot: process.env.SystemRoot, USERPROFILE: process.env.USERPROFILE };
});

function run(stdin, e, { end = true, args = [RECORD] } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, args, { env: e });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stdin.on('error', () => {});
    c.stdin.write(stdin);
    if (end) c.stdin.end();
    c.on('exit', (code) => resolve({ code, out, ms: Date.now() - t0 }));
  });
}

const { onPrompt } = require('../hooks/record');
const RECORD = require.resolve('../hooks/record');
const { ANSWER_FORMS } = require('../hooks/lib/answers');
const P = (prompt, extra = {}) => ({ session_id: 's1', prompt_id: 'p1', transcript_path: t, cwd: 'C:/dev/Projects/BigChange', hook_event_name: 'UserPromptSubmit', prompt, ...extra });
const CTX = '<artifact-view-context>doc</artifact-view-context>\nThe developer is viewing this artifact in the side pane.\n\n';
test('T13 a typed skip is recorded with its reason, in the ledger and gates.log', () => {
  assert.equal(onPrompt(P('Skip G3 999999001: small change'), env), 'midas-sdlc: recorded "Skip G3 999999001: small change"; nothing armed.');
  assert.deepEqual(S.readLedger(tmp), [{ prompt_id: 'p1', kind: 'skip', value: 'G3 999999001: small change', origin: 'human' }]);
  assert.match(fs.readFileSync(path.join(work, '999999001', 'gates.log'), 'utf8'), / skip G3 999999001: small change \(human\)\n$/);
  assert.deepEqual(S.readArm(tmp, 's1').classes, []);
});
test("T33 'Approve: do whatever's needed' arms nothing and names the forms", () => {
  assert.equal(onPrompt(P("Approve: do whatever's needed"), env), `midas-sdlc: 'Approve: do whatever's needed' is not an answer, nothing armed. Forms: ${ANSWER_FORMS}`);
  assert.equal(S.readArm(tmp, 's1'), null); assert.deepEqual(S.readLedger(tmp), []);
});
test('T27 the next ordinary message deletes the arm', () => {
  onPrompt(P('Accept G8 999999001'), env); assert.ok(S.readArm(tmp, 's1'));
  assert.equal(onPrompt(P('thanks', { prompt_id: 'p2' }), env), null); assert.equal(S.readArm(tmp, 's1'), null);
});
test('T27 agent_id or agent_type touches nothing; no prompt_id records nothing', () => {
  S.writeArm(tmp, ARM);
  assert.equal(onPrompt(P('Accept G8 999999001', { agent_id: 'a1' }), env), null); assert.ok(S.readArm(tmp, 's1'));
  assert.equal(onPrompt(P('thanks', { agent_type: '' }), env), null); assert.ok(S.readArm(tmp, 's1'));
  const noId = P('Accept G8 999999001'); delete noId.prompt_id;
  assert.equal(onPrompt(noId, env), 'midas-sdlc: no prompt_id, nothing armed.');
  assert.equal(S.readArm(tmp, 's1'), null); assert.deepEqual(S.readLedger(tmp), []);
});
test('T27 a non-human origin records the line as other and writes no arm', () => {
  const tOther = writeTranscript(dir, [userPrompt('p1', 'Accept G8 999999001', { clientPlatform: 'not-a-platform' })]);
  assert.match(onPrompt(P('Accept G8 999999001', { transcript_path: tOther }), env), /not the developer; nothing armed/);
  assert.equal(S.readLedger(tmp)[0].origin, 'other'); assert.equal(S.readArm(tmp, 's1'), null);
});
test('T27 a pending origin arms, then is verified at the next prompt', () => {
  const tp = path.join(dir, 'pending.jsonl'); fs.writeFileSync(tp, '');
  onPrompt(P('Take 999999002', { transcript_path: tp }), env);
  assert.equal(S.readArm(tmp, 's1').origin, 'pending'); assert.equal(S.readLedger(tmp)[0].origin, 'pending');
  fs.appendFileSync(tp, JSON.stringify(userPrompt('p1', 'Take 999999002')) + '\n');
  onPrompt(P('next', { prompt_id: 'p2', transcript_path: tp }), env);
  assert.deepEqual(S.readLedger(tmp).at(-1), { prompt_id: 'p1', kind: 'verified', value: 'p1', origin: 'human' });
});
test('T13 a refuse without a reason makes the next message the reason', () => {
  onPrompt(P('Refuse G6 999999001'), env);
  onPrompt(P('flaky on CI', { prompt_id: 'p2' }), env);
  assert.deepEqual(S.readLedger(tmp).at(-1), { prompt_id: 'p2', kind: 'reason', value: 'G6 999999001: flaky on CI', origin: 'human' });
});
test('T27 an unreadable ledger arms nothing and says so', () => {
  fs.writeFileSync(path.join(tmp, 'ledger.jsonl'), 'not json\n');
  assert.match(onPrompt(P('Accept G8 999999001'), env), /^midas-sdlc: the gate record could not be read/);
  assert.equal(S.readArm(tmp, 's1'), null);
});
test('T27 a repeat prompt_id (task notification) deletes the arm and records nothing', () => {
  onPrompt(P('Accept G8 999999001'), env);
  const before = fs.readFileSync(path.join(tmp, 'ledger.jsonl'), 'utf8');
  assert.equal(onPrompt(P('<task-notification>done</task-notification>'), env), null);
  assert.equal(S.readArm(tmp, 's1'), null);
  assert.equal(fs.readFileSync(path.join(tmp, 'ledger.jsonl'), 'utf8'), before);
});
test('T27 a repeat prompt_id whose text is a valid answer records nothing either', () => {
  onPrompt(P('Accept G8 999999001'), env);
  const before = fs.readFileSync(path.join(tmp, 'ledger.jsonl'), 'utf8');
  assert.equal(onPrompt(P('Refuse G8 999999001'), env), null);
  assert.equal(S.readArm(tmp, 's1'), null);
  assert.equal(fs.readFileSync(path.join(tmp, 'ledger.jsonl'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(work, '999999001', 'gates.log')), true);
  assert.equal(fs.readFileSync(path.join(work, '999999001', 'gates.log'), 'utf8').split('\n').filter(Boolean).length, 1);
});
test('T27 a mid-turn repeat leaves a pending answer line pending, with no verified line', () => {
  const tp = path.join(dir, 'pending.jsonl'); fs.writeFileSync(tp, '');
  onPrompt(P('Take 999999002', { transcript_path: tp }), env);
  fs.appendFileSync(tp, JSON.stringify(userPrompt('p1', 'Take 999999002')) + '\n');
  assert.equal(onPrompt(P('<task-notification>x</task-notification>', { transcript_path: tp }), env), null);
  assert.equal(S.readArm(tmp, 's1'), null);
  const l = S.readLedger(tmp); assert.equal(l.length, 1); assert.equal(l[0].origin, 'pending');
  onPrompt(P('Refuse G6 999999001', { prompt_id: 'p2' }), env);
  assert.equal(onPrompt(P('flaky', { prompt_id: 'p2' }), env), null);
  assert.equal(S.readLedger(tmp).some((x) => x.kind === 'reason' || x.kind === 'verified'), false);
});
test('T27 a second mid-turn delivery with a valid answer records nothing, with no arm or after the first repeat', () => {
  onPrompt(P('thanks', { prompt_id: 'p2' }), env); assert.equal(S.readArm(tmp, 's1'), null);
  assert.equal(onPrompt(P('Accept G8 999999001', { prompt_id: 'p2' }), env), null);
  assert.equal(S.readArm(tmp, 's1'), null); assert.deepEqual(S.readLedger(tmp), []);
  onPrompt(P('Accept G8 999999002', { prompt_id: 'p3' }), env);
  assert.equal(onPrompt(P('<task-notification>x</task-notification>', { prompt_id: 'p3' }), env), null);
  assert.equal(onPrompt(P('Accept G8 999999003', { prompt_id: 'p3' }), env), null);
  assert.equal(S.readArm(tmp, 's1'), null); assert.equal(S.readLedger(tmp).length, 1);
});
test('T27 a new prompt_id after a repeat works normally', () => {
  onPrompt(P('thanks', { prompt_id: 'p2' }), env); onPrompt(P('Accept G8 999999001', { prompt_id: 'p2' }), env);
  assert.match(onPrompt(P('Accept G8 999999001', { prompt_id: 'p1' }), env), /^midas-sdlc: armed push/);
  assert.equal(S.readLedger(tmp).length, 1);
});
test('T13 a notification does not take the reason slot', () => {
  onPrompt(P('Refuse G6 999999001'), env);
  assert.equal(onPrompt(P('<task-notification>x</task-notification>', { prompt_id: 'p3' }), env), null);
  onPrompt(P('flaky on CI', { prompt_id: 'p2' }), env);
  const reasons = S.readLedger(tmp).filter((l) => l.kind === 'reason');
  assert.deepEqual(reasons, [{ prompt_id: 'p2', kind: 'reason', value: 'G6 999999001: flaky on CI', origin: 'human' }]);
});
test('T27 an unreadable last-prompt file fails closed: a valid answer records and arms nothing', () => {
  fs.mkdirSync(path.join(tmp, 'last-s1.txt'));
  S.writeArm(tmp, ARM);
  assert.equal(onPrompt(P('Accept G8 999999001', { prompt_id: 'p2' }), env), null);
  assert.equal(S.readArm(tmp, 's1'), null); assert.deepEqual(S.readLedger(tmp), []);
});
test('T27 a failed write of the last-prompt file fails closed', () => {
  const orig = S.writeLast; S.writeLast = () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); };
  try {
    S.writeArm(tmp, ARM);
    assert.equal(onPrompt(P('Accept G8 999999001', { prompt_id: 'p2' }), env), null);
  } finally { S.writeLast = orig; }
  assert.equal(S.readArm(tmp, 's1'), null); assert.deepEqual(S.readLedger(tmp), []);
});
test('T27 a bad or missing session_id writes nothing', () => {
  for (const sid of ['../x', 'a/b', '', undefined]) {
    assert.equal(onPrompt(P('Accept G8 999999001', { session_id: sid }), env), null);
  }
  assert.deepEqual(S.readLedger(tmp), []); assert.deepEqual(fs.readdirSync(tmp), []);
});
test('T27 one leading app-context block is stripped before parsing; two are not', () => {
  assert.match(onPrompt(P(CTX + 'Accept G8 999999001'), env), /^midas-sdlc: armed push, pr, link/);
  assert.equal(S.readArm(tmp, 's1').answer, 'Accept G8 999999001');
  S.deleteArm(tmp, 's1');
  assert.equal(onPrompt(P(CTX + CTX + 'Accept G8 999999002', { prompt_id: 'p2' }), env), null);
  assert.equal(S.readArm(tmp, 's1'), null); assert.equal(S.readLedger(tmp).length, 1);
});
test('T27 record.js strips a BOM, records and prints additionalContext (child process)', async () => {
  const r = await run('\uFEFF' + JSON.stringify(P('Accept G3 999999000', { session_id: 's-bom', prompt_id: 'p-bom', transcript_path: tBom })), childEnv);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'midas-sdlc: recorded "Accept G3 999999000"; nothing armed.' } });
  assert.equal(S.readArm(tmp, 's-bom').prompt_id, 'p-bom');
  assert.deepEqual(S.readLedger(tmp), [{ prompt_id: 'p-bom', kind: 'accept', value: 'G3 999999000', origin: 'human' }]);
  assert.match(fs.readFileSync(path.join(work, '999999000', 'gates.log'), 'utf8'), /^\d{4}-\d\d-\d\dT[\d:.]+Z accept G3 999999000 \(human\)\n$/);
});
test('T27 record.js answers held-open input within 150 ms of node start-up', async () => {
  const base = await run('', childEnv, { args: ['-e', ''] });
  const r = await run(JSON.stringify(P('thanks')), childEnv, { end: false });
  assert.equal(r.code, 0); assert.ok(r.ms - base.ms < 150, `${r.ms - base.ms} ms`);
});
test('T27 record.js on garbage, or without CLAUDE_PLUGIN_DATA, exits 0 and writes nothing', async () => {
  for (const [stdin, e] of [['not json', childEnv], [JSON.stringify(P('Accept G8 999999001')), { SystemRoot: process.env.SystemRoot }]]) {
    const r = await run(stdin, e);
    assert.equal(r.code, 0); assert.equal(r.out, ''); assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.startsWith('arm-')), []);
  }
});

// Task 16: created ids from ADO creates (PostToolUse).
const { spawnSync } = require('node:child_process');
const live = require('../hooks/lib/live');
const ado = require('../hooks/lib/ado');
const { armOf, ctxOf, tempEnv } = require('./fixtures/arm');
const record = require('../hooks/record');
const state = S;
const wrap = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const post = (tool, action, tool_response, extra = {}) => ({ session_id: 's-test', prompt_id: 'p-test', cwd: 'C:/dev/Projects/BigChange',
  hook_event_name: 'PostToolUse', tool_name: `mcp__azure-devops__${tool}`, tool_input: { action }, tool_response, ...extra });
const armed = (t, text) => {
  const env = tempEnv();
  state.writeArm(env.dataDir, armOf(text));
  t.mock.method(live, 'liveArm', () => state.readArm(env.dataDir, 's-test'));
  return env;
};
const created = (env) => state.readArm(env.dataDir, 's-test').created;
const noLedger = (env) => assert.ok(!fs.existsSync(path.join(env.dataDir, 'ledger.jsonl')));

test('T28 created: a PR create under G8 adds the PR to the arm, the ledger and gates.log', (t) => {
  const env = armed(t, 'Accept G8 999999001');
  record.onPostToolUse(post('repo_pull_request_write', 'create', wrap({ pullRequestId: 999999070, codeReviewId: 999999070 })), env);
  assert.deepStrictEqual(created(env).pr, [999999070]);
  assert.deepStrictEqual(state.readLedger(env.dataDir), [{ prompt_id: 'p-test', kind: 'created', value: 'pr 999999070 999999001', origin: 'human' }]);
  assert.match(fs.readFileSync(path.join(env.workRoot, '999999001', 'gates.log'), 'utf8'), /^\S+Z created pr 999999070 999999001 \(human\)\n$/);
});
test('T3 created: an item create under Create it. records item <n> in the new item\'s folder', (t) => {
  const env = armed(t, 'Create it.');
  record.onPostToolUse(post('wit_work_item_write', 'create', wrap({ id: 999999050, rev: 1 })), env);
  assert.deepStrictEqual(created(env).item, [999999050]);
  assert.deepStrictEqual(state.readLedger(env.dataDir).map((l) => l.value), ['item 999999050']);
  assert.ok(fs.existsSync(path.join(env.workRoot, '999999050', 'gates.log')));
});
test('T28 created: a test case create under G9b records testcase <n> <id>', (t) => {
  const env = armed(t, 'Accept G9b 999999001');
  record.onPostToolUse(post('testplan_test_case_write', 'create', wrap({ id: 999999060 })), env);
  assert.deepStrictEqual(created(env).testcase, [999999060]);
  assert.deepStrictEqual(state.readLedger(env.dataDir).map((l) => l.value), ['testcase 999999060 999999001']);
});
test('T28 created: a bare content array is read the same way', (t) => {
  const env = armed(t, 'Accept G8 999999001');
  record.onPostToolUse(post('repo_pull_request_write', 'create', wrap({ pullRequestId: 999999070 }).content), env);
  assert.deepStrictEqual(created(env).pr, [999999070]);
});
test('T28 created: a response without the id path records nothing', (t) => {
  const env = armed(t, 'Accept G8 999999001');
  record.onPostToolUse(post('repo_pull_request_write', 'create', wrap({ codeReviewId: 1 })), env);
  assert.deepStrictEqual(created(env).pr, []);
  noLedger(env);
});
test('T3 created: an item create with no id found still counts against the one-create limit', (t) => {
  const env = armed(t, 'Create it.');
  record.onPostToolUse(post('wit_work_item_write', 'create', wrap({ rev: 1 })), env);
  assert.deepStrictEqual(created(env).item, [0]);
  noLedger(env);
  const second = { tool_name: 'mcp__azure-devops__wit_work_item_write', tool_input: { action: 'create', workItemType: 'Bug',
    fields: [{ name: 'System.Title', value: 'x' }, { name: 'System.AreaPath', value: 'BigChange\\Finance\\Midas' }] } };
  assert.match(ado.check(second, ctxOf(state.readArm(env.dataDir, 's-test'))), /one item is already created/);
});
test('T28 created: an error, an update, a subagent call or no live arm records nothing', (t) => {
  const env = armed(t, 'Accept G8 999999001'), ok = wrap({ pullRequestId: 999999070 });
  record.onPostToolUse(post('repo_pull_request_write', 'create', { ...ok, isError: true }), env);
  record.onPostToolUse(post('repo_pull_request_write', 'update', ok), env);
  record.onPostToolUse(post('repo_pull_request_write', 'create', ok, { agent_id: 'a1' }), env);
  live.liveArm.mock.mockImplementation(() => null);
  record.onPostToolUse(post('repo_pull_request_write', 'create', ok), env);
  assert.deepStrictEqual(created(env).pr, []);
  noLedger(env);
});
test('T28 created: after recording, ado.check lets G8 link its item to the new PR', (t) => {
  const env = armed(t, 'Accept G8 999999001'), repo = Object.keys(ado.REPO_IDS)[0];
  record.onPostToolUse(post('repo_pull_request_write', 'create', wrap({ pullRequestId: 999999070 })), env);
  const linkPr = { tool_name: 'mcp__azure-devops__wit_work_item_link_write', tool_input: { action: 'link_to_pull_request',
    workItemId: 999999001, pullRequestId: 999999070, repositoryId: ado.REPO_IDS[repo], projectId: 'p' } };
  assert.strictEqual(ado.check(linkPr, ctxOf(state.readArm(env.dataDir, 's-test'), state.readLedger(env.dataDir))), null);
});
test('T28 created: record.js as a child process with no arm prints nothing and writes no ledger', () => {
  const env = tempEnv();
  const r = spawnSync(process.execPath, [RECORD], { encoding: 'utf8', timeout: 5000,
    input: JSON.stringify(post('repo_pull_request_write', 'create', wrap({ pullRequestId: 999999070 }))),
    env: { CLAUDE_PLUGIN_DATA: env.dataDir, MIDAS_SDLC_WORKROOT: env.workRoot, SystemRoot: process.env.SystemRoot } });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  noLedger(env);
});
