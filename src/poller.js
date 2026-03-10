import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { queryDatabase, getPage, updatePage } from './notion-client.js';
import { handleNotionWebhook, handleAgentSetup } from './webhook-handler.js';
import { refreshAgentCache } from './agent-cache.js';
import { config } from './config.js';

const POLL_INTERVAL_MS = 10_000;
const DEDUP_FILE = resolve(import.meta.dirname, '..', 'data', 'dispatched.json');
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const AGENTS_BASE_HOST = '/root/.openclaw/agents';

// Persistent dedup: { "taskId:estado": timestamp }
let dispatchedTasks = loadDedup();

function loadDedup() {
  try {
    if (existsSync(DEDUP_FILE)) {
      const data = JSON.parse(readFileSync(DEDUP_FILE, 'utf-8'));
      console.log(`[dedup] Loaded ${Object.keys(data).length} entries from disk`);
      return data;
    }
  } catch (e) {
    console.warn('[dedup] Could not load dedup file:', e.message);
  }
  return {};
}

function saveDedup() {
  try {
    writeFileSync(DEDUP_FILE, JSON.stringify(dispatchedTasks, null, 2));
  } catch (e) {
    console.warn('[dedup] Could not save dedup file:', e.message);
  }
}

/** Prune entries older than 7 days */
function pruneOldEntries() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let pruned = 0;
  for (const [key, ts] of Object.entries(dispatchedTasks)) {
    if (ts < cutoff) {
      delete dispatchedTasks[key];
      pruned++;
    }
  }
  if (pruned > 0) {
    console.log(`[dedup] Pruned ${pruned} entries older than 7 days`);
    saveDedup();
  }
}

export async function pollForTasks() {
  try {
    const response = await queryDatabase(config.notion.tareasDb, {
      and: [
        {
          property: 'Agente IA',
          relation: { is_not_empty: true },
        },
        {
          or: [
            { property: 'Estado', select: { equals: 'Pendiente' } },
            { property: 'Estado', select: { equals: 'Necesita Correcciones' } },
          ],
        },
      ],
    });

    const tasks = response.results || [];
    let dispatched = 0;

    for (const task of tasks) {
      const taskId = task.id;
      const estado = task.properties['Estado']?.select?.name;
      const cacheKey = `${taskId}:${estado}`;

      if (dispatchedTasks[cacheKey]) continue;

      console.log(`[poller] Found task ${taskId} in estado="${estado}", dispatching...`);

      const result = await handleNotionWebhook({
        type: 'page.property_values.updated',
        data: { page_id: taskId },
        id: `poll-${cacheKey}-${Date.now()}`,
      });

      console.log(`[poller] Result:`, JSON.stringify(result));

      if (result.action === 'dispatched') {
        dispatchedTasks[cacheKey] = Date.now();
        dispatched++;
      }
    }

    if (dispatched > 0) saveDedup();
  } catch (err) {
    console.error('[poller] Error polling tasks:', err.message);
  }
}

// In-memory tracking: pageId → { timestamp, retries, errorLogged }
const agentSetupInFlight = new Map();
const MAX_RETRIES = 2;

export async function pollForNewAgents() {
  try {
    await refreshAgentCache();

    // --- Poll for estado="nuevo" ---
    const response = await queryDatabase(config.notion.agentesDb, {
      property: 'Estado',
      select: { equals: 'nuevo' },
    });

    const agents = response.results || [];

    for (const agent of agents) {
      const pageId = agent.id;
      const flight = agentSetupInFlight.get(pageId);

      if (flight && (Date.now() - flight.timestamp < STALE_THRESHOLD_MS)) continue;

      const nombre = agent.properties['Nombre']?.title?.[0]?.plain_text || 'Sin nombre';
      console.log(`[poller] Found agent "${nombre}" (${pageId}) in estado="nuevo"`);

      agentSetupInFlight.set(pageId, { timestamp: Date.now(), retries: 0 });
      try {
        const result = await handleAgentSetup(agent);
        console.log(`[poller] Agent setup result:`, JSON.stringify(result));
      } catch (err) {
        console.error(`[poller] Error setting up agent "${nombre}":`, err.message);
      }
    }

    // --- Detect incomplete agent setups ---
    await detectIncompleteSetups();
  } catch (err) {
    console.error('[poller] Error polling agents:', err.message);
  }
}

/**
 * Detect agents that went through the setup flow but are incomplete.
 * Checks both "creando..." (stale) and "activo" (premature) agents.
 * An agent is incomplete if it has an OpenClaw ID but is missing workspace docs.
 */
async function detectIncompleteSetups() {
  try {
    // Query agents in "creando..." OR "activo" that have an OpenClaw ID
    const [creandoRes, activoRes] = await Promise.all([
      queryDatabase(config.notion.agentesDb, {
        property: 'Estado',
        select: { equals: 'creando...' },
      }),
      queryDatabase(config.notion.agentesDb, {
        and: [
          { property: 'Estado', select: { equals: 'activo' } },
          { property: 'Tipo', select: { equals: 'ia' } },
          { property: 'OpenClaw Agent ID', rich_text: { is_not_empty: true } },
        ],
      }),
    ]);

    const candidates = [
      ...(creandoRes.results || []),
      ...(activoRes.results || []),
    ];

    if (candidates.length === 0) return;

    for (const agent of candidates) {
      const pageId = agent.id;
      const nombre = agent.properties['Nombre']?.title?.[0]?.plain_text || 'Sin nombre';
      const estado = agent.properties['Estado']?.select?.name;
      const openclawId = agent.properties['OpenClaw Agent ID']?.rich_text?.[0]?.plain_text;

      if (!openclawId) continue; // Can't check without an ID

      // Only check agents whose workspace dir exists (created by our flow)
      const workspacePath = `${AGENTS_BASE_HOST}/${openclawId}/workspace`;
      if (!existsSync(workspacePath)) continue;

      // Check if workspace files exist
      const requiredFiles = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md'];
      const missingFiles = requiredFiles.filter(f => !existsSync(`${workspacePath}/${f}`));

      if (missingFiles.length === 0) continue; // Agent is complete

      // Check timing — use the later of: last Notion edit or last retry attempt
      const flight = agentSetupInFlight.get(pageId);
      const retries = flight?.retries || 0;
      const lastEdited = new Date(agent.last_edited_time).getTime();
      const lastAttempt = flight?.timestamp || 0;
      const referenceTime = Math.max(lastEdited, lastAttempt);
      const elapsed = Date.now() - referenceTime;

      if (elapsed < STALE_THRESHOLD_MS) continue; // Not stale yet

      if (retries >= MAX_RETRIES) {
        if (!flight?.errorLogged) {
          console.error(`[incomplete-detector] Agent "${nombre}" (${openclawId}) incomplete after ${MAX_RETRIES} retries. Missing: ${missingFiles.join(', ')}. Manual intervention needed.`);
          agentSetupInFlight.set(pageId, { ...flight, errorLogged: true });
        }
        continue;
      }

      console.log(`[incomplete-detector] Agent "${nombre}" (${openclawId}) in estado="${estado}" missing: ${missingFiles.join(', ')}. Re-dispatching to COO (retry ${retries + 1}/${MAX_RETRIES})...`);

      // If agent was prematurely set to "activo", revert to "creando..."
      if (estado === 'activo') {
        try {
          await updatePage(pageId, {
            'Estado': { select: { name: 'creando...' } },
          });
          console.log(`[incomplete-detector] Reverted "${nombre}" from "activo" to "creando..."`);
        } catch (err) {
          console.error(`[incomplete-detector] Failed to revert estado for "${nombre}":`, err.message);
        }
      }

      // Re-dispatch to COO
      agentSetupInFlight.set(pageId, { timestamp: Date.now(), retries: retries + 1 });
      try {
        const fullPage = await getPage(pageId);
        const result = await handleAgentSetup(fullPage, { isRetry: true });
        console.log(`[incomplete-detector] Retry result for "${nombre}":`, JSON.stringify(result));
      } catch (err) {
        console.error(`[incomplete-detector] Retry failed for "${nombre}":`, err.message);
      }
    }
  } catch (err) {
    console.error('[incomplete-detector] Error:', err.message);
  }
}

let pollingInterval = null;

export function startPolling() {
  console.log(`[poller] Starting polling every ${POLL_INTERVAL_MS / 1000}s`);
  pruneOldEntries();
  setTimeout(() => {
    pollForTasks();
    pollForNewAgents();
  }, 5000);
  pollingInterval = setInterval(() => {
    pollForTasks();
    pollForNewAgents();
  }, POLL_INTERVAL_MS);
}

export function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    console.log('[poller] Polling stopped');
  }
}

export function isPolling() {
  return pollingInterval !== null;
}

export function clearDispatchedTask(taskId) {
  let cleared = false;
  for (const key of Object.keys(dispatchedTasks)) {
    if (key.startsWith(taskId)) {
      delete dispatchedTasks[key];
      cleared = true;
    }
  }
  if (cleared) saveDedup();
}

export function getDispatchedCount() {
  return Object.keys(dispatchedTasks).length;
}
