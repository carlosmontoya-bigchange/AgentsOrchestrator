'use strict';
// Rule dispatcher: picks the family by tool name (the hooks.json matchers) and runs that family's module.
const live = require('./live');
const state = require('./state');

// Copied exactly from the guard design's Hooks table.
const FAMILIES = [
  ['ado', /^mcp__(plugin_agentic-midas_)?azure-devops__.*$/],
  ['shell', /^(Bash|PowerShell|Monitor|mcp__terminal__run_in_terminal)$/],
  ['path', /^(Write|Edit|NotebookEdit|Artifact)$/],
  ['browser', /^mcp__(claude-in-chrome|Claude_Browser)__.*$/],
  ['session', /^(SendMessage|CronCreate|RemoteTrigger|PublishPlugin|mcp__ccd_session__(start_session|hand_off_to_session|move_to_cloud)|mcp__ccd_session_mgmt__(send_message|set_remote_control|set_session_permission_mode)|mcp__ccd_settings__set_setting|mcp__scheduled-tasks__(create|update)_scheduled_task)$/],
];
const MODULES = { ado: './ado', shell: null, path: null, browser: './browser', session: './session' }; // tasks 29, 30 set './shell' and './path'

function family(toolName) {
  const hit = FAMILIES.find(([, rx]) => rx.test(String(toolName)));
  return hit ? hit[0] : null;
}

// One Ctx per decision: the arm and the ledger are read at most once each, and afresh for the next decision.
function ctxFor(input, env) {
  const once = (fn) => { let done = false, v; return () => (done ? v : (v = fn(), done = true, v)); }; // a throw is not cached
  return {
    env,
    subagent: !!input.agent_id,
    background: !!(input.tool_input && input.tool_input.run_in_background),
    deadline: Date.now() + 7000,
    arm: once(() => live.liveArm(input, env)),
    ledger: once(() => state.readLedger(env.dataDir)),
  };
}

function decide(input, env) {
  const f = family(input.tool_name);
  if (!f || !MODULES[f]) return null;
  env = env || state.envFrom(process.env, input);
  // Required per call so a broken family module can't take the others down.
  return require(MODULES[f]).check(input, ctxFor(input, env));
}

module.exports = { decide, family, ctxFor };
