# AI Team Orchestrator

Lightweight Node.js service that connects **Notion** (task management) with **OpenClaw** (AI agent runtime).

When a task changes state in Notion, the orchestrator finds the assigned AI agent and dispatches the task to it via OpenClaw's hooks API.

## How It Works

```
Notion DB ──webhook──▶ Orchestrator (port 3500) ──▶ OpenClaw Gateway ──▶ AI Agent
                              │
                         DB Poller (fallback)
```

1. A task in Notion is assigned to an AI agent and set to `Pendiente`
2. The orchestrator picks it up (via webhook or polling)
3. It builds a prompt with task title, body, and project context
4. It dispatches to the correct OpenClaw agent
5. The agent executes and writes results back to Notion

## Quick Start

```bash
git clone https://github.com/profesorj13/notion-ai.git
cd notion-ai
cp .env.example .env
# Edit .env with your credentials
npm install
npm run dev
```

## Configuration

Copy `.env.example` to `.env` and fill in:

- `NOTION_API_KEY` — from https://www.notion.so/my-integrations
- `NOTION_TAREAS_DB`, `NOTION_PROYECTOS_DB`, `NOTION_AGENTES_DB` — database IDs from Notion URLs
- `OPENCLAW_URL` — OpenClaw gateway URL (default: `http://127.0.0.1:18789`)
- `OPENCLAW_TOKEN` — must match `hooks.token` in `openclaw.json`
- `NOTION_WEBHOOK_SECRET` — from Notion integration dashboard (optional, enables real-time dispatch)

## API

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |
| `POST /webhook/notion` | Notion webhook receiver |
| `POST /dispatch` | Manually dispatch a task `{ taskId }` |
| `POST /agents/create` | Create a new OpenClaw agent |
| `GET /agents` | List agents from cache |
| `POST /poller/start\|stop` | Control DB polling |

## OpenClaw Setup

The AI agents run inside OpenClaw, which is configured separately from this repo.

See **[docs/setup-openclaw.md](docs/setup-openclaw.md)** for the full setup guide including:
- Directory structure for agent workspaces
- How to create and configure agents
- Notion database schema
- Security notes

## Requirements

- Node.js 20+
- OpenClaw running locally or via Docker
- Notion workspace with the required databases
