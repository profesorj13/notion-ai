import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, chownSync } from 'fs';
import { execSync } from 'child_process';
import { refreshAgentCache } from './agent-cache.js';

const OPENCLAW_JSON = '/root/.openclaw/openclaw.json';
const AGENTS_BASE_HOST = '/root/.openclaw/agents';
const AGENTS_BASE_CONTAINER = '/home/node/.openclaw/agents';
const AUTH_PROFILES_SRC = '/root/.openclaw/agents/main/agent/auth-profiles.json';

export async function createAgent(req, res) {
  const { id, name, identity } = req.body;

  // 1. Validate
  if (!id || !name) {
    return res.status(400).json({
      error: 'Missing required fields: id, name',
    });
  }

  if (!/^[a-z0-9-]+$/.test(id)) {
    return res.status(400).json({
      error: 'id must be a valid slug (lowercase alphanumeric + hyphens)',
    });
  }

  // 2. Check openclaw.json for duplicate
  let openclawConfig;
  try {
    openclawConfig = JSON.parse(readFileSync(OPENCLAW_JSON, 'utf-8'));
  } catch (err) {
    return res.status(500).json({ error: `Cannot read openclaw.json: ${err.message}` });
  }

  const existingAgent = openclawConfig.agents.list.find(a => a.id === id);
  if (existingAgent) {
    return res.status(409).json({ error: `Agent "${id}" already exists in openclaw.json` });
  }

  try {
    // 3. Backup openclaw.json
    const timestamp = Date.now();
    const backupPath = `${OPENCLAW_JSON}.bak.${timestamp}`;
    copyFileSync(OPENCLAW_JSON, backupPath);
    console.log(`[agent-creator] Backed up openclaw.json → ${backupPath}`);

    // 4. Create directories
    const agentHostDir = `${AGENTS_BASE_HOST}/${id}`;
    mkdirSync(`${agentHostDir}/workspace/memory`, { recursive: true });
    mkdirSync(`${agentHostDir}/workspace/skills`, { recursive: true });
    mkdirSync(`${agentHostDir}/agent`, { recursive: true });
    // Set ownership to uid 1000 (node user inside Docker container)
    execSync(`chown -R 1000:1000 ${agentHostDir}`);
    console.log(`[agent-creator] Created directories for "${id}" (owned by 1000:1000)`);

    // 5. Copy auth-profiles.json
    if (existsSync(AUTH_PROFILES_SRC)) {
      copyFileSync(AUTH_PROFILES_SRC, `${agentHostDir}/agent/auth-profiles.json`);
      console.log(`[agent-creator] Copied auth-profiles.json`);
    } else {
      console.warn(`[agent-creator] auth-profiles.json not found at ${AUTH_PROFILES_SRC}`);
    }

    // 6. Register in openclaw.json
    const newAgentEntry = {
      id,
      name,
      workspace: `${AGENTS_BASE_CONTAINER}/${id}/workspace`,
      agentDir: `${AGENTS_BASE_CONTAINER}/${id}/agent`,
      identity: { name: identity || name },
    };
    openclawConfig.agents.list.push(newAgentEntry);
    writeFileSync(OPENCLAW_JSON, JSON.stringify(openclawConfig, null, 2));
    // Ensure openclaw.json stays readable by the Docker container (uid 1000)
    chownSync(OPENCLAW_JSON, 1000, 1000);
    console.log(`[agent-creator] Added "${id}" to openclaw.json`);

    // 7. Return success — NO Docker restart, NO document creation
    res.json({
      success: true,
      agentId: id,
      hostPath: agentHostDir,
      containerPath: `${AGENTS_BASE_CONTAINER}/${id}`,
      message: `Agent "${name}" (${id}) registered. Directories created, openclaw.json updated. Documents and Docker restart pending.`,
    });

  } catch (err) {
    console.error(`[agent-creator] Error creating agent:`, err);
    res.status(500).json({ error: err.message });
  }
}
