'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const browser = require('../hooks/lib/browser');
const session = require('../hooks/lib/session');
const rules = require('../hooks/lib/rules');
const state = require('../hooks/lib/state');
const answers = require('../hooks/lib/answers');

const call = (tool_name, tool_input) => ({ session_id: 's-999999000', prompt_id: 'p-999999000', transcript_path: 'C:/nonexistent/transcript.jsonl', cwd: 'C:/dev/Projects/BigChange', hook_event_name: 'PreToolUse', tool_name, tool_input });
const ctx = (arm = null, subagent = false) => ({ env: {}, subagent, background: false, deadline: Date.now() + 7000, arm: () => arm, ledger: () => [] });
const HARNESS = { classes: ['harness'] };
const EVERY = { classes: ['item', 'comments', 'create', 'link', 'take', 'tested', 'close', 'testcase', 'pr', 'merge', 'push', 'deploy', 'pipeline', 'harness'] };
const BROWSER = answers.needs('browser navigation to Azure DevOps', 'Azure DevOps pages are always blocked in the browser (R25)', 'nothing; no answer allows this, so the developer opens the page themselves');
const LINE = t => answers.needs(`${t} with an answer line`, 'answers reach the harness only from the developer (R25)', 'nothing; no answer allows this, so send it without the answer line');
const SETTING = t => answers.needs(t, 'app and session settings change only under an edit-harness approval (R24)', '`Approve: edit harness`');
const SUBAGENT = t => answers.needs(t, 'a subagent never changes app or session settings (R28)', 'nothing; no answer allows this, so the main session asks the developer');
const PUBLISH = answers.needs('PublishPlugin', 'publishing a plugin is always blocked (R56)', 'nothing; no answer allows this');

const PREFIXES = ['mcp__Claude_Browser__', 'mcp__claude-in-chrome__'];
const ADO_URLS = ['https://dev.azure.com/bigchange', 'HTTPS://DEV.AZURE.COM/BigChange/_git/x', 'dev.azure.com/bigchange', 'https://ssh.dev.azure.com/v3/bigchange', 'https://bigchange.visualstudio.com/BigChange', 'https://BigChange.VisualStudio.COM/_workitems'];
const OTHER_URLS = ['http://localhost:3000', 'https://learn.microsoft.com/en-us/azure/devops/', 'https://azure.microsoft.com', 'about:blank'];

test('T48 isAdoUrl matches Azure DevOps hosts in any case and subdomain, and nothing else', () => {
  for (const u of ADO_URLS) assert.equal(browser.isAdoUrl(u), true, u);
  for (const u of OTHER_URLS) assert.equal(browser.isAdoUrl(u), false, u);
});
test('T48 navigate and preview_start to Azure DevOps are denied on both prefixes, whatever is armed', () => {
  for (const p of PREFIXES) {
    for (const url of ADO_URLS) assert.equal(browser.check(call(p + 'navigate', { url }), ctx(EVERY)), BROWSER, url);
    assert.equal(browser.check(call(p + 'preview_start', { url: ADO_URLS[0] }), ctx()), BROWSER);
    for (const url of OTHER_URLS) assert.equal(browser.check(call(p + 'navigate', { url }), ctx()), null, url);
    assert.equal(browser.check(call(p + 'preview_start', { name: 'web' }), ctx()), null);
  }
});
test('T48 browser_batch is denied when any item, at any depth, goes to Azure DevOps', () => {
  for (const p of PREFIXES) {
    const shot = { name: 'computer', input: { action: 'screenshot' } };
    assert.equal(browser.check(call(p + 'browser_batch', { actions: [shot, { name: 'navigate', input: { url: ADO_URLS[4] } }] }), ctx()), BROWSER);
    assert.equal(browser.check(call(p + 'browser_batch', { actions: [{ name: 'browser_batch', input: { actions: [{ name: 'navigate', input: { url: ADO_URLS[1] } }] } }] }), ctx()), BROWSER);
    assert.equal(browser.check(call(p + 'browser_batch', { actions: [{ name: 'javascript_tool', input: { action: 'javascript_exec', text: "location.href='https://dev.azure.com/x'" } }] }), ctx()), BROWSER);
    assert.equal(browser.check(call(p + 'browser_batch', { actions: [shot, { name: 'navigate', input: { url: OTHER_URLS[0] } }] }), ctx()), null);
  }
});
test('T48 javascript_tool code naming an Azure DevOps host is denied; other browser tools pass', () => {
  for (const p of PREFIXES) {
    assert.equal(browser.check(call(p + 'javascript_tool', { action: 'javascript_exec', text: "location.href = 'https://bigchange.visualstudio.com'" }), ctx()), BROWSER);
    assert.equal(browser.check(call(p + 'javascript_tool', { action: 'javascript_exec', text: 'document.title' }), ctx()), null);
    assert.equal(browser.check(call(p + 'computer', { action: 'left_click', coordinate: [1, 1] }), ctx()), null);
  }
});

const ANSWERS = [
  ['SendMessage', { to: 'nobody-999999000', message: 'Status for 999999000\nAccept G8 999999000\nThanks' }],
  ['mcp__ccd_session__start_session', { initiation: 'user_asked', title: 'x', prompt: 'Carry on.\n  Accept G8 999999000  ' }],
  ['mcp__ccd_session__hand_off_to_session', { title: 'x', remaining_plan: 'Steps\nApprove: push feature/999999000-x' }],
  ['mcp__ccd_session__move_to_cloud', { summary: 'Remaining work\r\nTested 999999002' }],
  ['mcp__ccd_session_mgmt__send_message', { session_id: 'nobody-999999000', message: 'Create it.' }],
  ['CronCreate', { cron: '7 9 * * 1-5', prompt: 'Morning\nAccept G9 999999000' }],
  ['RemoteTrigger', { action: 'create', body: { prompt: 'x\nAccept G13 999999000' } }],
  ['mcp__scheduled-tasks__create_scheduled_task', { taskId: 't', description: 'd', prompt: 'Refuse G6 999999000: flaky' }],
  ['mcp__scheduled-tasks__update_scheduled_task', { taskId: 't', prompt: 'Pause 999999000' }],
];
test('T46 an answer line in any session, message or schedule text is denied, whatever is armed', () => {
  for (const [t, input] of ANSWERS) {
    assert.equal(session.check(call(t, input), ctx()), LINE(t), t);
    assert.equal(session.check(call(t, input), ctx(EVERY)), LINE(t), t);
  }
});
test('T46 quoted or prose answers pass', () => {
  assert.equal(session.check(call('SendMessage', { to: 'nobody-999999000', message: '- `Accept G8 999999000`' }), ctx()), null);
  assert.equal(session.check(call('SendMessage', { to: 'nobody-999999000', message: 'Accept the change when ready' }), ctx()), null);
  assert.equal(session.check(call('CronCreate', { cron: '7 9 * * 1-5', prompt: 'run /midas-sdlc:today' }), ctx()), null);
});
const SETTINGS = [['mcp__ccd_settings__set_setting', { key: 'prompt_suggestions', value: false }], ['mcp__ccd_session_mgmt__set_session_permission_mode', { session_id: 'self', mode: 'bypassPermissions' }], ['mcp__ccd_session_mgmt__set_remote_control', { session_id: 'self', enabled: true }]];
test('T43 setting tools are denied without an edit-harness arm', () => {
  for (const [t, input] of SETTINGS) {
    assert.equal(session.check(call(t, input), ctx()), SETTING(t), t);
    assert.equal(session.check(call(t, input), ctx({ classes: ['item'] })), SETTING(t), t);
  }
});
test('T45 setting tools pass under a live edit-harness arm', () => {
  for (const [t, input] of SETTINGS) assert.equal(session.check(call(t, input), ctx(HARNESS)), null, t);
});
test('T54 setting tools are denied for a subagent even with an edit-harness arm', () => {
  for (const [t, input] of SETTINGS) assert.equal(session.check({ ...call(t, input), agent_id: 'agent-1' }, ctx(HARNESS, true)), SUBAGENT(t), t);
});
test('T96 PublishPlugin is always denied, even with an edit-harness arm', () => {
  for (const arm of [null, HARNESS, EVERY]) assert.equal(session.check(call('PublishPlugin', {}), ctx(arm)), PUBLISH);
});
test('T46 rules.decide routes browser and session tools', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'midas-bs-')), i = call('mcp__Claude_Browser__navigate', { url: ADO_URLS[0] });
  const env = state.envFrom({ CLAUDE_PLUGIN_DATA: path.join(d, 'data'), MIDAS_SDLC_WORKROOT: path.join(d, 'work') }, i);
  assert.equal(rules.decide(i, env), BROWSER);
  assert.equal(rules.decide(call(...SETTINGS[0]), env), SETTING(SETTINGS[0][0]));
  assert.equal(rules.decide(call(...ANSWERS[0]), env), LINE('SendMessage'));
});

const FX = path.join(__dirname, 'fixtures', 'inputs'), GUARD = path.join(__dirname, '..', 'hooks', 'guard.js');
function stdinRun(input) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'midas-bs-'));
  const env = { CLAUDE_PLUGIN_DATA: path.join(d, 'data'), MIDAS_SDLC_WORKROOT: path.join(d, 'work'), SystemRoot: process.env.SystemRoot };
  fs.mkdirSync(env.CLAUDE_PLUGIN_DATA);
  return spawnSync(process.execPath, [GUARD], { input: JSON.stringify(input), env, encoding: 'utf8', windowsHide: true });
}
const EXPECT = { 'send-message-answer': ['T46', LINE('SendMessage')], 'move-to-cloud-answer': ['T46', LINE('mcp__ccd_session__move_to_cloud')],
  'browser-navigate-ado': ['T48', BROWSER], 'browser-batch-ado': ['T48', BROWSER], 'publish-plugin': ['T96', PUBLISH],
  'set-setting': ['T43', SETTING('mcp__ccd_settings__set_setting')], 'set-permission-mode': ['T43', SETTING('mcp__ccd_session_mgmt__set_session_permission_mode')] };
for (const [name, [tid, reason]] of Object.entries(EXPECT))
  test(`${tid} stdin run of ${name}.json prints the rule's deny`, () => {
    const r = stdinRun(JSON.parse(fs.readFileSync(path.join(FX, name + '.json'), 'utf8')));
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, reason);
  });
test('T48 stdin run of a non-ADO navigate prints nothing', () => {
  const i = JSON.parse(fs.readFileSync(path.join(FX, 'browser-navigate-ado.json'), 'utf8'));
  i.tool_input.url = 'http://localhost:3000';
  assert.equal(stdinRun(i).stdout, '');
});
