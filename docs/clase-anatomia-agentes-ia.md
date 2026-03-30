# Clase: Anatomia de Sistemas de Agentes IA — De Claude Code a tu Orquestador

## Contexto
Esta clase cubre como funcionan internamente los 3 sistemas que ya usas (Claude Code, OpenClaw, tu Orchestrator) y el script dev-task.sh que acabamos de crear. El objetivo es que entiendas las piezas fundamentales para construir y operar agentes autonomos de desarrollo.

---

## 1. LOS 3 NIVELES DE ABSTRACCION

```
┌─────────────────────────────────────────────────────────────────┐
│  NIVEL 3: ORQUESTACION (tu orchestrator + Notion)               │
│  "Quien hace que, cuando, y con que contexto"                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  NIVEL 2: AGENTE (OpenClaw / Paperclip / Cyrus)          │  │
│  │  "Personalidad, memoria, herramientas, sesiones"          │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │  NIVEL 1: LLM + TOOLS (Claude Code CLI / API)      │  │  │
│  │  │  "Razonamiento + ejecucion de acciones"             │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

Cada nivel agrega una capa de abstraccion sobre el anterior. Entender donde termina uno y empieza otro es la clave para disenar estos sistemas.

---

## 2. NIVEL 1: CLAUDE CODE CLI — El Motor

### Que ES Claude Code

Claude Code es un **proceso Node.js local** que:
1. Lee archivos del disco
2. Envia contexto a la API de Anthropic (cloud)
3. Recibe instrucciones del LLM
4. Ejecuta acciones localmente (editar archivos, correr comandos)
5. Repite hasta terminar

```
Tu maquina (o VPS)
┌──────────────────────────────────────────────────────┐
│  claude -p "arregla el bug de login"                  │
│  │                                                    │
│  │  ┌──────────┐    HTTPS     ┌──────────────────┐  │
│  │  │ Contexto │ ──────────→  │  API Anthropic   │  │
│  │  │ (archivos│ ←──────────  │  (Claude model)  │  │
│  │  │  + prompt)│   respuesta  │                  │  │
│  │  └──────────┘              └──────────────────┘  │
│  │       │                                           │
│  │       ▼                                           │
│  │  ┌──────────┐                                     │
│  │  │ Tools:   │ ← Ejecuta LOCALMENTE               │
│  │  │ Read     │   (lee src/auth.js del disco)       │
│  │  │ Edit     │   (modifica el archivo)             │
│  │  │ Bash     │   (corre npm test)                  │
│  │  │ Grep     │   (busca en el codigo)              │
│  │  │ Glob     │   (encuentra archivos)              │
│  │  │ Write    │   (crea archivos nuevos)            │
│  │  └──────────┘                                     │
│  │       │                                           │
│  │       ▼                                           │
│  │  Repite (turn 2, 3, ... N)                        │
│  │  hasta --max-turns o hasta que el LLM diga "listo"│
└──────────────────────────────────────────────────────┘
```

### El Agentic Loop (Loop de Agente)

Este es el concepto mas importante. **Todo agente es un loop:**

```
         ┌──────────────────┐
         │   System Prompt   │ ← Personalidad, reglas, contexto
         │   + User Message  │
         └────────┬─────────┘
                  │
         ┌────────▼─────────┐
         │    LLM piensa     │ ← API call a Anthropic
         │    (razonamiento) │
         └────────┬─────────┘
                  │
            ┌─────▼─────┐
            │ Respuesta  │
            └─────┬─────┘
                  │
          ┌───────▼────────┐
    ┌─────┤ Tiene tool_use?├─────┐
    │ NO  └────────────────┘ SI  │
    │                            │
    ▼                    ┌───────▼────────┐
  FIN                    │ Ejecuta tool   │
  (output)               │ (Read, Edit,   │
                         │  Bash, etc.)   │
                         └───────┬────────┘
                                 │
                         ┌───────▼────────┐
                         │ tool_result    │
                         │ se agrega al   │
                         │ contexto       │
                         └───────┬────────┘
                                 │
                         ┌───────▼────────┐
                         │ LLM piensa     │ ← Nuevo API call
                         │ de nuevo       │   con el resultado
                         └───────┬────────┘
                                 │
                            (repite)
```

**Cada "turn" es un ciclo completo**: LLM piensa → decide tool → ejecuta → resultado vuelve → LLM piensa de nuevo.

### Modos de Ejecucion

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLAUDE CODE CLI                               │
│                                                                  │
│  Interactivo (este chat):                                       │
│  $ claude                                                        │
│  → Terminal interactiva, pide permisos, muestra UI              │
│  → Sesion persistente (puedes hacer /resume)                    │
│  → Lee CLAUDE.md del directorio                                 │
│  → Carga hooks, MCP servers, settings                           │
│                                                                  │
│  Headless/Print (dev-task.sh usa esto):                         │
│  $ claude -p "prompt" --dangerously-skip-permissions            │
│  → Ejecuta sin UI, sin pedir permisos                           │
│  → Ideal para automatizacion                                    │
│  → Mismo motor, mismas tools, misma inteligencia                │
│  → --max-turns limita cuantos ciclos puede hacer                │
│                                                                  │
│  Flags clave para automatizacion:                               │
│  --system-prompt "..."       Override del system prompt          │
│  --append-system-prompt "..."  Agrega al default                │
│  --model sonnet|opus         Elige modelo                       │
│  --max-turns 50              Limite de ciclos                   │
│  --max-budget-usd 5          Limite de gasto                    │
│  --allowedTools Edit,Bash    Restringe herramientas             │
│  --output-format stream-json  Para parsear output               │
│  --dangerously-skip-permissions  No pide confirmacion           │
│  -r, --resume <session-id>   Retoma sesion anterior             │
└─────────────────────────────────────────────────────────────────┘
```

### Como se Construye el Contexto (System Prompt)

Cuando vos abris `claude` en un directorio, esto es lo que pasa internamente:

```
System prompt final = (en orden de prioridad)
  1. Instrucciones base de Anthropic (hardcoded)
     "You are Claude Code, Anthropic's CLI..."
     + reglas de seguridad, tools disponibles, formato

  2. CLAUDE.md del proyecto (si existe)
     Se carga AUTOMATICAMENTE del directorio de trabajo
     + CLAUDE.md del home (~/.claude/CLAUDE.md)
     + CLAUDE.md del proyecto parent
     → Es como un .env pero para el agente

  3. Auto-memory (si existe)
     ~/.claude/projects/{project}/memory/MEMORY.md
     + archivos .md individuales referenciados
     → Persistente entre sesiones

  4. MCP servers configurados
     Cada MCP server agrega tools y/o resources
     → Se inyectan en el system prompt como tools disponibles

  5. Settings del usuario
     ~/.claude/settings.json
     → Permisos, modelos, preferencias

  6. Hooks (si configurados)
     → Shell commands que corren en eventos (pre-edit, post-commit, etc.)
```

**Punto clave**: El CLAUDE.md es el mecanismo principal para "programar" el comportamiento del agente. Es tu system prompt declarativo.

---

## 3. NIVEL 2: OPENCLAW — El Framework de Agentes

OpenClaw agrega sobre Claude Code:

```
┌─────────────────────────────────────────────────────────────┐
│  OPENCLAW GATEWAY (Docker, puerto 18789)                    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  AGENTES (definidos en openclaw.json)                │    │
│  │                                                      │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐          │    │
│  │  │  main    │  │  coo     │  │  lucia   │  ...     │    │
│  │  │  (Mari)  │  │  (COO)   │  │  (Lucia) │          │    │
│  │  │          │  │          │  │          │          │    │
│  │  │ identity │  │ identity │  │ identity │          │    │
│  │  │ workspace│  │ workspace│  │ workspace│          │    │
│  │  │ skills   │  │ skills   │  │ skills   │          │    │
│  │  │ memory   │  │ memory   │  │ memory   │          │    │
│  │  │ sessions │  │ sessions │  │ sessions │          │    │
│  │  └──────────┘  └──────────┘  └──────────┘          │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  CANALES (WhatsApp, hooks HTTP, etc.)                │    │
│  │                                                      │    │
│  │  mensaje entrante                                    │    │
│  │       │                                              │    │
│  │       ▼                                              │    │
│  │  ┌─────────────┐    ┌─────────────┐                 │    │
│  │  │  Bindings   │───→│  Session Key │                 │    │
│  │  │  (routing)  │    │  Builder     │                 │    │
│  │  └─────────────┘    └──────┬──────┘                 │    │
│  │                            │                         │    │
│  │                    ┌───────▼──────┐                  │    │
│  │                    │ Agent Wake   │                  │    │
│  │                    │ (con sesion) │                  │    │
│  │                    └──────────────┘                  │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### Lo que OpenClaw agrega vs Claude Code puro:

| Feature | Claude Code solo | OpenClaw |
|---------|-----------------|----------|
| Identidad | CLAUDE.md | `identity.name` + agentDir |
| Memoria | auto-memory local | Vector embeddings + search |
| Sesiones | `--resume` manual | Automatico por session key |
| Multi-agente | N/A | Routing por bindings |
| Canales | Terminal | WhatsApp, hooks HTTP, etc. |
| Skills | Tools built-in | Skills dinámicos (Notion, etc.) |
| Concurrencia | 1 sesion | maxConcurrent: 4 por agente |
| Compaction | Automatico | Configurable (maxHistoryShare) |

### Como se Construye un Agente en OpenClaw

```json
// openclaw.json - definicion de agente
{
  "id": "coo",              // ID unico (lowercase, alphanumeric)
  "name": "COO",            // Display name
  "workspace": "/home/node/.openclaw/agents/coo/workspace",
  "agentDir": "/home/node/.openclaw/agents/coo/agent",
  "identity": {
    "name": "COO"           // Nombre en conversaciones
  }
}
```

Cada agente tiene un **workspace** con:
```
agents/coo/
├── workspace/
│   ├── sessions/           ← Historial de conversaciones
│   │   ├── agent:coo:main.json
│   │   └── agent:coo:whatsapp:group:XXX.json
│   ├── memory/
│   │   ├── MEMORY.md       ← Memoria persistente
│   │   └── memory-embed/   ← Embeddings para busqueda
│   └── skills/             ← Skills especificos
└── agent/
    └── (system prompt additions, SKILL.md files)
```

### Session Keys: La Pieza Clave de Persistencia

```
Session key = identificador unico de una conversacion

Formato: agent:{agentId}:{channel}:{peerKind}:{peerId}

Ejemplos:
  agent:coo:main                              → Sesion principal del COO
  agent:coo:whatsapp:group:120363407705@g.us  → COO en grupo WhatsApp
  task:abc123                                 → Tarea especifica (desde orchestrator)
  agent-setup:def456                          → Setup de nuevo agente

Cada session key = archivo JSON con historial completo
→ Cuando el agente se "despierta", carga el historial de esa sesion
→ Asi mantiene contexto entre interacciones
```

### System Prompt en OpenClaw (vs Claude Code)

```
OpenClaw system prompt = (construido dinamicamente)
  1. "You are {identity.name}"

  2. Owner identity (numero de telefono del dueno)

  3. Skills section
     "Scan available skills before replying"
     "Read SKILL.md from the skill directory"

  4. Memory recall
     "Before answering about prior work, run memory_search..."

  5. Messaging section
     "Use the 'message' tool for cross-session messaging"

  6. Workspace notes (custom project context)

  7. Runtime info (agentId, host, OS, shell)

  8. Extra system prompt (user additions)
```

**Diferencia clave con Claude Code**: en OpenClaw el system prompt se **genera programaticamente** cada vez que el agente despierta, inyectando identidad + skills + memoria + canal. En Claude Code puro, el system prompt es mas estatico (CLAUDE.md + instrucciones base de Anthropic).

---

## 4. NIVEL 3: TU ORCHESTRATOR — El Cerebro

```
┌─────────────────────────────────────────────────────────────┐
│  ORCHESTRATOR (Node.js, puerto 3500)                        │
│                                                              │
│  ┌────────────────────────────────────────────────────┐     │
│  │  POLLER (cada 10s)                                  │     │
│  │                                                     │     │
│  │  Notion DB Tareas ──→ Estado="Pendiente"?           │     │
│  │       │                    │                        │     │
│  │       │              ┌─────▼──────┐                 │     │
│  │       │              │  Dedup     │                 │     │
│  │       │              │  check     │                 │     │
│  │       │              └─────┬──────┘                 │     │
│  │       │                    │                        │     │
│  │       │              ┌─────▼──────┐                 │     │
│  │       │              │  Message   │                 │     │
│  │       │              │  Builder   │                 │     │
│  │       │              └─────┬──────┘                 │     │
│  │       │                    │                        │     │
│  │       │              ┌─────▼──────┐                 │     │
│  │       │              │  Dispatch  │                 │     │
│  │       │              │  to Agent  │                 │     │
│  │       │              └────────────┘                 │     │
│  │       │                                             │     │
│  │  Notion DB Agentes ──→ Estado="nuevo"?              │     │
│  │                           │                         │     │
│  │                     ┌─────▼──────┐                  │     │
│  │                     │  Agent     │                  │     │
│  │                     │  Creator   │                  │     │
│  │                     └────────────┘                  │     │
│  └────────────────────────────────────────────────────┘     │
│                                                              │
│  ┌────────────────────────────────────────────────────┐     │
│  │  WEBHOOK HANDLER                                    │     │
│  │                                                     │     │
│  │  Notion comment.created                             │     │
│  │       │                                             │     │
│  │       ├── inline? → almacenar (esperar page-level)  │     │
│  │       │                                             │     │
│  │       └── page-level? → recolectar inlines          │     │
│  │                         + construir mensaje          │     │
│  │                         + dispatch a agente          │     │
│  └────────────────────────────────────────────────────┘     │
│                                                              │
│  ┌────────────────────────────────────────────────────┐     │
│  │  AGENT CACHE (refresca cada 10s)                    │     │
│  │                                                     │     │
│  │  Notion DB Agentes → en memoria                     │     │
│  │  Incluye preInstrucciones (body de la card)         │     │
│  │  → Se pueden editar LIVE desde Notion               │     │
│  └────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

### El Prompt que se Construye (message-builder.js)

Tu orchestrator arma el prompt asi:

```markdown
## Tus instrucciones base
{preInstrucciones del agente - cargadas desde el body de su card en Notion}

## Tarea asignada: {titulo}
ID Notion: {taskId}
URL: {taskUrl}

### Detalle de la tarea
{body completo de la pagina de tarea, convertido a texto plano}

### Contexto del proyecto
{brief del proyecto vinculado}

### Feedback / Correcciones
{comentarios previos si es re-dispatch}

---
**Importante:** Cuando termines, actualiza el estado a "En Revision"
usando la API de Notion. Escribi tus resultados en el body de la tarea.
```

**Insight clave**: Las `preInstrucciones` vienen del body de la card del agente en Notion. Esto significa que podes editar el "system prompt" de cualquier agente **directamente desde Notion** y se actualiza en 10 segundos (proximo ciclo de cache).

---

## 5. DEV-TASK.SH — Donde Todo Converge

```
┌─────────────────────────────────────────────────────────────┐
│  dev-task.sh (corre como user 'paperclip')                  │
│                                                              │
│  INPUT:                                                      │
│  --repo https://github.com/org/repo                         │
│  --task "Arregla el bug de login"                           │
│  --task-id TUNI-123                                         │
│  --context "Error en produccion, stack trace: ..."          │
│                                                              │
│  FASE 1: TRIAGE ──────────────────────────────────────────  │
│  │                                                           │
│  │  claude -p "Evalua si hay info suficiente" --max-turns 1 │
│  │       │                                                   │
│  │       ├── ready: false → OUTPUT: needs_info + preguntas  │
│  │       │                  (corta aca, no gasta sesion)     │
│  │       │                                                   │
│  │       └── ready: true  → continua                         │
│  │                                                           │
│  FASE 2: SETUP ───────────────────────────────────────────  │
│  │                                                           │
│  │  git clone (o pull si ya existe)                          │
│  │       │                                                   │
│  │       ▼                                                   │
│  │  git worktree add ~/workspaces/repo-TUNI-123             │
│  │       -b dev/TUNI-123                                     │
│  │       origin/main                                         │
│  │                                                           │
│  │  Resultado:                                               │
│  │  ~/repos/repo/           ← clone principal (main)        │
│  │  ~/workspaces/repo-123/  ← worktree aislado (dev/123)   │
│  │                                                           │
│  FASE 3: DEV SESSION ────────────────────────────────────── │
│  │                                                           │
│  │  cd ~/workspaces/repo-123                                 │
│  │  claude -p "TASK: ..." \                                  │
│  │    --dangerously-skip-permissions \                       │
│  │    --max-turns 50                                         │
│  │                                                           │
│  │  (Claude explora, edita, testea — todo local)            │
│  │  (Solo llama a API Anthropic para razonar)               │
│  │  (Puede hacer 50 ciclos de razonamiento)                 │
│  │                                                           │
│  FASE 4: SHIP ────────────────────────────────────────────  │
│  │                                                           │
│  │  ┌─────────┐                                              │
│  │  │git diff  │──→ No changes? → OUTPUT: no_changes        │
│  │  └────┬────┘                                              │
│  │       │ hay cambios                                       │
│  │       ▼                                                   │
│  │  git add -A                                               │
│  │  git commit -m "task description..."                      │
│  │  git push -u origin dev/TUNI-123                          │
│  │  gh pr create --title "..." --body "..."                  │
│  │       │                                                   │
│  │       ▼                                                   │
│  │  OUTPUT: pr_created + PR URL                              │
│  │                                                           │
│  CLEANUP:                                                    │
│  git worktree remove (siempre, exito o fallo)               │
│                                                              │
│  OUTPUT (JSON):                                              │
│  {"status":"pr_created","message":"...","pr_url":"..."}     │
│  {"status":"needs_info","message":"que repo? que bug?"}     │
│  {"status":"no_changes","message":"nada que cambiar"}       │
│  {"status":"error","message":"push failed"}                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. COMPARATIVA: Capacidades por Sistema

```
┌────────────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
│                    │ Claude Code  │  OpenClaw    │ Orchestrator │ dev-task.sh  │
│                    │ (este chat)  │  (gateway)   │ (Node.js)    │ (script)     │
├────────────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
│ Razonamiento       │ Opus/Sonnet  │ Opus/Sonnet  │    N/A       │ Opus/Sonnet  │
│ Editar codigo      │     SI       │     SI *     │    N/A       │     SI       │
│ Correr comandos    │     SI       │     SI *     │    N/A       │     SI       │
│ Git operations     │     SI       │     NO       │    N/A       │     SI       │
│ Crear PRs          │     SI       │     NO       │    N/A       │     SI       │
│ Notion API         │     NO **    │     SI       │     SI       │     NO       │
│ WhatsApp           │     NO       │     SI       │     NO       │     NO       │
│ Memoria persistente│ auto-memory  │ vector embed │     NO       │     NO       │
│ Multi-agente       │ subagents    │ bindings     │ agent cache  │     NO       │
│ Sesiones           │ --resume     │ session keys │     N/A      │  one-shot    │
│ Interactivo        │     SI       │     SI       │     NO       │     NO       │
│ Headless           │ -p flag      │ hooks HTTP   │   siempre    │   siempre    │
│ System prompt      │ CLAUDE.md    │ programatico │ msg-builder  │ inline       │
│ Costo por uso      │ por turn     │ por turn     │ API Notion   │ por turn     │
├────────────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
│ Caso de uso        │ Dev humano   │ Agente chat  │ Coordinador  │ Dev autonomo │
│                    │ interactivo  │ multi-canal  │ de tareas    │ one-shot     │
└────────────────────┴──────────────┴──────────────┴──────────────┴──────────────┘

*  OpenClaw agentes usan exec tools pero dentro de Docker (limitado)
** Claude Code puede si le das MCP server de Notion
```

---

## 7. COMO SE "PROGRAMA" UN AGENTE — Las 4 Palancas

### Palanca 1: System Prompt (identidad + reglas)

```
┌──────────────────────────────────────────────────┐
│  SYSTEM PROMPT = define QUIEN es y COMO actua    │
│                                                   │
│  En Claude Code:                                  │
│    → CLAUDE.md (archivo en el repo)              │
│    → ~/.claude/CLAUDE.md (global)                │
│    → --system-prompt "..." (override)            │
│    → --append-system-prompt "..." (agregar)      │
│                                                   │
│  En OpenClaw:                                     │
│    → identity.name (personalidad)                │
│    → agentDir/ (archivos de prompt)              │
│    → runtime injection (skills, memory, channel) │
│                                                   │
│  En tu Orchestrator:                              │
│    → preInstrucciones (body de card Notion)       │
│    → message-builder (template con contexto)      │
│    → editable LIVE desde Notion                  │
│                                                   │
│  En dev-task.sh:                                  │
│    → DEV_PROMPT hardcoded en el script           │
│    → Triage prompt separado                       │
│    → Se puede parametrizar desde el orchestrator │
└──────────────────────────────────────────────────┘
```

### Palanca 2: Tools (que PUEDE hacer)

```
┌──────────────────────────────────────────────────┐
│  TOOLS = define QUE ACCIONES puede ejecutar      │
│                                                   │
│  Built-in (Claude Code):                          │
│    Read, Edit, Write, Bash, Grep, Glob, Agent    │
│                                                   │
│  MCP Servers (extensibles):                       │
│    Notion, GitHub, Slack, DB, cualquier API       │
│    → Cada MCP server agrega N tools              │
│    → Se configuran en settings.json o --mcp-conf │
│                                                   │
│  OpenClaw skills:                                 │
│    Notion API, ElevenLabs, custom skills          │
│    → Registrados en openclaw.json                │
│    → Cada skill = directorio con SKILL.md        │
│                                                   │
│  Restriccion:                                     │
│    --allowedTools / --disallowedTools             │
│    → Podes limitar que tools ve el agente        │
│    → Menos tools = menos confuso = mas enfocado  │
└──────────────────────────────────────────────────┘
```

### Palanca 3: Contexto (que SABE)

```
┌──────────────────────────────────────────────────┐
│  CONTEXTO = la informacion disponible para       │
│  que el agente tome decisiones                   │
│                                                   │
│  Estatico:                                        │
│    → System prompt (siempre presente)            │
│    → CLAUDE.md (cargado al inicio)               │
│    → Archivos del repo (accesibles via tools)    │
│                                                   │
│  Dinamico (inyectado por run):                   │
│    → Task description (la tarea especifica)      │
│    → Project context (brief del proyecto)        │
│    → Feedback (comentarios previos)              │
│    → Session history (conversaciones pasadas)    │
│    → Memory search results (recall semantico)    │
│                                                   │
│  El orchestrator es quien ARMA el contexto       │
│  dinamico antes de cada dispatch.                │
│  → message-builder.js es la pieza clave          │
└──────────────────────────────────────────────────┘
```

### Palanca 4: Guardrails (que NO puede hacer)

```
┌──────────────────────────────────────────────────┐
│  GUARDRAILS = limites y controles                │
│                                                   │
│  Tokens/costo:                                    │
│    --max-turns 50 (limita ciclos)                │
│    --max-budget-usd 5 (limita gasto)             │
│    compaction (descarta historial viejo)          │
│                                                   │
│  Seguridad:                                       │
│    --dangerously-skip-permissions (OFF en prod?)  │
│    --allowedTools (whitelist)                     │
│    Docker sandbox (OpenClaw)                      │
│    user dedicado (paperclip, no root)            │
│                                                   │
│  Flujo:                                           │
│    Triage (dev-task.sh: corta si falta info)      │
│    Dedup (dispatched.json: no re-ejecuta)        │
│    Timeout (timeoutSeconds: 300)                 │
│    Bot filter (webhook: evita loops)             │
│                                                   │
│  Oversight:                                       │
│    PR review (humano revisa antes de merge)      │
│    Estado "En Revision" (requiere aprobacion)    │
│    Logs (journalctl, ~/logs/)                    │
└──────────────────────────────────────────────────┘
```

---

## 8. ANATOMIA DE UNA LLAMADA A LA API

Cuando Claude Code (o OpenClaw) "piensa", esto es lo que pasa por la red:

```
POST https://api.anthropic.com/v1/messages
Headers:
  x-api-key: sk-ant-...
  anthropic-version: 2023-06-01

Body:
{
  "model": "claude-opus-4-20250514",
  "max_tokens": 16384,
  "system": "You are Claude Code...\n\n[CLAUDE.md content]\n\n[memory]\n...",
  "tools": [
    {
      "name": "Read",
      "description": "Reads a file from the local filesystem...",
      "input_schema": {
        "type": "object",
        "properties": {
          "file_path": {"type": "string"},
          "offset": {"type": "number"},
          "limit": {"type": "number"}
        }
      }
    },
    // ... Edit, Write, Bash, Grep, Glob, Agent, etc.
  ],
  "messages": [
    {"role": "user", "content": "arregla el bug de login"},
    {"role": "assistant", "content": [
      {"type": "text", "text": "Voy a leer el archivo..."},
      {"type": "tool_use", "id": "toolu_01", "name": "Read",
       "input": {"file_path": "/src/auth.js"}}
    ]},
    {"role": "user", "content": [
      {"type": "tool_result", "tool_use_id": "toolu_01",
       "content": "1 const login = (user, pass) => {..."}
    ]},
    // ... mas turns
  ]
}
```

**Observa**:
- Los `tool_result` van como mensajes del "user" (asi funciona la API)
- El sistema completo es **stateless del lado del servidor** — todo el historial se envia en cada request
- Por eso el **compaction** es critico: si el historial crece mucho, hay que recortar

### Costo Real

```
Cada API call = input_tokens + output_tokens

Input tokens = system prompt + TODOS los mensajes previos + tool results
Output tokens = la respuesta del modelo

Si tu sesion tiene 50 turns, el turn 50 envia los 49 anteriores completos.
→ Costo ACUMULATIVO (no lineal)
→ Por eso --max-turns importa tanto
→ Por eso compaction existe (recorta historial viejo)

Ejemplo real (dev-task.sh, run test-001):
  Turn 1 (triage): ~2K input, ~200 output = barato
  Turn 1-15 (dev): ~5K-50K input creciendo, ~500 output cada uno
  Total estimado: ~$0.50-2.00 por tarea
```

---

## 9. WORKTREES — Aislamiento para Trabajo Paralelo

```
SIN worktrees (problema):
┌──────────────────────┐
│ ~/repos/tich-cronos/  │
│                       │
│ branch: main          │
│ ¿Y si 2 tareas       │
│  necesitan cambios    │
│  al mismo tiempo?     │
│                       │
│ → git checkout A      │
│ → (pierdo cambios B)  │
│ → CONFLICTO           │
└──────────────────────┘

CON worktrees (solucion):
┌──────────────────────┐    ┌──────────────────────┐
│ ~/repos/tich-cronos/  │    │ ~/workspaces/         │
│ (clone principal)     │    │                       │
│ branch: main          │    │ tich-fix-login/       │
│                       │    │   branch: dev/fix-1   │
│ .git/ ─────────────── │ ←──│   (comparte .git)     │
│ (historia compartida) │    │                       │
│                       │    │ tich-add-analytics/   │
│                       │    │   branch: dev/feat-2  │
│                       │    │   (comparte .git)     │
└──────────────────────┘    └──────────────────────┘

Cada worktree:
  - Es un directorio real completo (no symlinks)
  - Tiene su propia branch
  - Comparte .git con el clone principal (ahorra disco)
  - Un git fetch actualiza TODOS los worktrees
  - Git IMPIDE tener la misma branch en 2 worktrees
  - Se limpia con: git worktree remove <path>
```

---

## 10. RESUMEN: El Stack Completo que Tenes

```
┌─────────────────────────────────────────────────────────────────┐
│                          NOTION                                  │
│  (UI + Data: tareas, agentes, proyectos)                        │
│  - Editas preInstrucciones → cambia comportamiento en 10s       │
│  - Cambias estado → trigger dispatch                            │
│  - Comentas → webhook despierta agente                          │
└──────────────────────────┬──────────────────────────────────────┘
                           │
              ┌────────────▼────────────────┐
              │  ORCHESTRATOR (port 3500)    │
              │  Poller + Webhook Handler    │
              │  Message Builder             │
              │  "cerebro coordinador"       │
              └─────┬───────────────┬───────┘
                    │               │
         ┌──────────▼──────┐  ┌────▼──────────────┐
         │  OPENCLAW        │  │  dev-task.sh       │
         │  (port 18789)    │  │  (user paperclip)  │
         │                  │  │                     │
         │ Agentes de chat: │  │ Agente de codigo:   │
         │ - WhatsApp       │  │ - clone repo        │
         │ - Notion API     │  │ - worktree aislado  │
         │ - memoria        │  │ - claude -p (dev)   │
         │ - multi-sesion   │  │ - commit + push     │
         │                  │  │ - crear PR           │
         └────────┬─────────┘  └─────────┬───────────┘
                  │                       │
         ┌────────▼───────────────────────▼──────────┐
         │           API ANTHROPIC (cloud)            │
         │    Claude Opus/Sonnet — razonamiento       │
         │    Stateless: todo el contexto va en       │
         │    cada request                            │
         └───────────────────────────────────────────┘
```

---

## Proximos pasos (no parte de la clase)

Para integrar dev-task.sh al orchestrator, necesitamos:
1. Decidir QUE agente puede disparar dev-tasks (CTO? nuevo agente?)
2. Agregar endpoint `POST /dev-task` al orchestrator
3. El agente evaluador recibe tarea de tipo "dev" → llama al endpoint
4. Orchestrator ejecuta dev-task.sh como user paperclip
5. Resultado (PR URL o preguntas) → se escribe de vuelta en Notion

---

## 11. DEEP DIVE: Como se "Despierta" un Agente (OpenClaw internals)

### La revelacion tecnica

OpenClaw **NO usa la API de Anthropic directamente**. Literalmente hace `spawn("claude", [...args])` — corre Claude Code CLI como un proceso hijo de Node.js. Es exactamente el mismo binario que usas en tu terminal.

### Flujo exacto: mensaje de WhatsApp → respuesta

```
1. TU MENSAJE DE WHATSAPP
   "Hola Mari necesito que..."
        │
        ▼
2. WHATSAPP PLUGIN (dentro del Docker)
   Recibe el mensaje, extrae:
   - JID: +5493884869278@s.whatsapp.net
   - Es DM (no grupo)
   - Texto: "Hola Mari necesito que..."
        │
        ▼
3. ROUTING / BINDINGS
   ¿Es DM? → dmPolicy: "pairing" → agente default: "main" (Mari)
   ¿Es grupo? → busca en bindings[] que agente matchea ese JID
        │
        ▼
4. SESSION KEY BUILDER
   Construye: "agent:main:whatsapp:direct:+5493884869278"
   → Busca archivo: sessions/agent:main:whatsapp:direct:+5493884869278.json
   → Si existe: tiene historial previo + session ID de Claude
   → Si no existe: sesion nueva
        │
        ▼
5. SYSTEM PROMPT BUILDER
   Arma el prompt combinando:
   - "You are Mari Alexa"
   - Skills disponibles
   - "Before answering, run memory_search..."
   - Workspace notes
   - Runtime info
        │
        ▼
6. CLI RUNNER (la pieza clave)
   Construye el comando:

   spawn("claude", [
     "-p",                              ← modo headless
     "--output-format", "json",         ← respuesta parseable
     "--dangerously-skip-permissions",  ← no pide confirmacion
     "--model", "opus",                 ← modelo a usar
     "--append-system-prompt", "You are Mari Alexa...[todo el prompt]",
     "--session-id", "abc-123-def",     ← RETOMA sesion anterior
     "Hola Mari necesito que..."        ← tu mensaje
   ], {
     cwd: "/home/node/.openclaw/agents/alice/workspace",
     env: { ...process.env }            ← hereda ANTHROPIC_API_KEY
   })

   ESTO ES LITERALMENTE un child_process.spawn()
   Corre Claude Code CLI como un subproceso de Node.js
        │
        ▼
7. CLAUDE CODE CLI (proceso hijo)
   - Lee --append-system-prompt → lo agrega al system prompt base
   - Lee --session-id → carga la sesion anterior (historial completo)
   - El CWD es el workspace de Mari → si tiene CLAUDE.md, lo lee
   - ARRANCA EL AGENTIC LOOP:
     → Envia todo a la API de Anthropic
     → Recibe respuesta
     → Si tiene tool_use → ejecuta (Read, Bash, memory_search, etc.)
     → Repite hasta terminar
   - Devuelve JSON con { text, sessionId, usage }
        │
        ▼
8. RESPUESTA
   OpenClaw parsea el JSON de salida
   - Extrae el texto de respuesta
   - Guarda el sessionId para la proxima vez
   - Envia el texto de vuelta por WhatsApp
   - Actualiza metricas (tokens usados, etc.)
```

### El comando real que corre

```bash
claude -p \
  --output-format json \
  --dangerously-skip-permissions \
  --model opus \
  --append-system-prompt "You are Mari Alexa... [skills, memory, etc.]" \
  --session-id "uuid-de-sesion-anterior" \
  "Hola Mari necesito que..."
```

Es el mismo `claude` que usas en tu terminal. La diferencia:
- `-p` → headless (sin UI)
- `--session-id` → retoma conversacion previa (asi Mari "recuerda")
- `--append-system-prompt` → inyecta identidad + skills + memoria
- `--dangerously-skip-permissions` → no pide permiso para usar tools

### Serializacion: una cola, no paralelismo real

OpenClaw tiene una **cola serializada** (`enqueueCliRun`). Solo puede correr **un proceso de Claude CLI a la vez** por backend. Si llegan 3 mensajes simultaneos, se encolan y procesan uno por uno. El `maxConcurrent: 4` en la config es el limite de la cola, no de procesos paralelos reales del CLI.

### Que son AGENTS.md, SOUL.md, IDENTITY.md

Son archivos que viven en el `agentDir` de cada agente:

```
/root/.openclaw/agents/alice/agent/
├── AGENTS.md     ← directorio del equipo (quienes son los otros agentes)
├── SOUL.md       ← personalidad profunda
├── IDENTITY.md   ← nombre, rol, estilo de comunicacion
└── ...
```

Se cargan de dos formas:
1. Si el workspace tiene un `CLAUDE.md`, Claude Code lo lee automaticamente al arrancar
2. OpenClaw los inyecta via `--append-system-prompt` como parte del prompt construido

**No es magia — es concatenacion de texto.** El system prompt final de Mari es:

```
[Instrucciones base de Anthropic - hardcoded ~5K tokens]
[CLAUDE.md del workspace si existe]
[--append-system-prompt: "You are Mari Alexa..." + SOUL.md + skills + memory]
[Historial de sesion cargado por --session-id]
[Tu mensaje: "Hola Mari necesito que..."]
```

Todo eso va en un solo API call a Anthropic. El modelo lee todo y responde.

### Archivos involucrados en el flujo (referencia)

| Capa | Archivo | Funcion clave |
|------|---------|---------------|
| Gateway HTTP | `src/gateway/server-http.ts` | Recibe POST /hooks |
| Gateway Hooks | `src/gateway/server/hooks.ts` | `dispatchAgentHook()` |
| Cron Runner | `src/cron/isolated-agent/run.ts` | `runCronIsolatedAgentTurn()` |
| CLI Runner | `src/agents/cli-runner.ts` | `runCliAgent()` |
| CLI Helpers | `src/agents/cli-runner/helpers.ts` | `buildCliArgs()`, `buildSystemPrompt()` |
| CLI Backends | `src/agents/cli-backends.ts` | Config default del backend claude |
| Process | `src/process/exec.ts` | `runCommandWithTimeout()` → `spawn()` |

### Config default del CLI backend

```typescript
const DEFAULT_CLAUDE_BACKEND = {
  command: "claude",
  args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"],
  modelArg: "--model",
  sessionArg: "--session-id",
  systemPromptArg: "--append-system-prompt",
  systemPromptMode: "append",
  sessionMode: "always",
  serialize: true    // cola serializada, uno a la vez
}
```

---

## 12. TOOLS ADICIONALES DE CLAUDE CODE

### NotebookEdit
Para editar Jupyter Notebooks (`.ipynb`). Los notebooks tienen estructura de celdas (codigo, markdown, outputs), no se pueden editar con Edit normal. Este tool entiende esa estructura celular.

### LSP (Language Server Protocol)
Es lo que usan los IDEs para autocompletado, tipos, "go to definition". Cuando Claude lo usa, puede preguntar "que tipo tiene esta variable?" o "mostrame todas las referencias a esta funcion". Inteligencia de IDE para entender mejor el codigo — mas alla de leer texto plano.

### Capas de Tools

```
Built-in (hardcoded en Claude Code):
  Read, Edit, Write, Bash, Grep, Glob      ← core
  Agent                                      ← sub-agentes
  WebSearch, WebFetch                        ← web
  NotebookEdit, LSP                          ← especializados

MCP Servers (se suman como tools extra):
  Cada MCP server agrega N tools
  Ej: Jira MCP → createJiraIssue, editJiraIssue, searchJiraIssues
  Aparecen IGUAL que los built-in para el LLM
  Se inyectan en el system prompt con su JSON schema

OpenClaw Skills (otra capa):
  Plugins con SKILL.md que el agente lee on-demand
  Notion API, ElevenLabs, custom
  Corren DENTRO del sandbox de OpenClaw (Docker)

Las 3 capas le llegan al LLM de la misma forma:
como entries en el array "tools" del API call.
El modelo NO distingue si una tool es built-in, MCP, o skill.
Para el son todas iguales.
```

---

## 13. DEEP DIVE: Que Lee el Agente Cuando se Dispara desde Notion

### La pregunta

Cuando el orchestrator despacha una tarea a un agente de OpenClaw, el message-builder construye un prompt con `preInstrucciones` (del body de la card del agente en Notion). Pero las cards de Notion hoy estan vacias. La personalidad real del agente esta en SOUL.md, IDENTITY.md, AGENTS.md dentro del workspace. ¿El agente los lee?

### La respuesta: SI — OpenClaw los inyecta automaticamente

Confirmado por el source code (`workspace.ts` + `bootstrap-files.ts` + `system-prompt.ts`):

#### Paso 1: loadWorkspaceBootstrapFiles(workspaceDir)

Lee TODOS estos archivos del workspace del agente:

```
AGENTS.md    ← directorio del equipo
SOUL.md      ← personalidad profunda
TOOLS.md     ← herramientas disponibles
IDENTITY.md  ← nombre, rol, emoji
USER.md      ← info del dueno
HEARTBEAT.md ← instrucciones de heartbeat
BOOTSTRAP.md ← instrucciones de arranque
MEMORY.md    ← memoria persistente (si existe)
```

#### Paso 2: buildBootstrapContextFiles()

Transforma cada archivo en `{ path: "SOUL.md", content: "..." }`. Si un archivo falta, lo marca como `[MISSING]`.

#### Paso 3: buildAgentSystemPrompt() los inyecta en el prompt

```
# Project Context

The following project context files have been loaded:
If SOUL.md is present, embody its persona and tone.

## SOUL.md

# SOUL.md — COO
*No eres un bot, sos quien da vida a los nuevos empleados...*
[contenido completo del archivo]

## IDENTITY.md

- **Name:** Coti (Constanza)
- **Creature:** COO
[contenido completo]

## AGENTS.md

# AGENTS.md — COO
Este workspace es el tuyo...
[contenido completo]
```

#### Paso 4: Todo va en --append-system-prompt

```bash
claude -p \
  --append-system-prompt "[SOUL + IDENTITY + AGENTS + TOOLS + todo concatenado]" \
  --session-id "uuid" \
  "Mensaje del orchestrator con la tarea"
```

### Flujo completo cuando se despacha desde Notion

```
Orchestrator arma el mensaje:
  "## Tus instrucciones base
   {preInstrucciones - VACIO si la card no tiene body}
   ## Tarea asignada: ...
   {detalle de la tarea}"
       |
       v
POST /hooks/agent -> agentId: "coo"
       |
       v
OpenClaw resuelve workspace: /root/.openclaw/agents/coo/workspace/
       |
       v
Lee SOUL.md, IDENTITY.md, AGENTS.md, TOOLS.md, USER.md, MEMORY.md
       |
       v
Construye --append-system-prompt con TODO eso
       |
       v
spawn("claude", [
  "-p",
  "--append-system-prompt", "[SOUL + IDENTITY + AGENTS + TOOLS + ...]",
  "--session-id", "task:abc123",
  "## Tus instrucciones base\n\n## Tarea: ...\n{mensaje del orchestrator}"
])
```

### Conclusion

- **SOUL.md, IDENTITY.md, AGENTS.md** SI se leen y se inyectan automaticamente via `--append-system-prompt`
- **preInstrucciones de Notion** son ADICIONALES — van en el cuerpo del mensaje, no en el system prompt
- Como las cards de Notion hoy estan vacias, no suman — pero el agente igual recibe su personalidad desde los archivos del workspace
- **Ningun agente tiene CLAUDE.md** en su workspace — no es necesario porque OpenClaw inyecta los bootstrap files directamente

### Donde vive cada cosa

| Info | Donde esta | Como se carga |
|------|-----------|---------------|
| Personalidad | SOUL.md (workspace) | OpenClaw → --append-system-prompt |
| Identidad | IDENTITY.md (workspace) | OpenClaw → --append-system-prompt |
| Equipo | AGENTS.md (workspace) | OpenClaw → --append-system-prompt |
| Tools | TOOLS.md (workspace) | OpenClaw → --append-system-prompt |
| Memoria | MEMORY.md (workspace) | OpenClaw → --append-system-prompt |
| Instrucciones extra | Card Notion (body) | Orchestrator → cuerpo del mensaje |
| Tarea | Pagina Notion (body) | Orchestrator → cuerpo del mensaje |
| Proyecto | Pagina Proyecto (body) | Orchestrator → cuerpo del mensaje |
