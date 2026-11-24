'use strict';
// Own matcher: path.matchesGlob is missing before Node 20.17, and file systems on Windows ignore case.

const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function toRegExp(glob) {
  const g = glob.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    const end = c === '{' ? g.indexOf('}', i) : -1;
    if (c === '*' && g[i + 1] === '*') {
      // "**/" is any number of folders, none included
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (end !== -1) {
      // shortcut: the choices between braces are plain text, upgrade if a pod needs a wildcard inside them
      re += `(?:${g.slice(i + 1, end).split(',').map(literal).join('|')})`;
      i = end;
    } else re += literal(c);
  }
  return new RegExp(`^${re}$`, 'i');
}

function matchGlob(glob, filePath) {
  return toRegExp(glob).test(String(filePath).replace(/\\/g, '/'));
}

function firstMatch(globs, filePath) {
  return globs.find((glob) => matchGlob(glob, filePath)) ?? null;
}

module.exports = { matchGlob, firstMatch };
