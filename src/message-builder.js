/**
 * Build the prompt message sent to an OpenClaw agent for a task.
 * Combines: pre-instructions + task context + project brief + feedback
 */
export function buildMessage({
  taskTitle,
  taskBody,
  projectBrief,
  preInstrucciones,
  feedback,
  taskUrl,
  taskId,
}) {
  const parts = [];

  if (preInstrucciones) {
    parts.push(`## Tus instrucciones base\n${preInstrucciones}`);
  }

  parts.push(`## Tarea asignada: ${taskTitle}`);
  parts.push(`ID Notion: ${taskId}`);
  if (taskUrl) parts.push(`URL: ${taskUrl}`);

  if (taskBody) {
    parts.push(`\n### Detalle de la tarea\n${taskBody}`);
  }

  if (projectBrief) {
    parts.push(`\n### Contexto del proyecto\n${projectBrief}`);
  }

  if (feedback) {
    parts.push(`\n### Feedback / Correcciones solicitadas\n${feedback}`);
  }

  parts.push(`\n---\n**Importante:** Cuando termines, actualizá el estado de la tarea en Notion a "En Revisión" usando la API de Notion (PATCH /pages/${taskId} con properties.Estado.select.name = "En Revisión"). Escribí tus resultados en el body de la página de la tarea.`);

  return parts.join('\n\n');
}

/**
 * Build a lightweight message when an agent is woken up by a comment.
 * The agent already has task context from its session and knows how to use
 * the Notion API from its AGENTS.md — we only send the comment itself.
 */
export function buildCommentReplyMessage({
  taskTitle,
  taskId,
  commentText,
  commentAuthor,
  discussionId,
}) {
  const parts = [];

  parts.push(`## Nuevo comentario en tu tarea: ${taskTitle}`);
  parts.push(`**${commentAuthor}** escribió:\n> ${commentText}`);

  if (discussionId) {
    parts.push(`Discussion ID (para responder en el hilo): \`${discussionId}\``);
  }

  parts.push(`Respondé en el hilo del comentario en Notion.`);

  return parts.join('\n\n');
}

/**
 * Build the prompt for the COO when setting up a new agent.
 * Includes agent card info + instructions to use /agents/create endpoint.
 */
export function buildAgentSetupMessage({
  agentPageId,
  agentName,
  agentBody,
  agentProperties,
  agentUrl,
  isRetry,
}) {
  const parts = [];

  parts.push(`## Tarea: Crear agente "${agentName}"`);
  parts.push(`Notion Page ID: ${agentPageId}`);
  if (agentUrl) parts.push(`URL: ${agentUrl}`);

  if (isRetry) {
    parts.push(`\n⚠️ **El usuario respondió tus preguntas.** Revisá el contexto anterior de esta sesión y evaluá si ahora tenés suficiente información para crear el agente.`);
  }

  parts.push(`\n### Información del agente (card de Notion)`);

  if (agentProperties) {
    const propLines = [];
    for (const [key, value] of Object.entries(agentProperties)) {
      if (value) propLines.push(`- **${key}:** ${value}`);
    }
    if (propLines.length > 0) parts.push(propLines.join('\n'));
  }

  if (agentBody) {
    parts.push(`\n### Contenido de la card\n${agentBody}`);
  }

  parts.push(`\n---\n### Instrucciones

Evaluá si la información es suficiente para crear el agente. Necesitás como mínimo:
- Un id (slug, ej: \`mkt-researcher\`)
- Un nombre
- Un rol (\`director\` o \`empleado\`)
- Una personalidad (cómo se comporta)
- Un tono (cómo habla)
- Un departamento
- Un emoji

**Si la info es suficiente:**

1. Proponé el agente (id, nombre, rol, personalidad, etc.) basándote en la info de la card
2. Creá el agente usando el endpoint del orquestador:

\`\`\`bash
curl -s -X POST http://host.docker.internal:3500/agents/create \\
  -H "Content-Type: application/json" \\
  -d '{
    "id": "<slug>",
    "name": "<Nombre>",
    "rol": "<director|empleado>",
    "identity": "<Nombre completo del rol>",
    "personalidad": "<descripción de personalidad>",
    "tono": "<descripción de tono>",
    "limites": "<límites opcionales>",
    "departamento": "<departamento>",
    "skills": ["skill1", "skill2"],
    "vibe": "<3-4 adjetivos>",
    "emoji": "<emoji>"
  }'
\`\`\`

3. Si la respuesta es exitosa, actualizá la card en Notion:
   - Seteá "OpenClaw Agent ID" al id del agente
   - Cambiá "Estado" a \`activo\`

4. Actualizá tu registry (\`registry/agents.md\`) con el nuevo agente

**Si la info NO es suficiente:**

1. Escribí tus preguntas en el body de la card en Notion (agregá bloques, no borres lo existente)
2. Cambiá el estado a \`necesita definiciones\` usando la API de Notion:

\`\`\`bash
curl -s -X PATCH "https://api.notion.com/v1/pages/${agentPageId}" \\
  -H "Authorization: Bearer <NOTION_API_KEY>" \\
  -H "Content-Type: application/json" \\
  -H "Notion-Version: 2022-06-28" \\
  -d '{"properties": {"Estado": {"select": {"name": "necesita definiciones"}}}}'
\`\`\`

Nota: Usá el token de Notion disponible en tu skill de Notion para autenticarte.`);

  return parts.join('\n\n');
}
