import express from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { config } from './config.js';
import { refreshAgentCache, getAllAgents, getAgentByNotionId } from './agent-cache.js';
import { handleNotionWebhook, handleCommentWebhook } from './webhook-handler.js';
import { dispatchToAgent } from './openclaw-client.js';
import { getPage, getPageBlocks, blocksToPlainText } from './notion-client.js';
import { buildMessage } from './message-builder.js';
import { startPolling, stopPolling, isPolling, getDispatchedCount } from './poller.js';
import { createAgent } from './agent-creator.js';

const POLLING_ENABLED = process.env.POLLING_ENABLED !== 'false'; // default: true

const app = express();

// Raw body capture for webhook signature verification
app.use('/webhook/notion', express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));

// JSON parser for all other routes
app.use(express.json());

// Verify Notion webhook signature
function verifySignature(rawBody, signatureHeader) {
  if (!config.notion.webhookSecret) return true; // skip if not configured yet
  if (!signatureHeader) return false;
  const expected = `sha256=${createHmac('sha256', config.notion.webhookSecret).update(rawBody).digest('hex')}`;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    polling: isPolling(),
    dispatchedCount: getDispatchedCount(),
  });
});

// Notion webhook endpoint
app.post('/webhook/notion', async (req, res) => {
  const body = req.body;

  // Step 1: Handle verification token (one-time setup)
  if (body.verification_token) {
    console.log('[webhook] ========================================');
    console.log('[webhook] VERIFICATION TOKEN RECEIVED:');
    console.log(`[webhook] ${body.verification_token}`);
    console.log('[webhook] Paste this in the Notion integration dashboard');
    console.log('[webhook] ========================================');
    return res.status(200).json({ ok: true });
  }

  // Step 2: Verify signature on real events
  const signature = req.headers['x-notion-signature'];
  if (config.notion.webhookSecret && !verifySignature(req.rawBody, signature)) {
    console.warn('[webhook] Invalid signature, rejecting');
    return res.status(401).json({ error: 'invalid signature' });
  }

  // Respond 200 immediately (Notion expects fast response)
  res.status(200).json({ received: true });

  const eventType = body.type;
  const eventId = body.id;
  console.log(`[webhook] Event received: ${eventType} (id: ${eventId})`);

  try {
    if (eventType === 'comment.created') {
      const result = await handleCommentWebhook(body);
      console.log('[webhook] Comment handler result:', JSON.stringify(result));
    } else if (eventType?.startsWith('page.')) {
      const result = await handleNotionWebhook(body);
      console.log('[webhook] Page handler result:', JSON.stringify(result));
    } else {
      console.log(`[webhook] Unhandled event type: ${eventType}`);
    }
  } catch (err) {
    console.error('[webhook] Processing error:', err);
  }
});

// Manual dispatch endpoint
app.post('/dispatch', async (req, res) => {
  const { taskId } = req.body;
  if (!taskId) return res.status(400).json({ error: 'taskId required' });

  try {
    const page = await getPage(taskId);
    const props = page.properties;
    const taskTitle = props['Tarea']?.title?.[0]?.plain_text
      || props['Nombre']?.title?.[0]?.plain_text
      || 'Sin título';

    const agentRelation = props['Agente IA']?.relation;
    if (!agentRelation || agentRelation.length === 0) {
      return res.status(400).json({ error: 'No agent assigned to task' });
    }

    const agent = getAgentByNotionId(agentRelation[0].id);
    if (!agent) return res.status(404).json({ error: 'Agent not found in cache' });
    if (!agent.openclawId) return res.status(400).json({ error: 'Agent has no OpenClaw ID' });

    const blocks = await getPageBlocks(taskId);
    const taskBody = blocksToPlainText(blocks);

    let projectBrief = '';
    const projectRelation = props['Proyecto (link)']?.relation || props['Proyecto']?.relation;
    if (projectRelation?.length > 0) {
      try {
        const projBlocks = await getPageBlocks(projectRelation[0].id);
        projectBrief = blocksToPlainText(projBlocks);
      } catch {}
    }

    const message = buildMessage({
      taskTitle, taskBody, projectBrief,
      preInstrucciones: agent.preInstrucciones,
      taskUrl: page.url, taskId,
    });

    const result = await dispatchToAgent({
      message, agentId: agent.openclawId,
      sessionKey: `task:${taskId}`,
      name: `Task: ${taskTitle}`,
      deliver: false, thinking: 'medium', timeoutSeconds: 300,
    });

    res.json({
      dispatched: true, agent: agent.nombre,
      openclawId: agent.openclawId,
      openclawStatus: result.status,
      openclawResponse: result.body,
    });
  } catch (err) {
    console.error('[dispatch] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Agent creation endpoint
app.post('/agents/create', createAgent);

// Poller control
app.post('/poller/start', (req, res) => {
  if (isPolling()) return res.json({ status: 'already running' });
  startPolling();
  res.json({ status: 'started' });
});

app.post('/poller/stop', (req, res) => {
  stopPolling();
  res.json({ status: 'stopped' });
});

app.get('/poller/status', (req, res) => {
  res.json({ polling: isPolling(), dispatchedCount: getDispatchedCount() });
});

// Agent cache
app.post('/agents/refresh', async (req, res) => {
  try {
    await refreshAgentCache();
    res.json({ agents: getAllAgents() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/agents', (req, res) => {
  res.json({ agents: getAllAgents() });
});

// Startup
async function start() {
  console.log('[server] AI Team Orchestrator starting...');
  console.log(`[server] Polling enabled: ${POLLING_ENABLED}`);
  console.log(`[server] Webhook secret: ${config.notion.webhookSecret ? 'configured' : 'NOT SET (signature verification disabled)'}`);

  await refreshAgentCache();

  if (POLLING_ENABLED) {
    startPolling();
  } else {
    console.log('[server] Polling disabled (POLLING_ENABLED=false)');
  }

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`[server] Listening on port ${config.port}`);
    console.log('[server] Endpoints:');
    console.log(`  GET  /health`);
    console.log(`  POST /dispatch           — manual task dispatch`);
    console.log(`  POST /agents/create      — create new OpenClaw agent`);
    console.log(`  POST /webhook/notion     — Notion webhook receiver (comments)`);
    console.log(`  POST /poller/start|stop  — control polling`);
    console.log(`  GET  /poller/status`);
    console.log(`  GET  /agents`);
    console.log(`  POST /agents/refresh`);
  });
}

start().catch(err => {
  console.error('[server] Fatal error:', err);
  process.exit(1);
});
