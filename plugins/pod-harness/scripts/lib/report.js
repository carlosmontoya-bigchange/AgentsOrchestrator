'use strict';
// Reads the report an agent wrote, and joins the reports of one stage. No model is involved.
const path = require('node:path');

const HEADINGS = ['Summary', 'Did', 'Found', 'Changed files', 'Evidence', 'Open points', 'Next'];
const NOTHING = /^(none\.?|n\/a|-)?$/i;

const item = (line) => line.trim().replace(/^[-*]\s+/, '');

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
  return {
    summary,
    openPoints: body('Open points').filter((line) => !NOTHING.test(line)),
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

// entries: [{ key, agent, model, path, limit, report: parsed | null }]. facts come from scripts (test results, the diff).
function joinStageReport({ id, stage, round, entries, facts, open, next }) {
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

  const points = [...entries.flatMap((e) => (e.report ? e.report.openPoints.map((p) => `${e.key}: ${p}`) : [])), ...open];
  out.push('', '## Open points', '', ...(points.length ? points.map((p) => `- ${p}`) : ['None.']));
  out.push('', '## Next', '', next);
  return out.join('\n') + '\n';
}

module.exports = { HEADINGS, parseReport, lineLimit, joinStageReport };
