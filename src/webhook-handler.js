import { getPage, getPageBlocks, getComments, getComment, getBlock, blocksToPlainText, richTextToPlain, updatePage } from './notion-client.js';
import { getAgentByNotionId, refreshAgentCache } from './agent-cache.js';
import { dispatchToAgent } from './openclaw-client.js';
import { buildMessage, buildAgentSetupMessage, buildCommentReplyMessage } from './message-builder.js';
import { config } from './config.js';

// Track recently processed events to avoid duplicates
const processedEvents = new Map(); // eventId → timestamp
const DEDUP_WINDOW_MS = 30_000;

function isDuplicate(eventId) {
  const now = Date.now();
  for (const [id, ts] of processedEvents) {
    if (now - ts > DEDUP_WINDOW_MS) processedEvents.delete(id);
  }
  if (processedEvents.has(eventId)) return true;
  processedEvents.set(eventId, now);
  return false;
}

/**
 * Main webhook handler for Notion page events.
 */
export async function handleNotionWebhook(payload) {
  const { type, data } = payload;

  const eventId = payload.id || `${type}-${data?.page_id}-${Date.now()}`;
  if (isDuplicate(eventId)) {
    console.log(`[webhook] Duplicate event ${eventId}, skipping`);
    return { action: 'skipped', reason: 'duplicate' };
  }

  console.log(`[webhook] Received event: ${type}`);

  const pageId = data?.page_id;
  if (!pageId) {
    console.log('[webhook] No page_id in event, skipping');
    return { action: 'skipped', reason: 'no_page_id' };
  }

  try {
    const page = await getPage(pageId);
    const parentDbId = page.parent?.database_id;

    if (parentDbId === config.notion.tareasDb) {
      return await handleTaskEvent(type, page);
    } else if (parentDbId === config.notion.agentesDb) {
      console.log('[webhook] Agent DB changed, refreshing cache');
      await refreshAgentCache();
      return { action: 'cache_refreshed' };
    } else if (parentDbId === config.notion.proyectosDb) {
      return await handleProjectEvent(type, page);
    } else {
      console.log(`[webhook] Event from unknown DB ${parentDbId}, skipping`);
      return { action: 'skipped', reason: 'unknown_db' };
    }
  } catch (err) {
    console.error('[webhook] Error processing event:', err);
    return { action: 'error', error: err.message };
  }
}

// Pending inline comments per page (not dispatched until a page-level comment triggers)
const pendingInlineComments = new Map(); // pageId → [{ commentId, timestamp }]
const INLINE_COMMENT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function cleanExpiredInlineComments(pageId) {
  const now = Date.now();
  const pending = pendingInlineComments.get(pageId);
  if (!pending) return;
  const filtered = pending.filter(c => now - c.timestamp < INLINE_COMMENT_TTL_MS);
  if (filtered.length === 0) {
    pendingInlineComments.delete(pageId);
  } else {
    pendingInlineComments.set(pageId, filtered);
  }
}

/**
 * Handle comment.created webhook events.
 * - Inline comments (on blocks): stored in memory, no dispatch.
 * - Page-level comments (discussion at top): triggers dispatch with all pending inline comments.
 */
export async function handleCommentWebhook(payload) {
  const eventId = payload.id;
  if (isDuplicate(eventId)) {
    console.log(`[webhook-comment] Duplicate event ${eventId}, skipping`);
    return { action: 'skipped', reason: 'duplicate' };
  }

  const authors = payload.authors || [];
  const commentId = payload.entity?.id;
  const pageId = payload.data?.page_id;

  // Ignore comments from bots (prevents loops when our agent comments back)
  if (authors.some(a => a.type === 'bot')) {
    console.log(`[webhook-comment] Comment from bot, ignoring`);
    return { action: 'skipped', reason: 'bot_comment' };
  }

  if (!pageId) {
    console.log('[webhook-comment] No page_id in payload, skipping');
    return { action: 'skipped', reason: 'no_page_id' };
  }

  console.log(`[webhook-comment] Comment ${commentId} on page ${pageId}`);

  try {
    // 1. Fetch the comment to determine type (inline vs page-level)
    let triggerComment;
    try {
      triggerComment = await getComment(commentId);
    } catch (err) {
      console.warn('[webhook-comment] Could not fetch comment by ID:', err.message);
      return { action: 'error', error: 'could_not_fetch_comment' };
    }

    const isInline = triggerComment.parent?.type === 'block_id';
    const commentText = richTextToPlain(triggerComment.rich_text);
    const authorName = triggerComment.display_name?.resolved_name
      || triggerComment.created_by?.name
      || triggerComment.created_by?.person?.email
      || 'Alguien';

    // 2. If inline → store and skip
    if (isInline) {
      cleanExpiredInlineComments(pageId);
      const pending = pendingInlineComments.get(pageId) || [];
      pending.push({ commentId, timestamp: Date.now() });
      pendingInlineComments.set(pageId, pending);
      console.log(`[webhook-comment] Inline comment from "${authorName}" stored (${pending.length} pending for page)`);
      return { action: 'stored_inline', pending: pending.length };
    }

    // 3. Page-level comment → dispatch with all pending inline comments
    console.log(`[webhook-comment] Page comment from "${authorName}": "${commentText.substring(0, 100)}"`);

    // Get the page and validate agent
    const page = await getPage(pageId);
    const parentDbId = page.parent?.database_id;

    if (parentDbId !== config.notion.tareasDb) {
      console.log(`[webhook-comment] Comment on non-task page (db: ${parentDbId}), skipping`);
      return { action: 'skipped', reason: 'not_a_task' };
    }

    const props = page.properties;
    const taskTitle = props['Tarea']?.title?.[0]?.plain_text
      || props['Nombre']?.title?.[0]?.plain_text
      || 'Sin título';

    const agentRelation = props['Agente IA']?.relation;
    if (!agentRelation || agentRelation.length === 0) {
      console.log(`[webhook-comment] Task "${taskTitle}" has no agent assigned, skipping`);
      return { action: 'skipped', reason: 'no_agent' };
    }

    const agentNotionId = agentRelation[0].id;
    let agent = getAgentByNotionId(agentNotionId);
    if (!agent) {
      await refreshAgentCache();
      agent = getAgentByNotionId(agentNotionId);
    }

    if (!agent || agent.tipo !== 'ia' || agent.estado !== 'activo' || !agent.openclawId) {
      console.log(`[webhook-comment] Agent not dispatchable (${agent?.nombre || 'not found'}), skipping`);
      return { action: 'skipped', reason: 'agent_not_dispatchable' };
    }

    // 4. Collect all pending inline comments
    cleanExpiredInlineComments(pageId);
    const pendingIds = pendingInlineComments.get(pageId) || [];
    const inlineComments = [];

    for (const { commentId: inlineId } of pendingIds) {
      try {
        const inlineComment = await getComment(inlineId);
        const inlineAuthor = inlineComment.display_name?.resolved_name
          || inlineComment.created_by?.name
          || 'Alguien';
        const inlineText = richTextToPlain(inlineComment.rich_text);
        // Fetch the block text for context
        let blockText = '';
        const parentBlockId = inlineComment.parent?.block_id;
        if (parentBlockId) {
          try {
            const block = await getBlock(parentBlockId);
            const blockContent = block[block.type];
            if (blockContent?.rich_text) {
              blockText = richTextToPlain(blockContent.rich_text);
            } else if (blockContent?.title) {
              blockText = richTextToPlain(blockContent.title);
            }
          } catch (err) {
            console.warn('[webhook-comment] Could not fetch block text:', err.message);
          }
        }
        inlineComments.push({
          author: inlineAuthor,
          text: inlineText,
          blockText: blockText || '',
        });
      } catch (err) {
        console.warn(`[webhook-comment] Could not fetch inline comment ${inlineId}:`, err.message);
      }
    }

    // Clear pending after collecting
    pendingInlineComments.delete(pageId);

    console.log(`[webhook-comment] Dispatching with ${inlineComments.length} inline + 1 page comment`);

    // 5. Build message with all comments
    const message = buildCommentReplyMessage({
      taskTitle,
      taskId: pageId,
      commentText,
      commentAuthor: authorName,
      discussionId: triggerComment.discussion_id,
      inlineComments,
    });

    // 6. Dispatch
    const result = await dispatchToAgent({
      message,
      agentId: agent.openclawId,
      sessionKey: `task:${pageId}`,
      name: `Comment on: ${taskTitle}`,
      thinking: 'medium',
      timeoutSeconds: 300,
    });

    console.log(`[webhook-comment] Dispatched "${agent.nombre}", status: ${result.status}`);
    return { action: 'dispatched', agent: agent.nombre, inlineCount: inlineComments.length, status: result.status };

  } catch (err) {
    console.error('[webhook-comment] Error:', err);
    return { action: 'error', error: err.message };
  }
}

async function handleTaskEvent(eventType, page) {
  const props = page.properties;
  const taskTitle = props['Tarea']?.title?.[0]?.plain_text
    || props['Nombre']?.title?.[0]?.plain_text
    || 'Sin título';
  const estado = props['Estado']?.select?.name || props['Estado']?.status?.name;
  const taskUrl = page.url;
  const taskId = page.id;

  const agentRelation = props['Agente IA']?.relation;
  if (!agentRelation || agentRelation.length === 0) {
    console.log(`[webhook] Task "${taskTitle}" has no agent assigned, skipping`);
    return { action: 'skipped', reason: 'no_agent' };
  }

  const agentNotionId = agentRelation[0].id;
  const agent = getAgentByNotionId(agentNotionId);

  if (!agent) {
    console.log(`[webhook] Agent ${agentNotionId} not found in cache, refreshing...`);
    await refreshAgentCache();
    const retryAgent = getAgentByNotionId(agentNotionId);
    if (!retryAgent) {
      console.log(`[webhook] Agent ${agentNotionId} still not found after refresh`);
      return { action: 'skipped', reason: 'agent_not_found' };
    }
    return await processTask(taskTitle, estado, taskId, taskUrl, page, retryAgent);
  }

  return await processTask(taskTitle, estado, taskId, taskUrl, page, agent);
}

async function processTask(taskTitle, estado, taskId, taskUrl, page, agent) {
  if (agent.tipo !== 'ia') {
    console.log(`[webhook] Agent "${agent.nombre}" is human (${agent.tipo}), skipping auto-dispatch`);
    return { action: 'skipped', reason: 'human_agent' };
  }

  if (agent.estado !== 'activo') {
    console.log(`[webhook] Agent "${agent.nombre}" is inactive, skipping`);
    return { action: 'skipped', reason: 'agent_inactive' };
  }

  if (!agent.openclawId) {
    console.log(`[webhook] Agent "${agent.nombre}" has no OpenClaw ID, skipping`);
    return { action: 'skipped', reason: 'no_openclaw_id' };
  }

  if (estado === 'Pendiente' || estado === 'En progreso') {
    return await dispatchTask(taskTitle, taskId, taskUrl, page, agent, false);
  } else if (estado === 'Necesita Correcciones') {
    return await dispatchTask(taskTitle, taskId, taskUrl, page, agent, true);
  } else {
    console.log(`[webhook] Task "${taskTitle}" estado="${estado}", no dispatch needed`);
    return { action: 'skipped', reason: `estado_${estado}` };
  }
}

async function dispatchTask(taskTitle, taskId, taskUrl, page, agent, includeFeedback) {
  console.log(`[webhook] Dispatching "${taskTitle}" → agent "${agent.nombre}" (${agent.openclawId})`);

  const blocks = await getPageBlocks(taskId);
  const taskBody = blocksToPlainText(blocks);

  let projectBrief = '';
  const projectRelation = page.properties['Proyecto (link)']?.relation
    || page.properties['Proyecto']?.relation;
  if (projectRelation && projectRelation.length > 0) {
    try {
      const projBlocks = await getPageBlocks(projectRelation[0].id);
      projectBrief = blocksToPlainText(projBlocks);
    } catch (e) {
      console.warn(`[webhook] Could not load project brief:`, e.message);
    }
  }

  let feedback = '';
  if (includeFeedback) {
    try {
      const comments = await getComments(taskId);
      feedback = (comments.results || [])
        .map(c => richTextToPlain(c.rich_text))
        .filter(Boolean)
        .join('\n---\n');
    } catch (e) {
      console.warn(`[webhook] Could not load comments:`, e.message);
    }
  }

  const message = buildMessage({
    taskTitle,
    taskBody,
    projectBrief,
    preInstrucciones: agent.preInstrucciones,
    feedback: feedback || undefined,
    taskUrl,
    taskId,
  });

  const result = await dispatchToAgent({
    message,
    agentId: agent.openclawId,
    sessionKey: `task:${taskId}`,
    name: `Task: ${taskTitle}`,
    thinking: 'medium',
    timeoutSeconds: 300,
  });

  console.log(`[webhook] Dispatch result: ${result.status}`);
  return { action: 'dispatched', agent: agent.nombre, status: result.status };
}

/**
 * Handle agent setup: dispatches the COO to create/configure a new agent.
 */
export async function handleAgentSetup(agentPage, options = {}) {
  const pageId = agentPage.id;
  const props = agentPage.properties;

  const agentName = props['Nombre']?.title?.[0]?.plain_text || 'Sin nombre';
  const estado = props['Estado']?.select?.name;
  const agentUrl = agentPage.url;

  console.log(`[agent-setup] Processing agent "${agentName}" (${pageId}), estado="${estado}"`);

  const blocks = await getPageBlocks(pageId);
  const agentBody = blocksToPlainText(blocks);

  const trimmedBody = agentBody.trim();
  if (!trimmedBody || trimmedBody.length < 20) {
    console.log(`[agent-setup] Agent "${agentName}" has empty/minimal body, skipping`);
    return { action: 'skipped', reason: 'empty_body' };
  }

  if (estado !== "creando...") {
    try {
      await updatePage(pageId, {
        'Estado': { select: { name: 'creando...' } },
      });
      console.log(`[agent-setup] Changed estado to "creando..." for "${agentName}"`);
    } catch (err) {
      console.error(`[agent-setup] Failed to update estado:`, err.message);
    }
  }

  const agentProperties = {
    'Nombre': agentName,
    'Rol': props['Rol']?.select?.name || '',
    'Tipo': props['Tipo']?.select?.name || '',
    'Skills': (props['Skills']?.multi_select || []).map(s => s.name).join(', '),
    'Departamento': props['Departamento']?.select?.name || '',
  };

  const message = buildAgentSetupMessage({
    agentPageId: pageId,
    agentName,
    agentBody,
    agentProperties,
    agentUrl,
    isRetry: options.isRetry || false,
  });

  const result = await dispatchToAgent({
    message,
    agentId: 'coo',
    sessionKey: `agent-setup:${pageId}`,
    name: `Agent Setup: ${agentName}`,
    thinking: 'medium',
    timeoutSeconds: 600,
  });

  console.log(`[agent-setup] Dispatched to COO, status: ${result.status}`);
  return { action: 'dispatched', agent: 'coo', status: result.status };
}

async function handleProjectEvent(eventType, page) {
  console.log(`[webhook] Project event received (phase 2, not implemented yet)`);
  return { action: 'skipped', reason: 'project_events_not_implemented' };
}
