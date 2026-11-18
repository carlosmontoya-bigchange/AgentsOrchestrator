'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { PassThrough } = require('node:stream');
const guard = require('../hooks/guard');
const rules = require('../hooks/lib/rules');
const live = require('../hooks/lib/live');
const state = require('../hooks/lib/state');
const answers = require('../hooks/lib/answers');
const stdin = require('../hooks/lib/stdin');

const HOOKS = path.join(__dirname, '..', 'hooks');
const H = 'C:/dev/Projects/BigChange/midas-harness';
const call = (tool_name, tool_input) => ({ session_id: 's-999999000', prompt_id: 'p-999999000', cwd: 'C:/dev/Projects/BigChange', permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name, tool_input });
const bash = c => call('Bash', { command: c }), ps = c => call('PowerShell', { command: c });
const norm = s => s.toLowerCase().replace(/\\/g, '/');
const PUSH = 'git -C C:/dev/Projects/BigChange/BigChange.JobFinance push origin feature/999999001-x';
const ADO_WRITE = call('mcp__azure-devops__wit_work_item_write', { action: 'update', id: 999999001, updates: [{ op: 'add', path: '/fields/System.Title', value: 'x' }] });

// T34 reason shape, built from answers.needs so the two never drift
const shape = answers.needs('ACTION', 'RULE', 'FORM').split(/ACTION|RULE|FORM/).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const NEEDS_RE = new RegExp('^' + shape.join('[\\s\\S]+') + '$');
const FILL = s => s.replace(/<n>/g, '1').replace(/<id>/g, '999999000').replace(/<branch>/g, 'feature/999999000-x');
function checkReason(r) {
  assert.match(r, NEEDS_RE);
  const forms = [...r.matchAll(/`([^`]+)`/g)].map(m => FILL(m[1]));
  assert.ok(forms.length > 0 || r.includes('no answer allows this'), r);
  for (const f of forms) assert.ok(answers.parseAnswer(f), `${f} must parse`);
}

// A. Shared stdin table: both readers, in-process
const BIG = JSON.stringify(call('Write', { file_path: 'C:/x/a.txt', content: 'x'.repeat(4 * 1024 * 1024) }));
const chunks = (s, n) => Array.from({ length: Math.ceil(s.length / n) }, (_, i) => s.slice(i * n, (i + 1) * n));
const ROWS = [ // name, writes, end, capMs, expected, minMs, maxMs
  ['complete JSON, stream held open', ['{"a":1}'], false, 1000, '{"a":1}', 0, 150],
  ['BOM then JSON, held open', ['\uFEFF{"a":1}'], false, 1000, '{"a":1}', 0, 150],
  ['JSON split over two writes, held open', ['{"a":', '1}'], false, 1000, '{"a":1}', 0, 150],
  ['empty stream that ends', [], true, 1000, '', 0, 150],
  ['truncated JSON, held open, waits for the cap', ['{"a":'], false, 1000, '{"a":', 900, 1500],
  ['truncated JSON that ends', ['{"a":'], true, 1000, '{"a":', 0, 150],
  ['capMs is honoured', ['{"a":'], false, 200, '{"a":', 180, 600],
  ['4 MB JSON in 64 KB chunks, held open', chunks(BIG, 65536), false, 1000, BIG, 0, 150],
];
for (const [who, read] of [['lib/stdin', stdin.readStdin], ['guard', guard.readStdin]])
  for (const [name, writes, end, cap, want, min, max] of ROWS)
    test(`T61 ${who} readStdin: ${name}`, async () => {
      const s = new PassThrough(), t0 = Date.now(), p = read(s, cap);
      for (const w of writes) s.write(w);
      if (end) s.end();
      const got = await p, ms = Date.now() - t0;
      assert.equal(got, want);
      assert.ok(ms >= min && ms < max, `${ms} ms`);
    });

// B. Fallback, in-process
const DENY = [
  bash(PUSH), bash('claude --version'), ps('& $env:CLAUDE_CODE_EXECPATH -p hi'),
  ps('curl.exe https://dev.azure.com/bigchange/_apis/projects'), bash('npx -y @azure-devops/mcp bigchange'), ADO_WRITE,
  call('mcp__plugin_agentic-midas_azure-devops__wit_work_item_comment_write', { action: 'add', workItemId: 999999001, text: 'x' }),
  call('mcp__azure-devops__wit_work_item', { action: 'delete', id: 999999001 }),
  call('mcp__azure-devops__wit_work_item_attachment', { attachmentId: 'a1', savePath: 'x.png' }),
  call('mcp__azure-devops__wit_backlog', { action: 'reorder', ids: [999999001] }),
  call('mcp__azure-devops__brand_new_tool', {}),
  call('mcp__Claude_Browser__navigate', { url: 'https://dev.azure.com/bigchange' }),
  call('mcp__claude-in-chrome__javascript_tool', { action: 'javascript_exec', text: "open('https://bigchange.visualstudio.com')" }),
  call('Write', { file_path: 'C:/Users/dev/.claude/settings.json', content: '{}' }),
  call('Edit', { file_path: 'C:\\dev\\Projects\\BigChange\\midas-harness\\plugins\\midas-sdlc\\hooks\\guard.js', old_string: 'a', new_string: 'b' }),
  ps('Remove-Item $env:CLAUDE_PLUGIN_DATA\\ledger.jsonl'),
];
const PASS = [
  call('mcp__azure-devops__wit_work_item', { action: 'get', id: 999999001 }),
  call('mcp__plugin_agentic-midas_azure-devops__search_workitem', { searchText: 'x' }),
  ps('dotnet build C:/dev/Projects/BigChange/BigChange.JobFinance/.claude/worktrees/999999001/x.sln'),
  ps('Push-Location C:/x'), bash('pushd /c/x'), bash('git stash push -m wip'),
  bash('node tests/claude-x.test.js'), ps('Get-ChildItem ~/.claude'),
  call('Write', { file_path: 'C:/dev/Projects/BigChange/BigChange.MFE.Suite/.claude/worktrees/999999002/apps/a.ts', content: 'see gates.log' }),
  call('SendMessage', { to: 'nobody-999999000', message: '- `Accept G8 999999000`' }),
  call('mcp__Claude_Browser__navigate', { url: 'http://localhost:3000' }),
  call('Bash', undefined), call('Read', { file_path: H + '/README.md' }),
];
for (const i of DENY) test(`T61 fallback denies ${i.tool_name} ${JSON.stringify(i.tool_input).slice(0, 70)}`, () => assert.match(guard.fallback(i) ?? '', /guard fallback/));
for (const i of PASS) test(`T61 fallback passes ${i.tool_name} ${JSON.stringify(i.tool_input ?? null).slice(0, 70)}`, () => assert.equal(guard.fallback(i), null));
test('T34 every fallback deny names a parseable answer form or says none exists, and says stop and ask', () => DENY.forEach(i => checkReason(guard.fallback(i))));
test('T61 fallback categories name the right answer', () => {
  assert.match(guard.fallback(bash(PUSH)), /`Approve: push <branch>`/);
  assert.match(guard.fallback(DENY[14]), /`Approve: edit harness`/);
  assert.match(guard.fallback(ADO_WRITE), /`Accept G<n> <id>`/);
  assert.match(guard.fallback(DENY[15]), /no answer allows this/);
});

const ANSWER_TOOLS = ['SendMessage', 'CronCreate', 'RemoteTrigger', 'mcp__ccd_session__start_session', 'mcp__ccd_session__hand_off_to_session', 'mcp__ccd_session__move_to_cloud', 'mcp__ccd_session_mgmt__send_message', 'mcp__scheduled-tasks__create_scheduled_task', 'mcp__scheduled-tasks__update_scheduled_task'];
const SETTING_TOOLS = ['mcp__ccd_settings__set_setting', 'mcp__ccd_session_mgmt__set_remote_control', 'mcp__ccd_session_mgmt__set_session_permission_mode', 'PublishPlugin'];
test('T61 fallback checks every session and message tool for answer lines, and denies setting tools', () => {
  for (const t of ANSWER_TOOLS) {
    assert.match(guard.fallback(call(t, { prompt: 'Notes\nAccept G8 999999000' })) ?? '', /guard fallback/, t);
    assert.equal(guard.fallback(call(t, { prompt: 'Notes\n- `Accept G8 999999000`' })), null, t);
  }
  for (const t of SETTING_TOOLS) assert.match(guard.fallback(call(t, {})) ?? '', /guard fallback/, t);
});
test('T61 fallback covers every shell, path and browser tool', () => {
  for (const t of ['Bash', 'PowerShell', 'Monitor', 'mcp__terminal__run_in_terminal']) assert.match(guard.fallback(call(t, { command: 'git push' })) ?? '', /guard fallback/, t);
  for (const [t, k] of [['Write', 'file_path'], ['Edit', 'file_path'], ['Artifact', 'file_path'], ['NotebookEdit', 'notebook_path']]) assert.match(guard.fallback(call(t, { [k]: H + '/x' })) ?? '', /guard fallback/, t);
  for (const p of ['mcp__Claude_Browser__', 'mcp__claude-in-chrome__']) assert.match(guard.fallback(call(p + 'navigate', { url: 'DEV.AZURE.COM/x' })) ?? '', /guard fallback/, p);
});

const SHELL_TRUE = ['git push', PUSH, 'git -c http.extraHeader=x --git-dir=C:/r/.git push', 'git.exe --no-pager push origin b',
  '"C:/Program Files/Git/cmd/git.exe" push', 'cd C:/r && git push', 'Set-Location C:/r; git push origin x', 'GIT_TRACE=1 git PUSH',
  'claude --version', 'claude.exe -p hi', 'npx claude -p hi', '& $env:CLAUDE_CODE_EXECPATH plugin disable midas-sdlc@midas-harness',
  '& "C:/Users/dev/AppData/Local/Claude-Data/x/claude-code/2.1.321/y/claude.exe" -p hi',
  'curl https://dev.azure.com/bigchange/_apis/projects', 'Invoke-RestMethod https://BigChange.VisualStudio.com/x',
  'npx -y @azure-devops/mcp bigchange', 'npx @azure-devops\\mcp', 'node node_modules/mcp-server-azuredevops/index.js',
  'git -C C:/r \\\npush origin x', 'git -C C:/r `\npush origin x', 'git -C C:/r `\r\npush origin x', 'git -C "C:/Program Files/r" push',
  'cmd.exe /c claude -p hi', 'powershell.exe -Command claude -p hi', 'bash -lc "claude -p hi"', 'Start-Process -FilePath claude',
  '& "C:/Program Files/x/claude.exe" -p hi', 'bash -c "git push"'];
const SHELL_FALSE = ['git stash push -m wip', 'git -C C:/r stash push', 'Push-Location C:/x', 'pushd C:/x', 'git -C C:/r status',
  'git log --oneline -5', 'git commit -m "wip"', 'echo pushing',
  'dotnet build C:/dev/Projects/BigChange/BigChange.JobFinance/.claude/worktrees/999999001/x.sln',
  'cd C:/dev/Projects/BigChange/BigChange.MFE.Suite/.claude/worktrees/999999002 && pnpm test',
  'node tests/claude-x.test.js', 'Get-ChildItem ~/.claude', 'grep -rn claude src'];
test('T61 shellDeny is word-based', () => {
  for (const c of SHELL_TRUE) assert.equal(guard.shellDeny(c), true, c);
  for (const c of SHELL_FALSE) assert.equal(guard.shellDeny(c), false, c);
});

const ALWAYS_SAMPLES = ['C:\\Users\\dev\\.claude\\plugins\\data\\midas-sdlc-midas-harness\\arm-s1.json', '$env:CLAUDE_PLUGIN_DATA/ledger.jsonl',
  '${CLAUDE_PLUGIN_DATA}/notes.txt', 'D:/elsewhere/ledger.jsonl', 'arm-abc.json', 'C:/dev/Projects/BigChange/work/999999001/gates.log',
  '~/.claude/shell-snapshots/snapshot-bash.sh', '~/.claude/session-env/abc', 'C:/Users/dev/.claude/projects/C--dev-Projects-BigChange/6bd5ddef.jsonl'];
const HARNESS_SAMPLES = [H + '/plugins/midas-sdlc/hooks/guard.js', '~/.claude/plugins/marketplaces/x.json', '~/.claude/skills/x/SKILL.md',
  'C:/dev/Projects/BigChange/BigChange.JobFinance/.claude/skills/tdd/SKILL.md', 'C:/r/.claude/commands/x.md', 'C:/r/plugins/p/.claude-plugin/plugin.json',
  'C:/r/.claude/settings.json', 'C:/r/.claude/settings.local.json', 'C:/Users/dev/.claude.json', 'C:/r/.mcp.json', 'C:/r/.git/config',
  'C:/r/.git/hooks/pre-push', 'C:/Users/dev/.gitconfig', '~/.config/git/config', '$XDG_CONFIG_HOME/git/config', '~/.bashrc', '~/.bash_profile',
  '~/.profile', '~/Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1', '$PROFILE',
  'HKCU:\\SOFTWARE\\Policies\\ClaudeCode', 'HKEY_CURRENT_USER\\Software\\Policies\\ClaudeCode'];
const LOOKALIKES = ['C:/dev/Projects/BigChange/BigChange.JobFinance/.claude/worktrees/999999001/src/a.cs', 'C:/r/.github/workflows/ci.yml',
  'C:/r/.gitignore', 'C:/Users/dev/.claude/projects/C--dev-Projects-BigChange/memory/x.md', 'C:/r/tests/claude-x.test.js', 'C:/r/farm-data.json'];
const any = (res, s) => res.some(r => r.test(norm(s)));
test('T61 FALLBACK.ALWAYS_RES matches every always-denied spelling', () => ALWAYS_SAMPLES.forEach(s => assert.ok(any(guard.FALLBACK.ALWAYS_RES, s), s)));
test('T61 FALLBACK.HARNESS_RES matches every harness spelling', () => HARNESS_SAMPLES.forEach(s => assert.ok(any(guard.FALLBACK.HARNESS_RES, s), s)));
test('T61 look-alikes match neither list', () => LOOKALIKES.forEach(s => assert.ok(!any([...guard.FALLBACK.ALWAYS_RES, ...guard.FALLBACK.HARNESS_RES], s), s)));

test('T61 FALLBACK.ADO_READS is the read list in ado.json', () => {
  const facts = require('../../../docs/research/2026-11-11-harness-facts/ado.json'), want = {};
  for (const t of facts.write_tools) {
    if (!t.on_servers.includes('azure-devops') || t.read_actions.length === 0) continue;
    if (t.action_param.startsWith('action')) want[t.tool] = t.read_actions; else if (t.write_actions.length === 0) want[t.tool] = null;
  }
  assert.deepStrictEqual(guard.FALLBACK.ADO_READS, want);
});

// C. run() and denyJson
test('T61 run() applies the fallback when the rules fail to load or throw', () => {
  for (const i of [...DENY, ...PASS]) {
    assert.equal(guard.run(i, () => { throw new SyntaxError('broken lib') }), guard.fallback(i));
    assert.equal(guard.run(i, () => ({ decide() { throw new Error('rule bug') } })), guard.fallback(i));
  }
  assert.equal(guard.run(bash(PUSH), () => ({ decide: () => null })), null);
  assert.equal(guard.run(bash('git status'), () => ({ decide: () => 'R' })), 'R');
});
test('T61 denyJson is one deny line and never allow or ask', () => {
  assert.equal(guard.denyJson('r "q"'), '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"r \\"q\\""}}');
});

// D. The real entries through child_process
const GUARD = path.join(HOOKS, 'guard.js'), RECORD = path.join(HOOKS, 'record.js');
const tmpEnv = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'midas-guard-'));
  const env = { CLAUDE_PLUGIN_DATA: path.join(d, 'data'), MIDAS_SDLC_WORKROOT: path.join(d, 'work'), SystemRoot: process.env.SystemRoot };
  fs.mkdirSync(env.CLAUDE_PLUGIN_DATA);
  return env;
};
function runEntry(entry, { raw = '', hold = false, args = [], env = tmpEnv() } = {}) {
  return new Promise(resolve => {
    const t0 = Date.now(); let ms = 0, out = '';
    const c = spawn(process.execPath, [entry, ...args], { env, windowsHide: true });
    const kill = setTimeout(() => c.kill(), 5000); // a hung entry fails the test instead of hanging the run
    c.stdout.on('data', d => (out += d));
    c.stdin.on('error', () => {});
    c.on('exit', () => { ms = Date.now() - t0; clearTimeout(kill); c.stdin.destroy(); });
    c.on('close', code => resolve({ code, stdout: out, ms, env }));
    if (raw) c.stdin.write(raw);
    if (!hold) c.stdin.end();
  });
}
function brokenGuard() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'midas-broken-'));
  fs.cpSync(HOOKS, d, { recursive: true });
  fs.writeFileSync(path.join(d, 'lib', 'rules.js'), 'module.exports = {;\n');
  return path.join(d, 'guard.js');
}
const denyOf = out => JSON.parse(out).hookSpecificOutput.permissionDecisionReason;
let BASE;
before(() => { BASE = Math.min(...[0, 1, 2].map(() => { const t = Date.now(); spawnSync(process.execPath, ['-e', '0'], { windowsHide: true }); return Date.now() - t; })); });

test('T61 broken lib/rules.js: the child denies a push, claude, an ADO write, set_setting and an ADO navigate', async () => {
  const G = brokenGuard();
  for (const i of [bash(PUSH), bash('claude --version'), ADO_WRITE, call('mcp__ccd_settings__set_setting', { key: 'prompt_suggestions', value: false }), call('mcp__Claude_Browser__navigate', { url: 'https://dev.azure.com/bigchange' })]) {
    const r = await runEntry(G, { raw: JSON.stringify(i) });
    assert.equal(r.code, 0);
    assert.match(denyOf(r.stdout), /guard fallback/);
  }
});
test('T61 broken lib/rules.js: reads, worktree builds, Push-Location and git stash push still pass', async () => {
  const G = brokenGuard();
  for (const i of [PASS[0], PASS[2], PASS[3], bash('git stash push'), PASS[6], call('Write', { file_path: 'C:/dev/Projects/BigChange/BigChange.JobFinance/.claude/worktrees/999999001/src/a.cs', content: 'x' })]) {
    const r = await runEntry(G, { raw: JSON.stringify(i) });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', JSON.stringify(i));
  }
});
test('T61 complete JSON with stdin held open answers within node start-up + 150 ms', async () => {
  const r = await runEntry(GUARD, { raw: JSON.stringify(bash('git status')), hold: true });
  assert.equal(r.stdout, '');
  assert.ok(r.ms < BASE + 150, `${r.ms} ms, base ${BASE}`);
});
test('T61 a deny with stdin held open is one complete, flushed line', async () => {
  const r = await runEntry(brokenGuard(), { raw: JSON.stringify(bash(PUSH)), hold: true });
  assert.ok(r.stdout.endsWith('\n'));
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.equal(r.stdout, guard.denyJson(denyOf(r.stdout)) + '\n');
  assert.ok(r.ms < BASE + 150, `${r.ms} ms`);
});
test('T61 BOM-prefixed input is read', async () => {
  const r = await runEntry(brokenGuard(), { raw: '\uFEFF' + JSON.stringify(bash(PUSH)) });
  assert.match(denyOf(r.stdout), /guard fallback/);
});
test('T61 4 MB of Write content with stdin held open', async () => {
  const r = await runEntry(GUARD, { raw: BIG, hold: true });
  assert.equal(r.stdout, '');
  assert.ok(r.ms < BASE + 150, `${r.ms} ms`);
});
test('T61 a 20 MB transcript_path with an arm present stays inside the budget', async () => {
  const env = tmpEnv(), tx = path.join(env.CLAUDE_PLUGIN_DATA, '..', 'big.jsonl');
  const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1000) }] } }) + '\n';
  fs.writeFileSync(tx, line.repeat(Math.ceil(20 * 1024 * 1024 / line.length)));
  state.writeArm(env.CLAUDE_PLUGIN_DATA, { session_id: 's-big', prompt_id: 'p-big', answer: 'Approve: comment 999999001', gate: null, target: { id: 999999001 }, classes: ['comments'], origin: 'human', created: { pr: [], item: [], testcase: [] } });
  const i = { session_id: 's-big', transcript_path: tx, cwd: 'C:/dev/Projects/BigChange', hook_event_name: 'PreToolUse', tool_name: 'mcp__azure-devops__wit_work_item_comment_write', tool_input: { action: 'add', workItemId: 999999001, text: 'x' } };
  const r = await runEntry(GUARD, { raw: JSON.stringify(i), hold: true, env });
  assert.equal(r.code, 0); // output becomes a deny once task 14 lands; only the time is pinned here
  assert.ok(r.ms < BASE + 150, `${r.ms} ms`);
});
for (const [name, raw, hold, min] of [['empty stdin', '', false, 0], ['truncated JSON that ends', '{"tool_name":', false, 0], ['truncated JSON held open', '{"tool_name":', true, 900], ['JSON null', 'null', false, 0], ['an object with no tool_name', '{}', false, 0]])
  test(`T61 ${name} gets one unreadable-input deny`, async () => {
    const r = await runEntry(GUARD, { raw, hold });
    const lines = r.stdout.split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const reason = denyOf(lines[0]);
    assert.match(reason, /unreadable hook input/);
    checkReason(reason);
    assert.ok(r.ms >= min && r.ms < BASE + 1500, `${r.ms} ms`);
  });
test('T61 --shadow prints nothing and logs one would-deny line', async () => {
  const r = await runEntry(brokenGuard(), { raw: JSON.stringify(bash(PUSH)), args: ['--shadow'] });
  assert.equal(r.stdout, '');
  const lines = fs.readFileSync(path.join(r.env.CLAUDE_PLUGIN_DATA, 'shadow.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.deepStrictEqual(Object.keys(lines[0]).sort(), ['head', 'reason', 'session_id', 'tool_name', 'ts']);
  assert.deepStrictEqual([lines[0].session_id, lines[0].tool_name, lines[0].head], ['s-999999000', 'Bash', PUSH.slice(0, 120)]);
  assert.match(lines[0].reason, /guard fallback/);
});
test('T61 --shadow writes nothing for a call it would pass', async () => {
  const r = await runEntry(GUARD, { raw: JSON.stringify(bash('git status')), args: ['--shadow'] });
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(path.join(r.env.CLAUDE_PLUGIN_DATA, 'shadow.jsonl')), false);
});
for (const [name, raw, hold] of [['empty stdin', '', false], ['truncated JSON held open', '{"session_id":', true], ['BOM then garbage', '\uFEFFnot json', false]])
  test(`T61 record.js on ${name}: exit 0, no output, nothing written`, async () => {
    const r = await runEntry(RECORD, { raw, hold });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.deepStrictEqual(fs.readdirSync(r.env.CLAUDE_PLUGIN_DATA), []);
    assert.equal(fs.existsSync(r.env.MIDAS_SDLC_WORKROOT), false);
    assert.ok(r.ms < BASE + 1500, `${r.ms} ms`);
  });

// E. Dispatcher
test('T61 family() uses the hooks.json matchers, anchored', () => {
  const rows = { 'mcp__azure-devops__wit_work_item': 'ado', 'mcp__plugin_agentic-midas_azure-devops__wit_work_item_write': 'ado', 'mcp__agentic-midas__draft_work_item': null,
    Bash: 'shell', PowerShell: 'shell', Monitor: 'shell', mcp__terminal__run_in_terminal: 'shell', BashOutput: null,
    Write: 'path', Edit: 'path', NotebookEdit: 'path', Artifact: 'path', Read: null,
    mcp__Claude_Browser__navigate: 'browser', 'mcp__claude-in-chrome__browser_batch': 'browser',
    ...Object.fromEntries([...ANSWER_TOOLS, ...SETTING_TOOLS].map(t => [t, 'session'])),
    'mcp__scheduled-tasks__list_scheduled_tasks': null, mcp__ccd_session_mgmt__list_sessions: null, CronList: null };
  for (const [n, f] of Object.entries(rows)) assert.equal(rules.family(n), f, n);
});
test('T61 the session family and the tool lists follow the guard design session matcher', () => {
  const gd = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'superpowers', 'specs', '2026-11-11-midas-sdlc-guard-design.md'), 'utf8');
  const row = gd.split('\n').find((l) => l.startsWith('| PreToolUse | `^(SendMessage'));
  const matcher = new RegExp(row.split('`')[1].replace(/\\\|/g, '|'));
  for (const t of [...ANSWER_TOOLS, ...SETTING_TOOLS]) assert.ok(matcher.test(t), t);
  for (const t of ['mcp__ccd_session__move_to_cloud', 'mcp__ccd_session_mgmt__set_session_permission_mode', 'mcp__ccd_session__list_start_targets'])
    assert.equal(rules.family(t) === 'session', matcher.test(t), t);
});
test('T61 decide passes tools outside every family', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'midas-rules-')), i = call('Read', { file_path: 'C:/x' });
  const env = state.envFrom({ CLAUDE_PLUGIN_DATA: path.join(d, 'data'), MIDAS_SDLC_WORKROOT: path.join(d, 'work') }, i);
  assert.equal(rules.decide(i, env), null);
  assert.equal(rules.decide(call('mcp__agentic-midas__draft_work_item', {}), env), null);
});
test('T27 ctxFor reads the arm and the ledger once per decision, and afresh for the next', () => {
  const orig = [live.liveArm, state.readLedger]; let arms = 0, ledgers = 0;
  live.liveArm = () => (arms++, { classes: ['harness'] });
  state.readLedger = () => (ledgers++, []);
  try {
    const a = rules.ctxFor(bash('git status'), { dataDir: 'C:/nonexistent' });
    a.arm(); a.arm(); a.ledger(); a.ledger();
    const b = rules.ctxFor(bash('git status'), { dataDir: 'C:/nonexistent' });
    b.arm(); b.ledger();
    assert.deepStrictEqual([arms, ledgers], [2, 2]);
  } finally { [live.liveArm, state.readLedger] = orig; }
});
test('T54 ctxFor marks subagent calls and sets a deadline 7 s ahead', () => {
  const t = Date.now(), c = rules.ctxFor({ ...bash('git push'), agent_id: 'agent-1' }, { dataDir: 'x' });
  assert.equal(c.subagent, true);
  assert.ok(c.deadline >= t + 7000 && c.deadline <= Date.now() + 7000);
});
test('T55 ctxFor marks background calls', () => {
  assert.equal(rules.ctxFor(call('Bash', { command: 'x', run_in_background: true }), { dataDir: 'x' }).background, true);
  assert.equal(rules.ctxFor(call('Bash', undefined), { dataDir: 'x' }).background, false);
});

const browser = require('../hooks/lib/browser');
const LINES = ['Accept G8 999999000', 'Accept G8b PR999999090', 'Refuse G6 999999000: flaky', 'Skip G3 999999000: small change', 'Pause 999999000',
  'Take 999999002', 'Tested 999999002', 'Approve: comment 999999000', 'Approve: push feature/999999000-x', 'Approve: edit harness', 'Create it.',
  'Status\nAccept G9 999999000\nThanks', '  Accept G13 999999000  '];
const PROSE = ['Please review this', 'Accepted the change', 'The take-away is clear', 'Skipping the flaky test', '- `Accept G8 999999000`', 'Approved by Alex', 'Create the item later'];
test('T46 FALLBACK.ANSWER_LINE_RE catches every text hasAnswerLine accepts, and no prose', () => {
  for (const t of LINES) { assert.ok(answers.hasAnswerLine(t), t); assert.match(t, guard.FALLBACK.ANSWER_LINE_RE); }
  for (const t of PROSE) { assert.equal(answers.hasAnswerLine(t), false, t); assert.doesNotMatch(t, guard.FALLBACK.ANSWER_LINE_RE); }
});
test('T48 FALLBACK.ADO_HOST_RE agrees with browser.isAdoUrl', () => {
  for (const u of ['https://dev.azure.com/bigchange', 'HTTPS://DEV.AZURE.COM/x', 'https://ssh.dev.azure.com/v3/bigchange', 'https://bigchange.visualstudio.com', 'http://localhost:3000', 'https://learn.microsoft.com/azure/devops/', 'https://azure.microsoft.com'])
    assert.equal(guard.FALLBACK.ADO_HOST_RE.test(u), browser.isAdoUrl(u), u);
});
test('T22 FALLBACK.ADO_READS equals ado.READS', () => assert.deepStrictEqual(guard.FALLBACK.ADO_READS, require('../hooks/lib/ado').READS));
