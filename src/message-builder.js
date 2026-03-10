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
 * Only passes context data — the COO's create-agent skill has all the steps.
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
    parts.push(`\n⚠️ **Reintento.** El proceso anterior no se completó. Revisá qué pasos ya se hicieron (¿existen los dirs? ¿está en openclaw.json? ¿existen los .md?) y continuá desde donde quedó.`);
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

  parts.push(`\n---\nUsá tu skill \`create-agent\` para crear este agente. Seguí todos los pasos del skill.`);

  return parts.join('\n\n');
}
