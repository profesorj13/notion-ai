import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { queryDatabase } from './notion-client.js';
import { handleNotionWebhook, handleAgentSetup } from './webhook-handler.js';
import { refreshAgentCache } from './agent-cache.js';
import { config } from './config.js';

const POLL_INTERVAL_MS = 10_000;
const DEDUP_FILE = resolve(import.meta.dirname, '..', 'data', 'dispatched.json');

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

// In-memory set to prevent double-dispatch within the same cycle.
const agentSetupInFlight = new Set();

export async function pollForNewAgents() {
  try {
    // Refresh agent cache every poll cycle to keep it in sync with Notion
    await refreshAgentCache();

    const response = await queryDatabase(config.notion.agentesDb, {
      property: 'Estado',
      select: { equals: 'nuevo' },
    });

    const agents = response.results || [];

    for (const agent of agents) {
      const pageId = agent.id;

      if (agentSetupInFlight.has(pageId)) continue;

      const nombre = agent.properties['Nombre']?.title?.[0]?.plain_text || 'Sin nombre';
      console.log(`[poller] Found agent "${nombre}" (${pageId}) in estado="nuevo"`);

      agentSetupInFlight.add(pageId);
      try {
        const result = await handleAgentSetup(agent);
        console.log(`[poller] Agent setup result:`, JSON.stringify(result));
      } catch (err) {
        console.error(`[poller] Error setting up agent "${nombre}":`, err.message);
      } finally {
        setTimeout(() => agentSetupInFlight.delete(pageId), 60_000);
      }
    }
  } catch (err) {
    console.error('[poller] Error polling agents:', err.message);
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
