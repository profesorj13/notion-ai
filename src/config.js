import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env manually (no dotenv dependency)
const envPath = resolve(import.meta.dirname, '..', '.env');
const envContent = readFileSync(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx);
  const val = trimmed.slice(eqIdx + 1);
  if (!process.env[key]) process.env[key] = val;
}

export const config = {
  port: parseInt(process.env.PORT || '3500'),
  webhookSecret: process.env.WEBHOOK_SECRET,

  notion: {
    apiKey: process.env.NOTION_API_KEY,
    version: process.env.NOTION_VERSION || '2022-06-28',
    tareasDb: process.env.NOTION_TAREAS_DB,
    proyectosDb: process.env.NOTION_PROYECTOS_DB,
    agentesDb: process.env.NOTION_AGENTES_DB,
    webhookSecret: process.env.NOTION_WEBHOOK_SECRET || '',
  },

  openclaw: {
    url: process.env.OPENCLAW_URL || 'http://127.0.0.1:18789',
    token: process.env.OPENCLAW_TOKEN,
  },
};
