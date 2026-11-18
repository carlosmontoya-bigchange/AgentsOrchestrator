'use strict';
// Browser family: Azure DevOps pages are never opened through a browser tool (R25). Arms never matter.
// Known escapes: navigate back/forward, redirects and script-built URLs.
const answers = require('./answers');

const isAdoUrl = (text) => /dev\.azure\.com|visualstudio\.com/i.test(String(text));
const PREFIX = /^mcp__(claude-in-chrome|Claude_Browser)__/;
const DENY = answers.needs('browser navigation to Azure DevOps', 'Azure DevOps pages are always blocked in the browser (R25)', 'nothing; no answer allows this, so the developer opens the page themselves');

function check(input) {
  const tool = String(input.tool_name), m = PREFIX.exec(tool);
  if (!m) return null;
  const short = tool.slice(m[0].length), ti = input.tool_input || {};
  if ((short === 'navigate' || short === 'preview_start') && isAdoUrl(ti.url)) return DENY;
  if (short === 'javascript_tool' && isAdoUrl(ti.text)) return DENY;
  if (short === 'browser_batch' && Array.isArray(ti.actions))
    for (const a of ti.actions)
      if (a && check({ tool_name: m[0] + a.name, tool_input: a.input })) return DENY;
  return null;
}

module.exports = { check, isAdoUrl };
