import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';

const OPENCLAW_JSON = '/root/.openclaw/openclaw.json';
const AGENTS_BASE = '/root/.openclaw/agents';

/**
 * Reads openclaw.json and builds the team directory table,
 * then updates every agent's AGENTS.md with the current directory.
 */
export function updateTeamDirectory() {
  let config;
  try {
    config = JSON.parse(readFileSync(OPENCLAW_JSON, 'utf-8'));
  } catch (err) {
    console.error('[team-directory] Cannot read openclaw.json:', err.message);
    return;
  }

  const agents = config.agents.list;

  // Build directory rows from openclaw.json
  const rows = agents.map(a => {
    const id = a.id;
    const name = a.identity?.name || a.name || id;
    const sessionKey = id === 'main' ? 'main' : `agent:${id}:main`;
    return { id, name, sessionKey };
  });

  const tableRows = rows
    .map(r => `| ${r.name} | \`${r.sessionKey}\` |`)
    .join('\n');

  const directorySection = `## Directorio del Equipo

Para comunicarte con otro agente, usá \`sessions_send\` con el \`sessionKey\` correspondiente.

| Agente | sessionKey |
|--------|------------|
${tableRows}

Mari (main) es la secretaria de Juan y el puente principal hacia él. Si necesitás algo de Juan, hablá con Mari.
**Compartí referencias y contexto de proyectos** — si algo que aprendiste puede servirle a otro, pasalo.`;

  // Update each agent's AGENTS.md
  let updated = 0;
  for (const agent of agents) {
    const agentsMdPath = `${AGENTS_BASE}/${agent.id}/workspace/AGENTS.md`;
    if (!existsSync(agentsMdPath)) continue;

    let content = readFileSync(agentsMdPath, 'utf-8');

    // Remove existing directory section
    const dirRegex = /## Directorio del Equipo\n[\s\S]*?(?=\n## (?!Directorio)|$)/;
    if (dirRegex.test(content)) {
      content = content.replace(dirRegex, '');
    }

    // Clean trailing whitespace and append
    content = content.replace(/\n{3,}/g, '\n\n').trimEnd();
    content += '\n\n' + directorySection + '\n';

    writeFileSync(agentsMdPath, content);
    updated++;
  }

  console.log(`[team-directory] Updated ${updated} agents with ${rows.length} entries`);
}
