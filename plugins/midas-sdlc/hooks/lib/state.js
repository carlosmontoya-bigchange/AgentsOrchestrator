'use strict';
// State files under CLAUDE_PLUGIN_DATA (arm, ledger) and the per-item gates.log. Node built-ins only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WORKSPACE = 'C:/dev/Projects/BigChange';
const fwd = (p) => String(p).replace(/\\/g, '/');
const SAFE = /^[\w.-]+$/;

function envFrom(processEnv, input) {
  const dataDir = processEnv.CLAUDE_PLUGIN_DATA;
  if (!dataDir) throw new Error('CLAUDE_PLUGIN_DATA is not set');
  const home = fwd(os.homedir());
  // Tests must never write the developer's real gate record.
  if ((processEnv.NODE_TEST_CONTEXT || process.env.NODE_TEST_CONTEXT) && fwd(dataDir).toLowerCase().startsWith(`${home}/.claude/plugins/data`.toLowerCase())) {
    throw new Error('refusing to use the real plugin data folder under node --test');
  }
  return {
    dataDir, workspace: WORKSPACE, workRoot: processEnv.MIDAS_SDLC_WORKROOT || `${WORKSPACE}/work`,
    harness: `${WORKSPACE}/midas-harness`, home, scratchpad: (input && input.scratchpad_dir) || null,
  };
}

const armFile = (dataDir, sid) => {
  if (typeof sid !== 'string' || !SAFE.test(sid)) throw new Error('bad session_id');
  return path.join(dataDir, `arm-${sid}.json`);
};

function readArm(dataDir, sid) {
  try { return JSON.parse(fs.readFileSync(armFile(dataDir, sid), 'utf8')); } catch { return null; }
}

// Atomic write: a temp file, then a rename; the temp file goes if the rename fails.
function writeAtomic(dataDir, file, text) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } throw e; }
}

function writeArm(dataDir, arm) {
  const file = armFile(dataDir, arm.session_id);
  const { session_id, prompt_id, answer, gate, target, classes, origin, created } = arm;
  writeAtomic(dataDir, file, JSON.stringify({ session_id, prompt_id, answer, gate, target, classes, origin, created }));
}

// The last prompt_id seen per session: a repeat UserPromptSubmit carries the same one.
const lastFile = (dataDir, sid) => { armFile(dataDir, sid); return path.join(dataDir, `last-${sid}.txt`); };
function readLast(dataDir, sid) {
  // Null only when the file is absent; any other read error throws, and the recorder treats that as a repeat.
  return readText(lastFile(dataDir, sid)).trim() || null;
}
function writeLast(dataDir, sid, pid) { writeAtomic(dataDir, lastFile(dataDir, sid), String(pid)); }

function deleteArm(dataDir, sid) {
  try { fs.unlinkSync(armFile(dataDir, sid)); } catch { /* already gone */ }
}

const ledgerFile = (dataDir) => path.join(dataDir, 'ledger.jsonl');
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };

function readLedger(dataDir) {
  const parts = readText(ledgerFile(dataDir)).split('\n');
  const out = [];
  parts.forEach((l, i) => {
    if (!l) return;
    try { out.push(JSON.parse(l)); } catch {
      if (i === parts.length - 1) return; // torn final line: no newline yet
      throw new Error(`ledger.jsonl line ${i + 1} is not JSON`);
    }
  });
  return out;
}

// Dedupes on the raw line text, so a bad line never stops an append. Returns the lines it wrote.
function appendLedger(dataDir, lines) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = ledgerFile(dataDir);
  const text = readText(file);
  const seen = new Set(text.split('\n'));
  const fresh = [];
  for (const l of lines) {
    const raw = JSON.stringify(l);
    if (seen.has(raw)) continue;
    seen.add(raw); fresh.push(l);
  }
  if (!fresh.length) return [];
  if (text && !text.endsWith('\n')) fs.appendFileSync(file, '\n');
  for (const l of fresh) fs.appendFileSync(file, JSON.stringify(l) + '\n');
  return fresh;
}

function appendGatesLog(workRoot, folder, lines, now = new Date()) {
  const norm = (p) => fwd(path.resolve(p)).toLowerCase().replace(/\/$/, '');
  if (process.env.NODE_TEST_CONTEXT && norm(workRoot) === norm(`${WORKSPACE}/work`)) {
    throw new Error('refusing to write the real work folder under node --test');
  }
  if (!/^[\w-]+$/.test(String(folder))) return;
  const dir = path.join(workRoot, String(folder));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString();
  for (const l of lines) fs.appendFileSync(path.join(dir, 'gates.log'), `${stamp} ${l.kind} ${l.value} (${l.origin})\n`);
}

module.exports = { envFrom, readArm, writeArm, readLast, writeLast, deleteArm, readLedger, appendLedger, appendGatesLog };
