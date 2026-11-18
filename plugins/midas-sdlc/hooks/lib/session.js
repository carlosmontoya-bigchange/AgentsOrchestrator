'use strict';
// Session family: answer lines never travel in messages or schedules (build check 3), settings need a live
// edit-harness arm and never a subagent, and publishing a plugin is always blocked (R56).
const answers = require('./answers');

const ANSWER_TOOLS = new Set(['SendMessage', 'mcp__ccd_session__start_session', 'mcp__ccd_session__hand_off_to_session', 'mcp__ccd_session__move_to_cloud',
  'mcp__ccd_session_mgmt__send_message', 'CronCreate', 'RemoteTrigger', 'mcp__scheduled-tasks__create_scheduled_task', 'mcp__scheduled-tasks__update_scheduled_task']);
const SETTING_TOOLS = new Set(['mcp__ccd_settings__set_setting', 'mcp__ccd_session_mgmt__set_session_permission_mode', 'mcp__ccd_session_mgmt__set_remote_control']);

const anyString = (v, pred) => typeof v === 'string' ? pred(v) : !!v && typeof v === 'object' && Object.values(v).some((x) => anyString(x, pred));

function check(input, ctx) {
  const t = input.tool_name;
  if (ANSWER_TOOLS.has(t)) {
    return anyString(input.tool_input, answers.hasAnswerLine)
      ? answers.needs(`${t} with an answer line`, 'answers reach the harness only from the developer (R25)', 'nothing; no answer allows this, so send it without the answer line') : null;
  }
  if (SETTING_TOOLS.has(t)) {
    if (ctx.subagent) return answers.needs(t, 'a subagent never changes app or session settings (R28)', 'nothing; no answer allows this, so the main session asks the developer');
    const arm = ctx.arm();
    return arm && arm.classes && arm.classes.includes('harness') ? null
      : answers.needs(t, 'app and session settings change only under an edit-harness approval (R24)', '`Approve: edit harness`');
  }
  if (t === 'PublishPlugin') return answers.needs('PublishPlugin', 'publishing a plugin is always blocked (R56)', 'nothing; no answer allows this');
  return null;
}

module.exports = { check };
