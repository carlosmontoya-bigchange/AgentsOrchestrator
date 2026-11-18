'use strict';
// UserPromptSubmit recorder: parses the developer's answer, writes the arm, the ledger and gates.log. Never blocks a prompt.
const { parseAnswer, looksLikeAnswer, ANSWER_FORMS } = require('./lib/answers');
const { armFor, describeArm } = require('./lib/gates');
const { toLedger, reasonLine, verifiedLine, itemForPr } = require('./lib/ledger');
const live = require('./lib/live');
const { isHuman, promptEntry, stripAppContext, WRAPPERS } = live;
const S = require('./lib/state');
const { readStdin } = require('./lib/stdin');

// The input carries no origin fields at UserPromptSubmit (guard design, Facts), so origin comes from the text, then the transcript.
function originOf(input, text) {
  try {
    if (text.includes('<pasted_content') || WRAPPERS.some((w) => text.includes(w))) return 'other';
    const entry = promptEntry(input.transcript_path, input.prompt_id);
    return entry ? (isHuman(entry) ? 'human' : 'other') : 'pending';
  } catch { return 'pending'; }
}

// The item folder under work/ that an answer belongs to, or null.
function logFolder(a, ledger) {
  if (!a) return null;
  if (a.id !== undefined) return String(a.id);
  if (a.pr !== undefined) return String(itemForPr(ledger, a.pr) || `PR${a.pr}`);
  if (a.branch !== undefined) { const m = /(^|\/)(\d+)(-|$)/.exec(a.branch); return m ? m[2] : null; }
  return null;
}

const safe = (fn, dflt) => { try { return fn(); } catch { return dflt; } };

function record(input, env) {
  if ('agent_id' in input || 'agent_type' in input) return null;
  const sid = input.session_id;
  if (typeof sid !== 'string' || !/^[\w.-]+$/.test(sid)) return null;
  const pid = typeof input.prompt_id === 'string' && input.prompt_id ? input.prompt_id : null;
  const prev = safe(() => S.readArm(env.dataDir, sid), null);
  // A repeat prompt_id (a notification mid-turn) ends the arm and writes nothing at all. The last id seen
  // catches repeats when no arm exists; the arm compare is defence in depth.
  // An unreadable or unwritable last-id file can't prove the prompt is new, so it counts as a repeat (fail closed).
  let last = null, lastBroken = false;
  if (pid) {
    try { last = S.readLast(env.dataDir, sid); } catch { lastBroken = true; }
    try { S.writeLast(env.dataDir, sid, pid); } catch { lastBroken = true; }
  }
  if (pid && (lastBroken || last === pid || (prev && prev.prompt_id === pid))) { safe(() => S.deleteArm(env.dataDir, sid)); return null; }
  safe(() => S.deleteArm(env.dataDir, sid));
  if (prev && prev.origin === 'pending' && typeof prev.prompt_id === 'string' &&
    safe(() => isHuman(promptEntry(input.transcript_path, prev.prompt_id)), false)) {
    safe(() => S.appendLedger(env.dataDir, [verifiedLine(prev.prompt_id)]));
  }
  const text = stripAppContext(typeof input.prompt === 'string' ? input.prompt : '').trim();
  const a = parseAnswer(text);
  if (!pid) return a || looksLikeAnswer(text) ? 'midas-sdlc: no prompt_id, nothing armed.' : null;
  const origin = originOf(input, text);
  const notes = [];
  const pa = prev && parseAnswer(prev.answer);
  if (!a && text && pa && (pa.kind === 'refuse' || pa.kind === 'pause') && pa.reason === undefined) {
    // A machine message doesn't take the reason slot: keep waiting for the developer's own.
    if (origin === 'other') { safe(() => S.writeArm(env.dataDir, prev)); return null; }
    const line = reasonLine(prev, text, pid, origin);
    if (line) {
      const ledger = safe(() => S.readLedger(env.dataDir), []);
      const fresh = S.appendLedger(env.dataDir, [line]);
      const folder = logFolder(pa, ledger);
      if (folder && fresh.length) S.appendGatesLog(env.workRoot, folder, fresh);
      notes.push(`midas-sdlc: recorded the reason for "${prev.answer}".`);
    }
  }
  if (a) {
    const fresh = S.appendLedger(env.dataDir, toLedger(a, pid, origin));
    let ledger;
    try { ledger = S.readLedger(env.dataDir); } catch (e) {
      return `midas-sdlc: the gate record could not be read (${e.message}); nothing armed. The developer fixes ledger.jsonl as the README says.`;
    }
    const folder = logFolder(a, ledger);
    if (folder && fresh.length) safe(() => S.appendGatesLog(env.workRoot, folder, fresh));
    if (origin === 'other') return `midas-sdlc: recorded "${text}" from a source that is not the developer; nothing armed.`;
    const { gate, target, classes } = armFor(a, ledger);
    const arm = { session_id: sid, prompt_id: pid, answer: a.text, gate, target, classes, origin, created: { pr: [], item: [], testcase: [] } };
    S.writeArm(env.dataDir, arm);
    return describeArm(arm);
  }
  if (looksLikeAnswer(text)) notes.push(`midas-sdlc: '${text.slice(0, 200)}' is not an answer, nothing armed. Forms: ${ANSWER_FORMS}`);
  return notes.join(' ') || null;
}

// Never throws: a recorder fault must not reach the prompt.
function onPrompt(input, env) {
  try { return record(input, env); } catch { return null; }
}

// PostToolUse: an ADO create's returned id goes into the arm (so the guard lets the follow-up link through), the ledger and gates.log.
const ID_PATHS = { repo_pull_request_write: 'pullRequestId', wit_work_item_write: 'id', testplan_test_case_write: 'id' };
const KINDS = { repo_pull_request_write: 'pr', wit_work_item_write: 'item', testplan_test_case_write: 'testcase' };
const CREATE_TOOL = /^mcp__azure-devops__(repo_pull_request_write|wit_work_item_write|testplan_test_case_write)$/;

// The tool_response is {content:[...]} or the content array itself; the id sits in the JSON text block.
function idOf(resp, key) {
  const blocks = Array.isArray(resp) ? resp : resp && Array.isArray(resp.content) ? resp.content : [];
  for (const b of blocks) {
    if (!b || b.type !== 'text' || typeof b.text !== 'string') continue;
    let v;
    try { v = JSON.parse(b.text)[key]; } catch { continue; }
    if (typeof v === 'string' && /^\d+$/.test(v)) v = Number(v);
    if (Number.isSafeInteger(v) && v > 0) return v;
  }
  return null;
}

function recordCreate(input, env) {
  if ('agent_id' in input || 'agent_type' in input) return;
  const m = CREATE_TOOL.exec(input.tool_name);
  if (!m) return;
  const ti = input.tool_input;
  if (!ti || String(ti.action).toLowerCase() !== 'create' || (input.tool_response && input.tool_response.isError === true)) return;
  const arm = live.liveArm(input, env);
  if (!arm) return;
  const kind = KINDS[m[1]], n = idOf(input.tool_response, ID_PATHS[m[1]]);
  if (n === null) {
    // An item create with no readable id still counts against the one-create rule.
    if (kind === 'item') { arm.created.item.push(0); S.writeArm(env.dataDir, arm); }
    return;
  }
  const tid = arm.target && arm.target.id;
  if (kind !== 'item' && tid == null) return;
  arm.created[kind].push(n);
  S.writeArm(env.dataDir, arm);
  const value = kind === 'item' ? `item ${n}` : `${kind} ${n} ${tid}`;
  const lines = S.appendLedger(env.dataDir, [{ prompt_id: arm.prompt_id, kind: 'created', value, origin: 'human' }]);
  if (lines.length) S.appendGatesLog(env.workRoot, String(tid ?? n), lines);
}

// Never throws: a recorder fault must not reach the tool result.
function onPostToolUse(input, env) {
  try { recordCreate(input, env); } catch { /* ignore */ }
}

async function main() {
  let out = '';
  try {
    const input = JSON.parse(await readStdin(process.stdin, 1000));
    if (input && input.hook_event_name === 'PostToolUse') onPostToolUse(input, S.envFrom(process.env, input));
    else if (input && input.hook_event_name === 'UserPromptSubmit') {
      const note = onPrompt(input, S.envFrom(process.env, input));
      if (note) out = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note } });
    }
  } catch { /* swallow: never block a prompt */ }
  try { process.stdin.destroy(); } catch { /* ignore */ }
  if (out) process.stdout.write(out, () => process.exit(0)); else process.exit(0);
}

if (require.main === module) main();

module.exports = { onPrompt, onPostToolUse, main };
