#!/usr/bin/env node
// Generates docs/agent-tools.md from the tool definitions in worker/agent.js, so the reference never drifts.
// `node tools/gen-agent-docs.mjs --check` exits 1 when the committed file is out of date (used by the tests).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { TOOLS, AGENT_SCOPES } from '../worker/agent.js';

const OUT = new URL('../docs/agent-tools.md', import.meta.url);
const type = s => s.enum ? s.enum.map(v => `\`${v}\``).join(' \\| ') : [].concat(s.type || 'any').join(' \\| ') + (s.items && s.items.type ? ` of ${s.items.type}` : '');
let md = `# Agent tool reference

Generated from \`worker/agent.js\` by \`npm run docs:agent\`. Do not edit by hand.

Every tool is available over MCP (\`tools/call\` at \`/mcp\`) and REST (\`POST /api/agent/v1/tools/<name>\`).

## Scopes

| Scope | Allows |
|---|---|
${Object.entries(AGENT_SCOPES).map(([k, v]) => `| \`${k}\` | ${v} |`).join('\n')}

`;
for (const t of TOOLS) {
  md += `## \`${t.name}\` — ${t.title}\n\nScope: \`${t.scope}\`${t.annotations.readOnlyHint ? ' · read-only' : ''}\n\n${t.description}\n\n`;
  const props = Object.entries(t.inputSchema.properties || {});
  if (props.length) {
    const req = new Set(t.inputSchema.required || []);
    md += '| Argument | Type | Required | Notes |\n|---|---|---|---|\n';
    for (const [k, s] of props) md += `| \`${k}\` | ${type(s)} | ${req.has(k) ? 'yes' : ''} | ${(s.description || '').replace(/\|/g, '\\|')} |\n`;
    md += '\n';
  } else md += 'No arguments.\n\n';
}
if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== md) { console.error('docs/agent-tools.md is out of date: run npm run docs:agent'); process.exit(1); }
  console.log('docs/agent-tools.md is up to date');
} else { writeFileSync(OUT, md); console.log('wrote docs/agent-tools.md'); }
