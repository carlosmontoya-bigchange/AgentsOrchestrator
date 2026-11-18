'use strict';
// Transcript builder: the only place the recorded entry key names appear (guard design, Facts).
const fs = require('node:fs');
const path = require('node:path');
const { HUMAN_PLATFORMS } = require('../../hooks/lib/live');

const userPrompt = (promptId, text, extra = {}) => ({ type: 'user', promptId, origin: { kind: 'human' }, clientPlatform: HUMAN_PLATFORMS[0],
  message: { role: 'user', content: text }, ...extra });
// Assistant entries carry no promptId; the id only makes the tool_use id unique.
const toolUse = (promptId) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${promptId}`, name: 'Bash', input: { command: 'git status' } }] } });
const toolResult = (promptId) => ({ type: 'user', promptId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${promptId}`, content: 'ok' }] } });
let n = 0;
const writeTranscript = (dir, entries, partialTail = '') => {
  const file = path.join(dir, `transcript-${process.pid}-${++n}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e) + '\n').join('') + partialTail);
  return file;
};

module.exports = { userPrompt, toolUse, toolResult, writeTranscript };
