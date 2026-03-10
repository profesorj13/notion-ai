# Setup Outside This Repo — OpenClaw Agents

This orchestrator dispatches tasks to AI agents that run inside **OpenClaw**, a separate AI agent runtime. The agents themselves live in the OpenClaw installation directory (typically `/root/.openclaw/` on the host machine) and are **not** part of this repository.

This document describes how to recreate the full agent setup from scratch.

---

## Prerequisites

- OpenClaw installed and running (Docker recommended)
- This orchestrator running on port `3500`
- A Notion workspace with the required databases (see `.env.example`)

---

## OpenClaw Directory Structure

```
/root/.openclaw/
├── openclaw.json              # Main config (gateway, agents list, auth, skills)
├── identity/
│   ├── device.json            # Device identity (auto-generated)
│   └── device-auth.json       # Operator auth token (auto-generated)
├── workspace/                 # Main agent workspace (agent "main")
│   ├── IDENTITY.md
│   ├── SOUL.md
│   ├── AGENTS.md
│   ├── TOOLS.md
│   ├── USER.md
│   └── memory/
├── agents/
│   ├── main/                  # Primary agent
│   ├── coo/                   # COO agent
│   ├── alexa/                 # Alexa agent
│   └── mkt-director/          # Marketing Director agent
└── credentials/               # Auth tokens (auto-generated, never commit)
```

---

## `openclaw.json` — Structure Reference

> **Never commit this file** — it contains API keys and auth tokens.

Key sections to configure:

```json
{
  "gateway": {
    "port": 18789,
    "bind": "0.0.0.0",
    "auth": {
      "token": "<your-gateway-auth-token>"
    }
  },
  "hooks": {
    "token": "<must match OPENCLAW_TOKEN in orchestrator .env>"
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "name": "Mari",
        "workspace": "/home/node/.openclaw/workspace",
        "agentDir": "/home/node/.openclaw/agents/main/agent",
        "identity": { "name": "Mari" }
      }
    ]
  },
  "tools": {
    "web": {
      "search": {
        "apiKey": "<SerpAPI or compatible key>"
      }
    }
  },
  "skills": {
    "entries": {
      "notion": {
        "apiKey": "<same NOTION_API_KEY as orchestrator>"
      }
    }
  }
}
```

---

## Agents

### How Agents Are Created

The preferred way to create new agents is via the orchestrator endpoint:

```bash
curl -s -X POST http://localhost:3500/agents/create \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my-agent",
    "name": "My Agent",
    "rol": "director",
    "identity": "Director de Algo",
    "personalidad": "Estratégico, analítico, orientado a resultados.",
    "tono": "Profesional pero cercano.",
    "departamento": "Marketing",
    "skills": ["research", "writing"],
    "vibe": "Estratégico, creativo, directo",
    "emoji": "📊"
  }'
```

This endpoint:
1. Creates the workspace directory structure under `/root/.openclaw/agents/<id>/`
2. Writes all required markdown files (IDENTITY.md, SOUL.md, AGENTS.md, TOOLS.md, HEARTBEAT.md, USER.md)
3. Copies `auth-profiles.json` from the `main` agent so the new agent can use Notion
4. Adds the agent to `openclaw.json`
5. Restarts the OpenClaw Docker container

> **Note:** The `rol` field must be either `"director"` (manages a team) or `"empleado"` (executes tasks directly).

---

### Existing Agents

#### `main` — Mari (Primary Assistant)

- **Role:** General-purpose personal assistant
- **Channel:** WhatsApp (primary), direct chat
- **Language:** Spanish
- **Responsibilities:** Handles direct user requests, coordinates with other agents, manages memory

Workspace files to create manually:

**`IDENTITY.md`**
```markdown
# IDENTITY.md

- **Name:** Mari
- **Creature:** Secretaria AI — atenta, organizada, no se le escapa nada
- **Vibe:** Cálida, directa, eficiente. Habla en español. Tono profesional pero cercano.
- **Emoji:** 📋
```

**`SOUL.md`** — Define values, limits, and continuity principles for the agent. Key points:
- Speaks in Spanish
- Does not exfiltrate data without explicit user permission
- Asks before taking external actions
- Maintains memory across sessions via daily notes in `memory/YYYY-MM-DD.md`

**`AGENTS.md`** — Operational rules: memory management, heartbeat polling, group chat etiquette, Notion writing instructions.

**`TOOLS.md`** — Configure available tools: Notion DB IDs, API version (`2022-06-28`), WhatsApp target number, etc.

---

#### `coo` — COO ⚙️

- **Role:** Chief Operating Officer — system architect
- **Responsibilities:** Creates and configures new agents, evaluates system health, manages agent templates
- **Key capability:** Calls `POST /agents/create` on the orchestrator to provision new agents

**`AGENTS.md`** key content:
- Full instructions for creating agents via the orchestrator API
- Reference to Notion DB IDs (Tareas, Agentes, Proyectos)
- Rules: never edit `openclaw.json` directly, always confirm with user before creating agents

---

#### `alexa` — Mari Alexa

- **Role:** Personal assistant variant (secondary)
- **Channel:** As configured

---

#### `mkt-director` — Director de Marketing 📈

- **Role:** Marketing department director
- **Type:** `director` (manages team, can delegate)
- **Responsibilities:** Strategy, research, communication
- **Vibe:** Strategic, creative, analytical, results-oriented

---

## Agent Workspace File Reference

Each agent needs these files under `workspace/`:

| File | Purpose |
|------|---------|
| `IDENTITY.md` | Name, creature type, vibe, emoji |
| `SOUL.md` | Values, personality, tone, limits |
| `AGENTS.md` | Operational instructions: how to work, Notion integration, rules |
| `TOOLS.md` | Available tools and their configuration |
| `HEARTBEAT.md` | Periodic tasks (leave empty to disable) |
| `USER.md` | Notes about the human the agent works with |
| `memory/` | Daily session notes (auto-written by agent) |

---

## Notion Database Setup

The orchestrator expects three databases in your Notion workspace:

### DB Tareas (Tasks)
Required properties:
| Property | Type | Notes |
|----------|------|-------|
| Tarea / Nombre | Title | Task title |
| Estado | Status | `Pendiente`, `En progreso`, `En Revisión`, `Necesita Correcciones`, `Completada` |
| Agente IA | Relation | → DB Agentes |
| Proyecto (link) | Relation | → DB Proyectos |

### DB Agentes (Agents)
Required properties:
| Property | Type | Values |
|----------|------|--------|
| Nombre | Title | — |
| Rol | Select | `director`, `empleado` |
| Tipo | Select | `ia`, `humano` |
| Estado | Select | `borrador`, `nuevo`, `creando...`, `activo`, `necesita definiciones`, `inactivo` |
| OpenClaw Agent ID | Rich text | Agent slug (e.g. `mkt-director`) |
| Skills | Multi-select | Free-form |
| Departamento | Select | Free-form |

### DB Proyectos (Projects)
Referenced by tasks to provide project context to agents.

---

## Notion Integration Setup

1. Go to https://www.notion.so/my-integrations
2. Create a new integration, copy the API key → `NOTION_API_KEY`
3. Share each database with the integration
4. Copy each database ID from the URL → `.env`

### Webhook Setup (optional, for real-time dispatch)

1. In the Notion integration dashboard, enable webhooks
2. Point to `https://your-host:3500/webhook/notion`
3. Copy the verification token when prompted (the server logs it)
4. Copy the webhook signing secret → `NOTION_WEBHOOK_SECRET`

If webhooks aren't set up, the orchestrator falls back to DB polling.

---

## Docker Compose Reference

The orchestrator's `agent-creator.js` restarts OpenClaw with:

```bash
cd /root/openclaw && docker compose restart openclaw-gateway
```

Make sure the `openclaw` directory exists at that path on the host, or adjust the command in `src/agent-creator.js`.

---

## Security Notes

- `openclaw.json` contains multiple API keys — **never commit it**
- `identity/device-auth.json` contains the operator token — **never commit it**
- `credentials/` directory contains pairing tokens — **never commit it**
- Use environment variables for all secrets; see `.env.example`
