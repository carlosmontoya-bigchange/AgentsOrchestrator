'use strict';
const { parseAnswer } = require('./answers');
// Ledger lines and the queries the guard makes on them. Pure: no I/O, no dependencies.
// Line: {prompt_id, kind, value, origin}. Human lines = origin human, plus pending lines whose prompt_id a verified line names.

const arr = (l) => (Array.isArray(l) ? l : []);
const line = (prompt_id, kind, value, origin) => ({ prompt_id, kind, value, origin });

function toLedger(answer, promptId, origin) {
  if (!answer || typeof answer.text !== 'string') return [];
  const t = answer.text;
  let value;
  if (answer.kind === 'approve') value = answer.verb === 'create' ? 'create item' : answer.verb === 'harness' ? 'edit harness' : t.replace(/^Approve: /, '');
  else value = t.replace(/^\S+ /, '');
  return [line(promptId, answer.kind, value, origin)];
}

function reasonLine(pending, text, promptId, origin) {
  if (!pending || !parseAnswer(pending.answer)) return null;
  const reason = String(text).trim().replace(/\s+/g, ' ').slice(0, 500);
  return line(promptId, 'reason', `${pending.answer.replace(/^\S+ /, '')}: ${reason}`, origin);
}

const verifiedLine = (promptId) => line(promptId, 'verified', promptId, 'human');

// Each human line keeps its index in the file.
function humanLines(ledger) {
  ledger = arr(ledger);
  const ok = (l) => l && typeof l === 'object' && typeof l.value === 'string';
  const verified = new Set(ledger.filter((l) => ok(l) && l.kind === 'verified' && l.origin === 'human').map((l) => l.value));
  return ledger.map((l, i) => (ok(l) ? { ...l, i } : null)).filter((l) => l).filter((l) => l.origin === 'human' || (l.origin === 'pending' && verified.has(l.prompt_id)));
}

function isOwnItem(ledger, id) {
  return arr(ledger).some((l) => {
    if (!l || typeof l.value !== 'string' || !['accept', 'refuse', 'skip'].includes(l.kind)) return false;
    const m = /^G(\d{1,2}|8b|9b) (\d+)(:|$)/i.exec(l.value);
    return !!m && Number(m[2]) === id;
  });
}

function takeOpen(ledger, id) {
  return !isOwnItem(ledger, id) && humanLines(ledger).some((l) => l.kind === 'take' && l.value === String(id));
}

function closeAllowed(ledger, id) {
  const h = humanLines(ledger);
  const branchRe = new RegExp(`(^|/)${id}(-|$)`);
  const g10 = h.filter((l) => ['accept', 'refuse', 'skip'].includes(l.kind) && new RegExp(`^G10 ${id}(:|$)`, 'i').test(l.value));
  if (!g10.length) return { ok: false, why: `no G10 answer for ${id}` };
  const last = g10[g10.length - 1];
  if (!(last.kind === 'accept' || (last.kind === 'skip' && /: \S/.test(last.value)))) {
    return { ok: false, why: `the latest G10 answer for ${id} is not an accept or a skip with a reason` };
  }
  const events = h.filter((l) => (l.kind === 'accept' && new RegExp(`^(G8|G9|G9b) ${id}$`, 'i').test(l.value)) ||
    (l.kind === 'approve' && l.value.startsWith('push ') && branchRe.test(l.value.slice(5))));
  const ev = events[events.length - 1];
  if (ev && ev.i > last.i) {
    return { ok: false, why: `the G10 answer for ${id} comes before the latest push or deploy (${ev.kind} ${ev.value})` };
  }
  return { ok: true, why: '' };
}

function created(ledger) {
  return humanLines(ledger).filter((l) => l.kind === 'created').map((l) => /^pr (\d+) (\d+)$/.exec(l.value)).filter(Boolean)
    .map((m) => ({ pr: Number(m[1]), id: Number(m[2]) }));
}
const prsFor = (ledger, id) => created(ledger).filter((c) => c.id === id).map((c) => c.pr);
const itemForPr = (ledger, pr) => (created(ledger).find((c) => c.pr === pr) || {}).id || null;

module.exports = { toLedger, reasonLine, verifiedLine, isOwnItem, takeOpen, closeAllowed, prsFor, itemForPr };
