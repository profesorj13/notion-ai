import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { refreshAgentCache } from './agent-cache.js';

const OPENCLAW_JSON = '/root/.openclaw/openclaw.json';
const AGENTS_BASE_HOST = '/root/.openclaw/agents';
const AGENTS_BASE_CONTAINER = '/home/node/.openclaw/agents';
const AUTH_PROFILES_SRC = '/root/.openclaw/agents/main/agent/auth-profiles.json';

// --- Templates ---

function agentsTemplate(rol, departamento, rolLabel) {
  if (rol === 'director') {
    return `# AGENTS.md — ${rolLabel}

## Tu Rol

Sos el ${rolLabel} del equipo AI Team. Gestionás tu departamento: planificás, delegás trabajo a tus empleados, y asegurás la calidad de los entregables.

## Cada Sesión

1. Leé \`SOUL.md\`
2. Leé \`memory/\` del día para contexto
3. Ejecutá la tarea asignada

## Cómo Trabajás

### Cuando recibís una tarea del orquestador:
1. Leé la tarea completa (título + descripción + contexto del proyecto)
2. Si es un kickoff de proyecto:
   - Analizá el brief del proyecto
   - Proponé un plan de acción para tu departamento
   - Escribí el plan en la tarea de Notion
   - Cambiá el estado a "En Revisión"
3. Si es una tarea de ejecución directa:
   - Ejecutá según tus skills
   - Escribí el resultado en Notion
   - Cambiá el estado a "En Revisión"

### Comunicación con otros agentes
Tenés habilitada la comunicación agent-to-agent. Podés:
- Enviar mensajes al COO para consultas operativas
- Coordinar con otros directores si una tarea cruza departamentos
- Usá \`sessions_send\` para comunicarte directamente

### Cómo escribir en Notion:
Usá curl con la API de Notion (version \`2022-06-28\`):
- Para escribir en el body de una tarea: \`PATCH /v1/blocks/{block_id}/children\`
- Para cambiar estado: \`PATCH /v1/pages/{page_id}\` con \`properties.Estado.status.name\`
- Formato de bloques: \`paragraph\`, \`heading_2\`, \`bulleted_list_item\`

### Notion IDs de referencia:
- DB Tareas: \`c4fec2e0-dcb2-4e74-bfd6-40313b0ab3f3\`
- DB Proyectos: \`3091f347-f349-8189-99bc-d21d0cb0d172\`

## Reglas

- Siempre escribí tus resultados en Notion (no por chat)
- Cambiá el estado a "En Revisión" cuando termines
- Si la tarea no es clara, escribí tus dudas como comentario en la tarea
- Comunicá en español
- Sé conciso pero completo en tus entregables
`;
  }

  // Employee template
  return `# AGENTS.md — ${rolLabel}

## Tu Rol

Sos ${rolLabel} del departamento de ${departamento} en AI Team. Ejecutás tareas específicas asignadas por tu director o directamente por el usuario.

## Cada Sesión

1. Leé \`SOUL.md\`
2. Leé \`memory/\` del día para contexto
3. Ejecutá la tarea asignada

## Cómo Trabajás

1. Leé la tarea completa (título + descripción + contexto)
2. Ejecutá según tus skills y el contexto proporcionado
3. Escribí el resultado en el body de la tarea en Notion
4. Cambiá el estado a "En Revisión"

### Comunicación con otros agentes
Tenés habilitada la comunicación agent-to-agent. Podés:
- Consultar a tu director si necesitás clarificación
- Coordinar con otros empleados del departamento
- Contactar al COO para temas operativos

### Cómo escribir en Notion:
Usá curl con la API de Notion (version \`2022-06-28\`):
- Para escribir en el body: \`PATCH /v1/blocks/{block_id}/children\`
- Para cambiar estado: \`PATCH /v1/pages/{page_id}\` con \`properties.Estado.status.name\`
- Formato: \`paragraph\`, \`heading_2\`, \`bulleted_list_item\`

### Notion IDs de referencia:
- DB Tareas: \`c4fec2e0-dcb2-4e74-bfd6-40313b0ab3f3\`

## Reglas

- Escribí resultados en Notion, no por chat
- Cambiá estado a "En Revisión" al terminar
- Si algo no es claro, comentá en la tarea
- Comunicá en español
- Enfocate en calidad: mejor un buen entregable que uno rápido
`;
}

function soulTemplate(personalidad, tono, limites) {
  return `# SOUL.md

## Personalidad

${personalidad}

## Tono

Hablás en español. ${tono}

## Límites

${limites || `- Ejecutás solo las tareas asignadas a tu rol
- Escribís resultados en Notion, no enviás mensajes por chat
- Si algo escapa tu competencia, lo indicás claramente`}
`;
}

function identityTemplate(name, rol, vibe, emoji) {
  return `# IDENTITY.md

- **Name:** ${name}
- **Creature:** ${rol}
- **Vibe:** ${vibe}
- **Emoji:** ${emoji}
`;
}

const HEARTBEAT_TEMPLATE = `# HEARTBEAT.md

# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want the agent to check something periodically.
`;

const TOOLS_TEMPLATE = `# TOOLS.md

## Herramientas Disponibles

### Notion API
- Usá \`curl\` via exec para interactuar con Notion
- Version: \`2022-06-28\`
- Auth: Bearer token (disponible via skill de Notion)
- Endpoint base: \`https://api.notion.com/v1/\`

### Filesystem
- Podés crear archivos y directorios con \`write\` y \`exec\`

### Limitaciones
- NO podés reiniciar Docker
- NO podés ejecutar comandos del host fuera del container
`;

const USER_TEMPLATE = `# USER.md - About Your Human

_Learn about the person you're helping. Update this as you go._

- **Name:**
- **What to call them:**
- **Pronouns:** _(optional)_
- **Timezone:**
- **Notes:**

## Context

_(What do they care about? What projects are they working on? What annoys them? What makes them laugh? Build this over time.)_

---

The more you know, the better you can help. But remember — you're learning about a person, not building a dossier. Respect the difference.
`;

// --- Main handler ---

export async function createAgent(req, res) {
  const {
    id, name, rol, identity, personalidad, tono, limites,
    departamento, skills, vibe, emoji,
  } = req.body;

  // 1. Validate
  if (!id || !name || !rol || !personalidad || !tono) {
    return res.status(400).json({
      error: 'Missing required fields: id, name, rol, personalidad, tono',
    });
  }

  if (!/^[a-z0-9-]+$/.test(id)) {
    return res.status(400).json({
      error: 'id must be a valid slug (lowercase alphanumeric + hyphens)',
    });
  }

  // Check openclaw.json for duplicate
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
    // 2. Backup openclaw.json
    const timestamp = Date.now();
    const backupPath = `${OPENCLAW_JSON}.bak.${timestamp}`;
    copyFileSync(OPENCLAW_JSON, backupPath);
    console.log(`[agent-creator] Backed up openclaw.json → ${backupPath}`);

    // 3. Create directories
    const agentHostDir = `${AGENTS_BASE_HOST}/${id}`;
    mkdirSync(`${agentHostDir}/workspace/memory`, { recursive: true });
    mkdirSync(`${agentHostDir}/workspace/skills`, { recursive: true });
    mkdirSync(`${agentHostDir}/agent`, { recursive: true });
    console.log(`[agent-creator] Created directories for "${id}"`);

    // 4. Write workspace files
    const rolLabel = identity || name;
    const dept = departamento || 'General';
    const agentEmoji = emoji || '🤖';
    const agentVibe = vibe || 'Profesional, eficiente, orientado a resultados';

    writeFileSync(`${agentHostDir}/workspace/AGENTS.md`,
      agentsTemplate(rol, dept, rolLabel));
    writeFileSync(`${agentHostDir}/workspace/SOUL.md`,
      soulTemplate(personalidad, tono, limites));
    writeFileSync(`${agentHostDir}/workspace/IDENTITY.md`,
      identityTemplate(name, rolLabel, agentVibe, agentEmoji));
    writeFileSync(`${agentHostDir}/workspace/HEARTBEAT.md`, HEARTBEAT_TEMPLATE);
    writeFileSync(`${agentHostDir}/workspace/TOOLS.md`, TOOLS_TEMPLATE);
    writeFileSync(`${agentHostDir}/workspace/USER.md`, USER_TEMPLATE);
    console.log(`[agent-creator] Wrote workspace files for "${id}"`);

    // 5. Copy auth-profiles.json
    if (existsSync(AUTH_PROFILES_SRC)) {
      copyFileSync(AUTH_PROFILES_SRC, `${agentHostDir}/agent/auth-profiles.json`);
      console.log(`[agent-creator] Copied auth-profiles.json`);
    } else {
      console.warn(`[agent-creator] auth-profiles.json not found at ${AUTH_PROFILES_SRC}`);
    }

    // 6. Update openclaw.json
    const newAgentEntry = {
      id,
      name,
      workspace: `${AGENTS_BASE_CONTAINER}/${id}/workspace`,
      agentDir: `${AGENTS_BASE_CONTAINER}/${id}/agent`,
      identity: { name: identity || name },
    };
    openclawConfig.agents.list.push(newAgentEntry);
    writeFileSync(OPENCLAW_JSON, JSON.stringify(openclawConfig, null, 2));
    console.log(`[agent-creator] Added "${id}" to openclaw.json`);

    // 7. Restart Docker
    try {
      execSync('cd /root/openclaw && docker compose restart openclaw-gateway', {
        timeout: 60_000,
        stdio: 'pipe',
      });
      console.log(`[agent-creator] Docker restarted`);
    } catch (dockerErr) {
      console.error(`[agent-creator] Docker restart failed:`, dockerErr.message);
      // Don't fail the request — agent was created, just needs manual restart
    }

    // 8. Refresh agent cache
    try {
      await refreshAgentCache();
      console.log(`[agent-creator] Agent cache refreshed`);
    } catch (cacheErr) {
      console.warn(`[agent-creator] Cache refresh failed:`, cacheErr.message);
    }

    // 9. Return success
    res.json({
      success: true,
      agentId: id,
      message: `Agent "${name}" (${id}) created successfully. Workspace at ${agentHostDir}, registered in openclaw.json, Docker restarted.`,
    });

  } catch (err) {
    console.error(`[agent-creator] Error creating agent:`, err);
    res.status(500).json({ error: err.message });
  }
}
