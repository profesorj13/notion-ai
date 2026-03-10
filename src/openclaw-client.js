import { config } from './config.js';

/**
 * Dispatch a task to an OpenClaw agent via POST /hooks/agent.
 * Returns immediately with 202 Accepted — OpenClaw handles execution async.
 */
export async function dispatchToAgent({
  message,
  agentId = 'main',
  sessionKey,
  name,
  deliver = false,
  channel,
  to,
  thinking = 'medium',
  timeoutSeconds = 300,
}) {
  const body = {
    message,
    agentId,
    thinking,
    timeoutSeconds,
  };

  if (sessionKey) body.sessionKey = sessionKey;
  if (name) body.name = name;
  if (deliver) body.deliver = deliver;
  if (channel) body.channel = channel;
  if (to) body.to = to;

  const res = await fetch(`${config.openclaw.url}/hooks/agent`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.openclaw.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const status = res.status;
  const text = await res.text();
  let responseBody;
  try {
    responseBody = JSON.parse(text);
  } catch {
    responseBody = text;
  }

  return { status, body: responseBody };
}
