# CLAUDE.md — AI Team Orchestrator

## What This Is

A lightweight Node.js service that bridges **Notion** (task management) with **OpenClaw** (AI agent runtime). When a task changes state in Notion, the orchestrator dispatches it to the right AI agent via OpenClaw's hooks API.

## Architecture

```
Notion DB ──webhook──▶ Orchestrator (port 3500)
                             │
                    ┌────────┴────────┐
                    │                 │
               Webhook handler    DB Poller
                    │                 │
                    └────────┬────────┘
                             ▼
                    OpenClaw Gateway (port 18789)
                             │
                    ┌────────┴────────┐
                    ▼                 ▼
               Agent: COO       Agent: mkt-director   ...
```

## Key Files

- `src/index.js` — Express server, all HTTP endpoints
- `src/config.js` — Reads `.env` into a typed config object (no dotenv dep)
- `src/webhook-handler.js` — Processes Notion webhook events (page updates, comments)
- `src/poller.js` — Polls Notion DB for pending tasks (fallback / primary mode)
- `src/agent-cache.js` — Loads agent definitions from the Notion Agents DB
- `src/agent-creator.js` — Creates new OpenClaw agents (files + openclaw.json + Docker restart)
- `src/openclaw-client.js` — HTTP client for the OpenClaw `/hooks/agent` endpoint
- `src/notion-client.js` — Thin wrapper around the Notion REST API
- `src/message-builder.js` — Builds the prompt sent to each agent

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Uptime, polling status, dispatch count |
| POST | `/webhook/notion` | Notion webhook receiver (verifies HMAC signature) |
| POST | `/dispatch` | Manually dispatch a Notion task by ID |
| POST | `/agents/create` | Create a new OpenClaw agent |
| GET | `/agents` | List cached agents |
| POST | `/agents/refresh` | Reload agents from Notion |
| POST | `/poller/start` | Start the DB poller |
| POST | `/poller/stop` | Stop the DB poller |
| GET | `/poller/status` | Poller state |

## Development

```bash
cp .env.example .env
# fill in your credentials
npm install
npm run dev   # node --watch
```

## Important Conventions

- **API key storage**: All secrets live in `.env` only — never hardcoded.
- **Notion API version**: Always `2022-06-28`. The 2025-09-03 version has known bugs with `properties`.
- **Task statuses that trigger dispatch**: `Pendiente`, `En progreso`, `Necesita Correcciones`.
- **Agent creation**: Always use `POST /agents/create` — never edit `openclaw.json` directly.
- **Docker**: Agent creation restarts the OpenClaw Docker container automatically (`cd /root/openclaw && docker compose restart openclaw-gateway`). This path is host-specific; adapt if deploying elsewhere.
- **Duplicate event guard**: `data/dispatched.json` tracks dispatched task+status pairs to prevent double-dispatch.
- **Language**: All agent prompts and Notion interactions are in Spanish.

## Sensitive Files (never commit)

- `.env` — API keys and secrets
- `data/dispatched.json` — runtime state (gitignored)

See `docs/setup-openclaw.md` for how to set up the OpenClaw agents that run alongside this service.
