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
 * Build a message when an agent is woken up by a page-level comment.
 * Includes any pending inline comments collected before this trigger.
 */
export function buildCommentReplyMessage({
  taskTitle,
  taskId,
  commentText,
  commentAuthor,
  discussionId,
  inlineComments = [],
}) {
  const parts = [];

  parts.push(`## Feedback en tu tarea: ${taskTitle}`);

  // Include inline comments first (they are the feedback on specific content)
  if (inlineComments.length > 0) {
    parts.push(`### Comentarios inline (sobre el contenido)`);
    for (const ic of inlineComments) {
      if (ic.blockText) {
        parts.push(`- **${ic.author}** (sobre: "${ic.blockText.substring(0, 300)}"): "${ic.text}"`);
      } else {
        parts.push(`- **${ic.author}**: "${ic.text}"`);
      }
    }
  }

  // Then the page-level comment that triggered this
  parts.push(`### Mensaje de activación (comentario de página)`);
  parts.push(`**${commentAuthor}** escribió:\n> ${commentText}`);

  if (discussionId) {
    parts.push(`Discussion ID (para responder en el hilo de página): \`${discussionId}\``);
  }

  parts.push(`Revisá los comentarios inline, aplicá los cambios necesarios, y respondé en el hilo de página confirmando lo que hiciste. Nota: el contexto "sobre" de cada comentario inline es el bloque principal donde se ancló, pero la selección del usuario puede abarcar bloques vecinos. Evaluá si tiene sentido ajustar también contenido cercano.`);

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
