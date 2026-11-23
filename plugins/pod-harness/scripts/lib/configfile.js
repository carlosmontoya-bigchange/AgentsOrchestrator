'use strict';

const SECTION_NAMES = ['Pod', 'Repos', 'Stages', 'Teams', 'Reports', 'Trivial', 'Policies', 'Skills', 'Approvals', 'Delivery', 'Budget'];

class ConfigError extends Error {
  constructor(code, message, heading) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    if (heading !== undefined) this.heading = heading;
  }
}

// Finds the frontmatter and, per heading, the lines of its first ```json block.
function scan(text) {
  const lines = text.split(/\r?\n/);
  const close = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  if (close === -1) throw new ConfigError('no-frontmatter', 'The file does not start with a settings header between two "---" lines.');
  const meta = {};
  for (const line of lines.slice(1, close)) {
    const m = /^([a-z_]+):\s*(.*?)\s*$/.exec(line);
    if (m) meta[m[1]] = m[2];
  }
  meta.format = Number(meta.format);
  if (!Number.isInteger(meta.format)) throw new ConfigError('no-frontmatter', 'The settings header has no "format" number.');

  const found = [];
  let current = null;
  let fence = null; // null, 'json' (the block we want) or 'other'
  for (let i = close + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      if (fence === null) {
        const wanted = current && current.open === undefined && /^```json\s*$/.test(line);
        fence = wanted ? 'json' : 'other';
        if (wanted) current.open = i;
      } else {
        if (fence === 'json') current.close = i;
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;
    const m = /^# (.+?)\s*$/.exec(line);
    if (!m) continue;
    const heading = m[1];
    if (!SECTION_NAMES.includes(heading)) {
      throw new ConfigError('unknown-heading', `"${heading}" is not a known heading. Known headings: ${SECTION_NAMES.join(', ')}.`, heading);
    }
    if (found.some((s) => s.heading === heading)) {
      throw new ConfigError('duplicate-heading', `The heading "${heading}" appears twice.`, heading);
    }
    current = { heading };
    found.push(current);
  }
  for (const s of found) {
    if (s.close === undefined) {
      throw new ConfigError('missing-block', `The heading "${s.heading}" has no complete \`\`\`json block under it.`, s.heading);
    }
  }
  return { lines, meta, found };
}

function parseConfigFile(text) {
  const { lines, meta, found } = scan(text);
  const sections = {};
  for (const s of found) {
    try {
      sections[s.heading] = JSON.parse(lines.slice(s.open + 1, s.close).join('\n'));
    } catch (e) {
      throw new ConfigError('bad-json', `The settings under "${s.heading}" are not valid JSON: ${e.message}`, s.heading);
    }
  }
  return { meta, sections };
}

const blockLines = (value) => JSON.stringify(value, null, 2).split('\n');

function renderConfigFile(meta, sections) {
  const out = ['---', `format: ${meta.format}`, `min_plugin: ${meta.min_plugin}`, `layer: ${meta.layer}`, `pod: ${meta.pod}`, '---'];
  for (const heading of SECTION_NAMES) {
    if (sections[heading] === undefined) continue;
    out.push('', `# ${heading}`, '', '```json', ...blockLines(sections[heading]), '```');
  }
  return out.join('\n') + '\n';
}

function replaceSection(text, heading, value) {
  if (!SECTION_NAMES.includes(heading)) {
    throw new ConfigError('unknown-heading', `"${heading}" is not a known heading. Known headings: ${SECTION_NAMES.join(', ')}.`, heading);
  }
  const { lines, found } = scan(text);
  const s = found.find((x) => x.heading === heading);
  if (s) {
    lines.splice(s.open + 1, s.close - s.open - 1, ...blockLines(value));
    return lines.join('\n');
  }
  const body = lines.join('\n').replace(/\n*$/, '\n');
  return body + ['', `# ${heading}`, '', '```json', ...blockLines(value), '```'].join('\n') + '\n';
}

module.exports = { SECTION_NAMES, ConfigError, parseConfigFile, renderConfigFile, replaceSection };
