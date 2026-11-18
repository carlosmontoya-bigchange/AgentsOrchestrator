'use strict';
// PreToolUse entry. Loads lib/rules.js inside try/catch; if the rules fail to load or throw, its own word-based
// fallback keeps outward actions blocked while local work carries on (R32). Outputs only a deny, or nothing.
// Node built-ins only, and nothing from ./lib outside run's try block.
const fs = require('node:fs');
const path = require('node:path');

const say = (action, rule, needs) => `midas-sdlc blocked ${action}: ${rule}. Needs: ${needs}. Stop and ask the developer; do not try another way.`;
const fb = (action, rule, needs) => say(action, `${rule} (guard fallback; the full rules did not run)`, needs);
const NONE = 'nothing; no answer allows this';
const REPAIRED = 'once the developer has repaired the guard';
const HARNESS_NEEDS = `\`Approve: edit harness\` ${REPAIRED}`;
const ADO_NEEDS = `\`Accept G<n> <id>\`, \`Approve: update <id>\` or \`Approve: comment <id>\` ${REPAIRED}`;
const SHELL_NEEDS = `\`Accept G8 <id>\` or \`Approve: push <branch>\` for a push, ${REPAIRED}; nothing allows the rest`;
const CHECK_GUARD = 'nothing; no answer allows this, so the developer checks the midas-sdlc guard';

const FALLBACK = {
  // The read list in docs/research/2026-11-11-harness-facts/ado.json (server 1); null means every action is a read.
  ADO_READS: {
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
  },
  // One per bullet of the guard design's "Always denied" list, on lowercased text with / separators.
  ALWAYS_RES: [
    /\.claude\/plugins\/data(?![\w.-])|claude_plugin_data|ledger\.jsonl|(?<![\w.-])arm-[^\s/'"]*\.json|gates\.log/,
    /\.claude\/(shell-snapshots|session-env)(?![\w.-])/,
    /\.claude\/projects\/[^\s'"]*\.jsonl/,
  ],
  // One per bullet of the "Harness paths" list. The last bullet (git commands changing the harness tree) is a
  // command rule; in the fallback the tree regex already denies any shell text naming the harness.
  HARNESS_RES: [
    /(?<![\w.@-])midas-harness(?![\w.-])/,
    /\.claude\/(plugins|skills)(?![\w.-])/,
    /\.claude\/(skills|commands)(?![\w.-])|\.claude-plugin/,
    /\.claude\/settings(\.local)?\.json/,
    /\.claude\.json|\.mcp\.json/,
    /(?<![\w.-])\.git\//,
    /\.gitconfig|\.config\/git(?![\w.-])|xdg_config_home\}?\/git(?![\w.-])/,
    /(?<!\w)\.(bashrc|bash_profile|bash_login|profile)(?![\w-])|profile\.ps1|\$profile\b/,
    /software\/policies\/claudecode/,
  ],
  ANSWER_LINE_RE: /^[ \t ]*(?:(?:accept|refuse|skip)\s+g\s*\d|(?:pause|take|tested)\s+#?\d|approve\s*:|create it\b)/im,
  ADO_HOST_RE: /dev\.azure\.com|visualstudio\.com/i,
};

const PATH_TOOLS = /^(Write|Edit|NotebookEdit|Artifact)$/;
const SHELL_TOOLS = /^(Bash|PowerShell|Monitor|mcp__terminal__run_in_terminal)$/;
const ADO_PREFIX = /^mcp__(plugin_agentic-midas_)?azure-devops__/;
const BROWSER = /^mcp__(claude-in-chrome|Claude_Browser)__/;
const ANSWER_TOOLS = new Set(['SendMessage', 'CronCreate', 'RemoteTrigger', 'mcp__ccd_session__start_session', 'mcp__ccd_session__hand_off_to_session',
  'mcp__ccd_session__move_to_cloud', 'mcp__ccd_session_mgmt__send_message', 'mcp__scheduled-tasks__create_scheduled_task', 'mcp__scheduled-tasks__update_scheduled_task']);
const SETTING_TOOLS = new Set(['mcp__ccd_settings__set_setting', 'mcp__ccd_session_mgmt__set_remote_control', 'mcp__ccd_session_mgmt__set_session_permission_mode']);

const norm = (s) => s.toLowerCase().replace(/\\/g, '/');
const str = (v) => typeof v === 'string';
const strings = (v, out = []) => {
  if (str(v)) out.push(v); else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
};

function pathTexts(ti) {
  const out = [ti.file_path, ti.notebook_path, ti.out_dir, ti.root];
  if (Array.isArray(ti.file_paths)) out.push(...ti.file_paths);
  if (ti.files && typeof ti.files === 'object') {
    for (const v of Object.values(ti.files)) out.push(str(v) ? v : v && (v.from ?? v.path));
  }
  return out.filter(str);
}

// Word-based shell check: a git push, starting Claude Code, or reaching Azure DevOps.
const GIT_ARG_OPTS = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source']);
const PREFIX_WORDS = new Set(['env', 'command', 'exec', 'nohup', 'time', 'sudo', 'start', 'start-process', 'saps', 'npx', 'call', 'cmd', '/c',
  'powershell', 'pwsh', 'bash', 'sh', '-c', '-command', '-noprofile']);
const CLAUDE_VARS = new Set(['$env:claude_code_execpath', '${env:claude_code_execpath}', '$claude_code_execpath']);
const base = (w) => w.split(/[/\\]/).pop().replace(/\.exe$/, '');
const isClaude = (w) => base(w) === 'claude' || CLAUDE_VARS.has(w);

function shellDeny(command) {
  if (!str(command)) return false;
  if (FALLBACK.ADO_HOST_RE.test(command) || /@azure-devops[\\/]mcp|mcp-server-azuredevops/i.test(command)) return true;
  // Line continuations (bash \ and PowerShell `) are joined, and ${name} too so the { } split doesn't break a variable apart.
  const text = command.toLowerCase().replace(/[\\`]\r?\n/g, ' ').replace(/\$\{([\w:]+)\}/g, '$$$1');
  for (const part of text.split(/\$\(|&&|\|\||[\n\r;|&(){}]/)) {
    // Quote-aware, so a quoted path with spaces stays one word.
    const words = (part.match(/(?:"[^"]*"?|'[^']*'?|[^\s"'])+/g) || []).map((w) => w.replace(/['"‘’“”`]/g, '')).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      if (base(words[i]) !== 'git') continue;
      let j = i + 1;
      while (j < words.length && words[j].startsWith('-')) j += GIT_ARG_OPTS.has(words[j]) ? 2 : 1;
      if (words[j] === 'push') return true;
    }
    let k = 0;
    while (k < words.length && /^[a-z_][a-z0-9_]*=/.test(words[k])) k++;
    // A launcher (cmd /c, powershell -Command, Start-Process -FilePath, npx ...) denies on any claude word; anything else only on its command word.
    if (k < words.length && (PREFIX_WORDS.has(base(words[k])) ? words.slice(k).some(isClaude) : isClaude(words[k]))) return true;
    // A quoted multi-word argument (bash -c "...") is checked as a command of its own.
    if (words.some((w) => /\s/.test(w) && shellDeny(w))) return true;
  }
  return false;
}

function fallback(input) {
  const tool = String(input.tool_name);
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const isShell = SHELL_TOOLS.test(tool);
  if (PATH_TOOLS.test(tool) || isShell) {
    const texts = (isShell ? [ti.command, ti.cwd].filter(str) : pathTexts(ti)).map(norm);
    if (texts.some((t) => FALLBACK.ALWAYS_RES.some((r) => r.test(t)))) return fb(`${tool} on gate state or a transcript`, 'always-denied path', NONE);
    if (texts.some((t) => FALLBACK.HARNESS_RES.some((r) => r.test(t)))) return fb(`${tool} on a harness or settings path`, 'harness path', HARNESS_NEEDS);
  }
  if (ADO_PREFIX.test(tool)) {
    const name = tool.replace(ADO_PREFIX, '');
    const action = str(ti.action) ? ti.action.toLowerCase() : undefined;
    const reads = FALLBACK.ADO_READS[name];
    const isRead = Object.hasOwn(FALLBACK.ADO_READS, name) && (reads === null || reads.includes(action)) &&
      ti.savePath === undefined && ti.destinationPath === undefined;
    if (!isRead) return fb([tool, ti.action].filter(str).join(' '), 'not on the Azure DevOps read list', ADO_NEEDS);
  }
  if (ANSWER_TOOLS.has(tool) && strings(ti).some((s) => FALLBACK.ANSWER_LINE_RE.test(s))) {
    return fb(`${tool} with an answer line`, 'answers come only from the developer', NONE);
  }
  if (SETTING_TOOLS.has(tool)) return fb(tool, 'app and session settings', HARNESS_NEEDS);
  if (tool === 'PublishPlugin') return fb('PublishPlugin', 'publishing is always blocked', NONE);
  if (BROWSER.test(tool) && FALLBACK.ADO_HOST_RE.test(JSON.stringify(ti))) {
    return fb(`${tool} to Azure DevOps`, 'browser access to Azure DevOps is always blocked', NONE);
  }
  if (isShell && shellDeny(ti.command)) return fb(`${tool} command`, 'it may push, start Claude Code or reach Azure DevOps', SHELL_NEEDS);
  return null;
}

function run(input, loadRules = () => require('./lib/rules')) {
  try { return loadRules().decide(input) || null; } catch { return fallback(input); }
}

const denyJson = (reason) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

// Same semantics as lib/stdin.js: resolves on a complete parse, on 'end', or at capMs ('end' may never fire).
function readStdin(stream = process.stdin, capMs = 1000) {
  return new Promise((resolve) => {
    let buf = '', done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(buf); };
    const timer = setTimeout(finish, capMs);
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      if (buf.charCodeAt(0) === 0xFEFF) buf = buf.slice(1);
      // Only a buffer ending in } is parsed, so a multi-MB input is parsed once, not per chunk.
      if (/\}\s*$/.test(buf.slice(-64))) { try { JSON.parse(buf); finish(); } catch { /* keep reading */ } }
    });
    stream.on('end', finish);
    stream.on('error', finish);
  });
}

async function main(argv = process.argv) {
  const shadow = argv.includes('--shadow');
  let reason = null;
  try {
    const raw = await readStdin(process.stdin, 1000);
    try { process.stdin.destroy(); } catch { /* ignore */ }
    let input = null;
    try { input = JSON.parse(raw); } catch { /* unreadable below */ }
    const readable = input && typeof input === 'object' && str(input.tool_name);
    reason = readable ? run(input) : say('this tool call', 'unreadable hook input', CHECK_GUARD);
    if (shadow && reason) {
      const ti = (readable && input.tool_input) || {};
      const head = String(ti.command ?? ti.file_path ?? ti.notebook_path ?? ti.url ?? '').slice(0, 120);
      const dir = process.env.CLAUDE_PLUGIN_DATA;
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'shadow.jsonl'), JSON.stringify({ ts: new Date().toISOString(), session_id: readable ? input.session_id ?? null : null,
        tool_name: readable ? input.tool_name : null, reason, head }) + '\n');
    }
  } catch {
    reason = say('this tool call', 'guard error', CHECK_GUARD);
  }
  if (reason && !shadow) process.stdout.write(denyJson(reason) + '\n', () => process.exit(0));
  else process.exit(0);
}

if (require.main === module) main();

module.exports = { run, fallback, shellDeny, FALLBACK, denyJson, readStdin, main };
