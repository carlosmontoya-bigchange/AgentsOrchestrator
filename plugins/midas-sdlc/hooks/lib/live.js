'use strict';
// Arm liveness: does the session's arm still belong to the developer's latest human message?
// Facts and rules: guard design, Answers, Data model, Prompt sources, Facts.
const fs = require('node:fs');
const path = require('node:path');

const HUMAN_PLATFORMS = ['desktop_app', 'ios'];
const CHUNK = 256 * 1024;
const NL = 10;

// Strips exactly one leading app-context block and the note that follows it (recorded form).
const APP_CONTEXT = /^<artifact-view-context[ >][^]*?<\/artifact-view-context>\nThe developer is viewing this artifact in the side pane\.\n\n/;
// Wrappers that mark a machine, pasted or command source when they start the text.
const WRAPPERS = ['<command-message>', '<command-name>', '<task-notification>', '<scheduled-task', '<cross-session-message',
  '<agent-message', '<system-reminder>', '<artifact-view-context', '[Artifact comment sent to Claude]'];

const stripAppContext = (text) => String(text).replace(APP_CONTEXT, '');

const hasToolResult = (e) => Array.isArray(e.message && e.message.content) && e.message.content.some((b) => b && b.type === 'tool_result');

function textOf(e) {
  const c = e.message && e.message.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '';
}

function isHuman(e) {
  if (!e || !e.origin || e.origin.kind !== 'human') return false;
  if (!HUMAN_PLATFORMS.includes(e.clientPlatform) && e.entrypoint !== 'cli') return false;
  const text = stripAppContext(textOf(e));
  // The design puts <pasted_content> after two newlines and possibly after typed words, so it counts anywhere; so does an unstripped app-context block (fail closed).
  return !text.includes('<pasted_content') && !text.includes('<artifact-view-context') && !WRAPPERS.some((w) => text.includes(w));
}

// Walks whole lines from the end of the file, at most maxBytes back. visit(line) returns a value to stop.
// A final line with no newline is dropped; the line cut by maxBytes is never decoded.
function scanBack(file, maxBytes, visit) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return undefined; }
  try {
    const size = fs.fstatSync(fd).size;
    const floor = Math.max(0, size - maxBytes);
    let pos = size, rest = Buffer.alloc(0), dropping = true;
    while (pos > floor) {
      const n = Math.min(CHUNK, pos - floor);
      const buf = Buffer.alloc(n);
      pos -= n;
      fs.readSync(fd, buf, 0, n, pos);
      let data = Buffer.concat([buf, rest]);
      // A last line with no newline is dropped: in the no-prompt_id fallback (which PreToolUse doesn't use) a newer prompt still being written doesn't end the arm.
      if (dropping) {
        const nl = data.lastIndexOf(NL);
        if (nl < 0) { rest = data; continue; }
        data = data.subarray(0, nl + 1);
        dropping = false;
      }
      const head = data.indexOf(NL);
      const start = pos === 0 ? 0 : head + 1;
      for (let end = data.length - 1; end >= start;) {
        const lo = Math.max(end > 0 ? data.lastIndexOf(NL, end - 1) + 1 : 0, start);
        const line = data.toString('utf8', lo, end);
        end = lo - 1;
        if (!line) continue;
        const r = visit(line);
        if (r !== undefined) return r;
      }
      rest = data.subarray(0, head + 1);
    }
    return undefined;
  } finally { fs.closeSync(fd); }
}

const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };

function promptEntry(transcriptPath, promptId, maxBytes = 8388608) {
  if (typeof promptId !== 'string' || !promptId) return null;
  const hit = scanBack(transcriptPath, maxBytes, (line) => {
    if (!line.includes(promptId)) return undefined;
    const e = parse(line);
    return e && e.type === 'user' && !e.isMeta && !hasToolResult(e) && e.promptId === promptId ? e : undefined;
  });
  return hit || null;
}

// The latest user entry that isn't a tool result. Meta and attachment-carrying ones count (design, Data model).
function latestHumanPrompt(transcriptPath) {
  const hit = scanBack(transcriptPath, 8388608, (line) => {
    if (!line.includes('"user"')) return undefined;
    const e = parse(line);
    return e && e.type === 'user' && !hasToolResult(e) ? e : undefined;
  });
  return hit || null;
}

function liveArm(input, env) {
  try {
    if ('agent_id' in input || 'agent_type' in input) return null;
    if (typeof input.session_id !== 'string' || !/^[\w.-]+$/.test(input.session_id)) return null;
    const arm = JSON.parse(fs.readFileSync(path.join(env.dataDir, `arm-${input.session_id}.json`), 'utf8'));
    if (arm.session_id !== input.session_id) return null;
    const id = input.prompt_id !== undefined && input.prompt_id !== null ? String(input.prompt_id) : (latestHumanPrompt(input.transcript_path) || {}).promptId;
    if (typeof arm.prompt_id !== 'string' || id !== arm.prompt_id) return null;
    return isHuman(promptEntry(input.transcript_path, arm.prompt_id)) ? arm : null;
  } catch { return null; }
}

module.exports = { liveArm, promptEntry, latestHumanPrompt, isHuman, stripAppContext, WRAPPERS, HUMAN_PLATFORMS };
