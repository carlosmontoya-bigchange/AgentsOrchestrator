'use strict';
// Reads a hook's JSON from stdin. Resolves on a complete parse, on 'end', or at capMs ('end' may never fire).

function readStdin(stream = process.stdin, capMs = 1000) {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(buf); };
    const timer = setTimeout(finish, capMs);
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      if (buf.charCodeAt(0) === 0xFEFF) buf = buf.slice(1);
      // Parse only when the text could be complete: a cheap tail check keeps a large input from being re-parsed per chunk.
      if (/\}\s*$/.test(buf.slice(-64))) { try { JSON.parse(buf); finish(); } catch { /* keep reading */ } }
    });
    stream.on('end', finish);
    stream.on('error', finish);
  });
}

module.exports = { readStdin };
