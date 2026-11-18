'use strict';
// Gate-answer grammar. Pure: no I/O, no dependencies.

const GATE = '(G(?:1[0-3]|[0-9]|8b|9b))';
const ID = '([1-9][0-9]{0,9})';
const PRG = `PR${ID}`;
const REASON = ':\\s*(\\S.*)';
const re = (s) => new RegExp(`^${s}$`, 'i');

const canonGate = (g) => 'G' + g.slice(1).toLowerCase();
const withReason = (text, reason) => (reason === undefined ? text : `${text}: ${reason}`);

function validBranch(b) {
  return /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(b) && !b.includes('..') && !b.includes('//') &&
    !/[/.]$/.test(b) && !/^refs\//i.test(b) && !/^HEAD$/i.test(b);
}

const num = (s) => Number(s);
const clean = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; };

// Each form: [regex, builder(match) -> Answer fields or null]
const FORMS = [
  [re(`Accept ${GATE} ${ID}`), (m) => ({ kind: 'accept', gate: canonGate(m[1]), id: num(m[2]), t: `Accept ${canonGate(m[1])} ${num(m[2])}` })],
  [re(`Accept ${GATE} ${PRG}`), (m) => /^(G8b|G11)$/i.test(m[1]) ? { kind: 'accept', gate: canonGate(m[1]), pr: num(m[2]), t: `Accept ${canonGate(m[1])} PR${num(m[2])}` } : null],
  [re(`Refuse ${GATE} ${ID}(?:${REASON})?`), (m) => ({ kind: 'refuse', gate: canonGate(m[1]), id: num(m[2]), reason: m[3], t: withReason(`Refuse ${canonGate(m[1])} ${num(m[2])}`, m[3]) })],
  [re(`Refuse ${GATE} ${PRG}(?:${REASON})?`), (m) => /^(G8b|G11)$/i.test(m[1]) ? { kind: 'refuse', gate: canonGate(m[1]), pr: num(m[2]), reason: m[3], t: withReason(`Refuse ${canonGate(m[1])} PR${num(m[2])}`, m[3]) } : null],
  [re(`Skip ${GATE} ${ID}${REASON}`), (m) => ({ kind: 'skip', gate: canonGate(m[1]), id: num(m[2]), reason: m[3], t: withReason(`Skip ${canonGate(m[1])} ${num(m[2])}`, m[3]) })],
  [re(`Skip ${GATE} ${PRG}${REASON}`), (m) => /^(G8b|G11)$/i.test(m[1]) ? { kind: 'skip', gate: canonGate(m[1]), pr: num(m[2]), reason: m[3], t: withReason(`Skip ${canonGate(m[1])} PR${num(m[2])}`, m[3]) } : null],
  [re(`Pause ${ID}(?:${REASON})?`), (m) => ({ kind: 'pause', id: num(m[1]), reason: m[2], t: withReason(`Pause ${num(m[1])}`, m[2]) })],
  [re(`Take ${ID}`), (m) => ({ kind: 'take', id: num(m[1]), t: `Take ${num(m[1])}` })],
  [re(`Tested ${ID}`), (m) => ({ kind: 'tested', id: num(m[1]), t: `Tested ${num(m[1])}` })],
  [re(`Approve: (comment|update) ${ID}`), (m) => ({ kind: 'approve', verb: m[1].toLowerCase(), id: num(m[2]), t: `Approve: ${m[1].toLowerCase()} ${num(m[2])}` })],
  [re('Approve: create item'), () => ({ kind: 'approve', verb: 'create', t: 'Approve: create item' })],
  [re('Create it\\.'), () => ({ kind: 'approve', verb: 'create', t: 'Create it.' })],
  [re(`Approve: (review|reply) ${PRG}`), (m) => ({ kind: 'approve', verb: m[1].toLowerCase(), pr: num(m[2]), t: `Approve: ${m[1].toLowerCase()} PR${num(m[2])}` })],
  [re('Approve: push (\\S+)'), (m) => validBranch(m[1]) ? { kind: 'approve', verb: 'push', branch: m[1], t: `Approve: push ${m[1]}` } : null],
  [re(`Approve: pipeline ${ID}`), (m) => ({ kind: 'approve', verb: 'pipeline', pipeline: num(m[1]), t: `Approve: pipeline ${num(m[1])}` })],
  [re('Approve: edit harness'), () => ({ kind: 'approve', verb: 'harness', t: 'Approve: edit harness' })],
];

function parseAnswer(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (/[\r\n]/.test(s)) return null;
  const norm = s.replace(/[ \t ]+/g, ' ');
  for (const [rx, build] of FORMS) {
    const m = rx.exec(norm);
    if (!m) continue;
    const r = build(m);
    if (!r) return null;
    const { t, ...rest } = r;
    return clean({ kind: rest.kind, text: t, ...rest });
  }
  return null;
}

// True when the text starts like an answer but is not one (it arms nothing and the developer is told why).
function looksLikeAnswer(text) {
  if (typeof text !== 'string' || parseAnswer(text)) return false;
  const s = text.trim().replace(/^["'“‘]+/, '');
  return /^(accept|refuse|skip|pause|take|tested|approve)\b/i.test(s) || /^create it\b/i.test(s);
}

function hasAnswerLine(text) {
  return typeof text === 'string' && text.split(/\r\n|\n|\r/).some((l) => parseAnswer(l) !== null);
}

function needs(action, rule, form) {
  return `midas-sdlc blocked ${action}: ${rule}. Needs: ${form}. Stop and ask the developer; do not try another way.`;
}

const ANSWER_FORMS =
  'Answers are the whole message on one line: Accept G<n> <id>, where n is 0 to 13, 8b or 9b; Accept G8b PR<n>; Accept G11 PR<n>; ' +
  'Refuse G<n> <id>, optionally followed by : <reason>; Skip G<n> <id>: <reason>; Pause <id>, optionally followed by : <reason>; ' +
  'Take <id>; Tested <id>; Approve: comment <id>; Approve: update <id>; Approve: create item; Approve: review PR<n>; ' +
  'Approve: reply PR<n>; Approve: push <branch>; Approve: pipeline <definition id>; Approve: edit harness; or the button text Create it. ' +
  'Refuse and Skip also take G8b PR<n> and G11 PR<n>. Any other wording arms nothing.';

module.exports = { parseAnswer, looksLikeAnswer, hasAnswerLine, needs, ANSWER_FORMS };
