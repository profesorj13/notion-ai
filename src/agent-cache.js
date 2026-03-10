import { queryDatabase, richTextToPlain, getPageBlocks, blocksToPlainText } from './notion-client.js';
import { config } from './config.js';

/** In-memory cache of agents from Notion DB */
let agentsCache = new Map(); // openclawId → agent data
let agentsByNotionId = new Map(); // notionPageId → agent data

export function getAgentByOpenClawId(openclawId) {
  return agentsCache.get(openclawId);
}

export function getAgentByNotionId(notionPageId) {
  return agentsByNotionId.get(notionPageId);
}

export function getAllAgents() {
  return [...agentsCache.values()];
}

/** Load all agents from Notion DB Agentes into cache */
export async function refreshAgentCache() {
  console.log('[agent-cache] Refreshing agent cache from Notion...');
  const response = await queryDatabase(config.notion.agentesDb);

  const newCache = new Map();
  const newByNotion = new Map();

  for (const page of response.results) {
    const props = page.properties;
    const nombre = props['Nombre']?.title?.[0]?.plain_text || 'Sin nombre';
    const rol = props['Rol']?.select?.name || null;
    const tipo = props['Tipo']?.select?.name || null;
    const estado = props['Estado']?.select?.name || null;
    const openclawId = richTextToPlain(props['OpenClaw Agent ID']?.rich_text) || null;
    const skills = (props['Skills']?.multi_select || []).map(s => s.name);
    const canalContacto = props['Canal contacto']?.select?.name || null;

    // Load pre-instructions from page body
    let preInstrucciones = '';
    try {
      const blocks = await getPageBlocks(page.id);
      preInstrucciones = blocksToPlainText(blocks);
    } catch (e) {
      console.warn(`[agent-cache] Could not load pre-instructions for ${nombre}:`, e.message);
    }

    const agent = {
      notionId: page.id,
      nombre,
      rol,
      tipo,
      estado,
      openclawId,
      skills,
      canalContacto,
      preInstrucciones,
    };

    if (openclawId) {
      newCache.set(openclawId, agent);
    }
    newByNotion.set(page.id, agent);
  }

  agentsCache = newCache;
  agentsByNotionId = newByNotion;
  console.log(`[agent-cache] Loaded ${newByNotion.size} agents (${newCache.size} with OpenClaw ID)`);
}
