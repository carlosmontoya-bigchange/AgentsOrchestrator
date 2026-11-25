'use strict';
// Reads the report an agent wrote, and joins the reports of one stage. No model is involved.
const path = require('node:path');

// Questions: what a person must decide for this work. Notes: what a person should know later. Only questions
// decide whether a checkpoint is asked in Auto.
const HEADINGS = ['Summary', 'Did', 'Found', 'Changed files', 'Evidence', 'Questions', 'Notes', 'Next'];
// "None" in the forms a model writes it: alone, or followed by punctuation and a remark. "None of the tests..."
// is a real line and is kept: a line kept by mistake costs one question, a line dropped by mistake loses one.
// A line that asks something is never nothing, however it starts: "None, but should the index be unique?".
const NOTHING = /^(?:-|(?:no|none(?: (?:at this time|needed|identified|found|required|known|so far))?|nothing(?: (?:to (?:decide|note|add|report)|else|further))?|n\/a|no(?: open| further| outstanding)? (?:questions?|notes?))(?:\s*[.!:;,].*)?)?$/i;
// The marks a model puts around the word: *None*, _None._, (none).
const bare = (line) => line.replace(/^[\s*_(]+|[\s*_)]+$/g, '');
const nothing = (line) => !line.includes('?') && NOTHING.test(bare(line));

const item = (line) => line.trim().replace(/^[-*]\s+/, '');

// Drops a line that is already there in another case or spacing. The first spelling is kept.
function unique(list) {
  const seen = new Set();
  return list.filter((line) => {
    const key = line.trim().toLowerCase().replace(/\s+/g, ' ');
    return !seen.has(key) && seen.add(key);
  });
}

// A marker starts its line. A list bullet, bold marks and the endings a model adds ("approved", "passed") are
// let through: a marker that is not recognised is read as the careful answer and costs a whole loop.
const marker = (label, values) => new RegExp(`^\\s*(?:[-*]\\s+)?\\**\\s*${label}\\s*:[\\s*]*(${values})`, 'i');
const SENSITIVE = marker('sensitive change', 'yes\\b|no\\b');
const RESULT = marker('result', 'pass(?:ed|es)?\\b|fail(?:ed|s)?\\b');
const VERDICT = marker('verdict', 'approve[ds]?\\b|changes?\\b');
const EXCEPTION = marker('policy exception', '.+?\\s*$');
const NO_EXCEPTION = /^(none\.?|n\/a|no\.?|-)$/i;

// "approved" is approve, "passed" is pass, "change" is changes.
function plain(value) {
  const word = value.toLowerCase();
  for (const [start, answer] of [['pass', 'pass'], ['fail', 'fail'], ['approve', 'approve'], ['change', 'changes']]) {
    if (word.startsWith(start)) return answer;
  }
  return word;
}

function parseReport(text) {
  const lines = String(text).replace(/\s+$/, '').split(/\r?\n/);
  const sections = new Map();
  let current = null;
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      current = m[1].toLowerCase();
      if (!sections.has(current)) sections.set(current, []);
    } else if (current !== null) sections.get(current).push(line);
  }
  const body = (heading) => (sections.get(heading.toLowerCase()) || []).map(item).filter((line) => line !== '');

  // When a marker is written twice with two answers, the careful one counts.
  const answers = (re) => lines.flatMap((line) => { const m = re.exec(line); return m ? [plain(m[1].trim())] : []; });
  const careful = (re, wary) => { const all = answers(re); return all.includes(wary) ? wary : all[0]; };
  const exceptions = lines.flatMap((line) => { const m = EXCEPTION.exec(line); return m ? [m[1].replace(/\*+$/, '').trim()] : []; });
  const markers = { exceptions: exceptions.filter((x) => !NO_EXCEPTION.test(x)) };
  for (const [key, re, wary] of [['sensitive', SENSITIVE, 'yes'], ['result', RESULT, 'fail'], ['verdict', VERDICT, 'changes']]) {
    const value = careful(re, wary);
    if (value !== undefined) markers[key] = value;
  }

  const summary = body('Summary');
  const problems = HEADINGS.filter((h) => !sections.has(h.toLowerCase())).map((h) => `The report has no "## ${h}" heading.`);
  if (summary.length > 5) problems.push(`The Summary has ${summary.length} lines. Five at most.`);
  const real = (heading) => body(heading).filter((line) => !nothing(line));
  // A model may keep the heading of the earlier version. Its lines are read as questions: the careful reading.
  const asked = sections.has('questions') ? real('Questions') : real('Open points');
  return {
    summary,
    // A policy exception is a marker of its own and is asked through its own checkpoint.
    questions: asked.filter((line) => !EXCEPTION.test(line)),
    notes: real('Notes'),
    markers,
    lines: lines.length === 1 && lines[0] === '' ? 0 : lines.length,
    problems,
  };
}

function lineLimit(config, model) {
  const reports = config.reports || {};
  return model === 'opus' ? reports.opus_lines : reports.sonnet_lines;
}

const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const title = (stage) => stage.charAt(0).toUpperCase() + stage.slice(1);

// What a stage leaves for the developer: the agents' own questions and notes first, then the stage's, each once.
// No agent name stands in front: the Agents section of the stage report says who wrote what.
function stagePoints(entries, questions, notes) {
  const from = (key) => entries.flatMap((e) => (e.report ? e.report[key] : []));
  return { questions: unique([...from('questions'), ...questions]), notes: unique([...from('notes'), ...notes]) };
}

// entries: [{ key, agent, model, path, limit, report: parsed | null }]. facts come from scripts (test results, the diff).
function joinStageReport({ id, stage, round, entries, facts, questions, notes, next }) {
  const out = [
    `# ${title(stage)} report, task ${id}`, '',
    `Round ${round}. Agents: ${entries.length ? entries.map((e) => `${e.key} (${e.model})`).join(', ') : 'none'}.`,
    'Tokens: not measured in this version.',
  ];
  if (facts.length) out.push('', ...facts.map((f) => `- ${f}`));

  out.push('', '## Agents', '');
  if (entries.length === 0) out.push('No agent ran in this stage.');
  entries.forEach((e, i) => {
    if (i > 0) out.push('');
    const file = path.basename(e.path);
    out.push(`### ${e.key}`, '', ...(e.report ? [...(e.report.summary.length ? e.report.summary : ['No summary.']), '', `Report: [${file}](${file})`] : ['No report.']));
  });

  const problems = entries.flatMap((e) => {
    if (!e.report) return [`${e.key} wrote no report.`];
    const found = e.report.problems.map((p) => `${e.key}: ${lowerFirst(p)}`);
    if (e.report.lines > e.limit) found.push(`${e.key}: the report has ${e.report.lines} lines. The limit is ${e.limit}.`);
    return found;
  });
  if (problems.length) out.push('', '## Report problems', '', ...problems.map((p) => `- ${p}`));

  const points = stagePoints(entries, questions, notes);
  const listed = (lines) => (lines.length ? lines.map((p) => `- ${p}`) : ['None.']);
  out.push('', '## Questions', '', ...listed(points.questions), '', '## Notes', '', ...listed(points.notes));
  out.push('', '## Next', '', next);
  return out.join('\n') + '\n';
}

module.exports = { HEADINGS, parseReport, lineLimit, joinStageReport, unique, stagePoints };
