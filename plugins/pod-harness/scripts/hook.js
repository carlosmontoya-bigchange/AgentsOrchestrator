#!/usr/bin/env node
'use strict';
// The plugin's only hook. It records the permission mode Claude reports, so a checkpoint knows how much to ask,
// and after a compaction it reminds the session which task it was on. It never blocks, never fails and prints
// nothing else. In a session with no pod-harness task it reads one small file and exits.
const RECORDS_MODE = ['UserPromptSubmit', 'PreToolUse', 'SubagentStop'];

function handle(input, env) {
  if (!input || typeof input !== 'object') return '';
  // Loaded here, inside the caller's try: a hook that cannot load its code must still exit quietly.
  const { sessionTask, readState, writeMode } = require('./lib/taskstore.js');
  const dir = sessionTask(env, input.session_id);
  if (!dir) return '';
  const state = readState(dir); // throws when the folder holds no readable task: caught below
  if (state.status !== 'running') return '';

  const event = input.hook_event_name;
  if (RECORDS_MODE.includes(event) && typeof input.permission_mode === 'string') {
    // mode.json, never state.json: the stage engine writes that one and the two must not overwrite each other.
    writeMode(dir, { value: input.permission_mode, at: new Date().toISOString(), event, session: input.session_id });
  }
  if (event === 'SessionStart' && input.source === 'compact') {
    return JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `pod-harness task ${state.id} is at stage ${state.stage}. Continue with /pod-harness:resume ${state.id}.`,
    } });
  }
  return '';
}

let text = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { text += chunk; });
process.stdin.on('end', () => {
  try {
    const out = handle(JSON.parse(text), process.env);
    if (out) process.stdout.write(out + '\n');
  } catch { /* a hook must never get in the way of the session */ }
  process.exitCode = 0;
});
process.stdin.on('error', () => { process.exitCode = 0; });
