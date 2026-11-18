'use strict';
// Reads the recorded transcripts in tests/fixtures/transcripts (task 4). Task 10 reuses it.
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, 'transcripts');
const names = () => fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6));
// Whole lines only, as the guard reads them: a torn last line is skipped.
const entries = (name) => fs.readFileSync(path.join(DIR, `${name}.jsonl`), 'utf8').split('\n').slice(0, -1)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const isPrompt = (e) => e.type === 'user' && !(Array.isArray(e.message.content) && e.message.content.some((b) => b.type === 'tool_result'));
// The prompt entry the fixture is about: the latest prompt's own (non-meta) entry, else its meta entry. Null if none.
function subjectEntry(name) {
  const prompts = entries(name).filter(isPrompt);
  if (!prompts.length) return null;
  const id = prompts.at(-1).promptId;
  if (!id) return null;
  const same = prompts.filter((e) => e.promptId === id);
  return same.find((e) => !e.isMeta) || same[0];
}

module.exports = { names, entries, subjectEntry };
