'use strict';
// Test-only arm, ctx and ledger-line builders for the ADO rules (tasks 14-16). Never touches the real plugin data or work folders.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const gates = require('../../hooks/lib/gates');
const answers = require('../../hooks/lib/answers');

const fwd = (p) => p.replace(/\\/g, '/');
const tmp = () => fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'midas-sdlc-')));

function tempEnv() {
  return { dataDir: tmp(), workRoot: tmp(), workspace: 'C:/dev/Projects/BigChange', harness: 'C:/dev/Projects/BigChange/midas-harness', home: fwd(os.homedir()), scratchpad: null };
}

function armOf(text, ledger = [], created = {}) {
  const a = answers.parseAnswer(text);
  if (!a) throw new Error(`not an answer: ${text}`);
  return { session_id: 's-test', prompt_id: 'p-test', answer: text, ...gates.armFor(a, ledger), origin: 'human', created: { pr: [], item: [], testcase: [], ...created } };
}

let env;
function ctxOf(arm, ledger = [], extra = {}) {
  env = env || tempEnv();
  return { env, subagent: false, background: false, deadline: Date.now() + 7000, arm: () => arm, ledger: () => ledger, ...extra };
}

const line = (kind, value, origin = 'human', promptId = 'p-old') => ({ prompt_id: promptId, kind, value, origin });

module.exports = { tempEnv, armOf, ctxOf, line };
