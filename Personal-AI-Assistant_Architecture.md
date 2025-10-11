# Personal AI Assistant — Architecture & Design (Nest MCS Edition)

**Status:** Draft v0.4 • _Pre‑development_  
**Runtime Targets:** **Node.js 24**, **Redis 8**  
**Transports:** Telegram (long polling), later Matrix  
**Core:** NestJS (module → controller → service), LangGraph (in‑process)

---

## 1) Executive Summary

We are building a modular AI agent that receives user messages from **Telegram**, plans actions using **LangGraph**, executes domain **tools** (e.g., crypto quotes, contacts CRUD), and replies. The system intentionally keeps persistence **minimal** (Redis only) and separates **transport adapters** from the **agent server** so we can add Matrix (or any other chat) later without touching the core.

**Key decisions**
- **NestJS** for clean layered architecture and DI.
- **Module → Controller → Service** pattern everywhere.
- **LangGraph (in‑process)** inside the Nest “orchestrator” module.
- **Redis 8** for short‑term conversation memory and “handles” (`last_contact_id`, etc.).
- **Telegram: long polling** for MVP (no public HTTPS needed).
- **Docker Compose**: 3 services → `redis`, `agent-server` (Nest + LangGraph), `tg-adapter` (grammY).
- **TypeScript / Node 24** across all services.
- Tests with **Jest** (Nest), **Vitest** (adapter), and **Testcontainers** for E2E.

---

## 2) System Context (text diagram)

```
User (Telegram)
   │ message / voice
   ▼
[Telegram Adapter (grammY, polling)]
   │ normalizes to MessageReceived DTO (HTTP)
   ▼
[Agent Server (NestJS + LangGraph)]
   │ reads/writes short-term memory (window + handles)
   ▼
[Redis 8]
   │
   ├─ Tools call external APIs (e.g., crypto quotes)
   └─ Replies returned to adapter → user
```

**Why separate the adapter?**  
Transport concerns (webhooks, polling, auth, rate limits) are isolated. The agent speaks in a **transport‑agnostic** contract (DTOs), allowing us to bolt on Matrix or Discord later.

---

## 3) Nest Modules (M‑C‑S)

### 3.1 ConfigModule
- Loads/validates env (Joi/class‑validator).
- Provides typed access via `ConfigService` (Redis host/port, window size, LLM keys, allowed chat id).

### 3.2 HealthModule
- `HealthController` → `GET /health` (used by Docker healthcheck).

### 3.3 TransportModule
- **Controller:** `POST /events` receives a normalized `MessageReceivedDto`.  
- **Guards/Pipes:** optional allow‑list guard for `ALLOWED_CHAT_ID`; validation pipe for DTOs.  
- **Service (optional):** thin façade to call the orchestrator (keeps controller ultra‑thin).

### 3.4 OrchestratorModule
- **Service:** `OrchestratorService` — the application boundary. It:
  - Fetches conversation window/handles from `MemoryService`,
  - Assembles the prompt state (system prompt + window + optional summary),
  - Executes the **LangGraph** (planner → tool‑router → respond),
  - Persists updated memory, returns an `AgentResponseDto`.
- **LanggraphModule:** `GraphFactory` builds and compiles a graph from injectable nodes:
  - `planner.node.ts` — decide intent or tool call.
  - `tool-router.node.ts` — validate & invoke domain tools (DI‑injected).

### 3.5 MemoryModule
- **Providers:** `RedisProvider` (ioredis/redis client).  
- **Service:** `MemoryService` with small API:
  - `getWindow(chatId) / pushMessage(chatId, msg)`
  - `getHandle(chatId, key) / setHandle(chatId, key, value, ttl)`
  - Optional short **summary** field per chat when window grows.
- Policies (window size, TTL) read from config.

### 3.6 ToolsModule (domain tools)
- **quotes/**  
  - `QuotesModule` → `QuotesService` (pure logic) + `QuotesClient` (HTTP).  
- **contacts/**  
  - `ContactsModule` → `ContactsService` (createContact, setBirthday).  
  - Repo can be in‑memory for MVP, DB later.
- Tools expose **typed methods**; LangGraph nodes call them via DI. No Telegram/Nest specifics leak into tool code.

### 3.7 CommonModule
- Cross‑cutting concerns: logging interceptor, exception filter, shared types/utilities.

---

## 4) Contracts (DTOs)

- **MessageReceivedDto** (from adapter → agent)
  - `chatId: string`
  - `userId: string`
  - `text?: string`
  - `voiceUrl?: string` (adapter performs STT or we do it in the orchestrator, TBD)
  - `isCommand?: boolean`
  - `command?: "/start" | "/help" | "/clear" | string`
  - `payload?: Record<string, any>`

- **AgentResponseDto** (agent → adapter)
  - `chatId: string`
  - `text: string` (final rendered message)
  - `meta?: { tool?: string; args?: any; elapsedMs?: number }`

**Rationale:** explicit schemas make the adapter and agent evolvable in parallel and enforce a clean boundary.

---

## 5) Memory Policy (Redis 8)

- **Windowed conversation memory:** last **N** messages (default **15**).  
- **Handles with TTL:** e.g., `last_contact_id` (default **2h**).  
- **/clear:** clears window + handles for the chat; does **not** touch durable facts (none in MVP).  
- **Optional summary:** if window approaches token budget, we store/update a short summary per chat.

Why Redis?  
It is fast, simple, resilient with AOF, and perfect for short‑lived context. No need for a DB now.

---

## 6) Project Layout (current skeleton + target)

### 6.1 Current skeleton (as created)
```
personal-ai-assistant/
├─ infra/
│  ├─ .env.example
│  ├─ docker-compose.yml
│  └─ telegram.env.example
├─ services/
│  ├─ agent-server/
│  │  └─ infra/
│  │     └─ Dockerfile
│  └─ telegram-adapter/
│     └─ infra/
│        └─ Dockerfile
└─ .gitignore
```

### 6.2 Target Nest MCS structure (to populate during dev)
```
services/
└─ agent-server/
   ├─ src/
   │  ├─ app.module.ts
   │  ├─ main.ts
   │  │
   │  ├─ config/
   │  │  ├─ config.module.ts
   │  │  ├─ config.service.ts
   │  │  └─ config.schema.ts
   │  │
   │  ├─ health/
   │  │  ├─ health.module.ts
   │  │  └─ health.controller.ts
   │  │
   │  ├─ transport/
   │  │  ├─ transport.module.ts
   │  │  ├─ transport.controller.ts     # POST /events
   │  │  └─ dto/
   │  │     ├─ message-received.dto.ts
   │  │     └─ agent-response.dto.ts
   │  │
   │  ├─ orchestrator/
   │  │  ├─ orchestrator.module.ts
   │  │  ├─ orchestrator.service.ts
   │  │  ├─ graph/
   │  │  │  ├─ langgraph.module.ts
   │  │  │  ├─ graph.factory.ts
   │  │  │  ├─ planner.node.ts
   │  │  │  └─ tool-router.node.ts
   │  │  └─ policies/
   │  │     └─ prompt.policy.ts
   │  │
   │  ├─ memory/
   │  │  ├─ memory.module.ts
   │  │  ├─ memory.service.ts
   │  │  └─ redis.provider.ts
   │  │
   │  ├─ tools/
   │  │  ├─ tools.module.ts
   │  │  ├─ quotes/
   │  │  │  ├─ quotes.module.ts
   │  │  │  ├─ quotes.service.ts
   │  │  │  └─ quotes.client.ts
   │  │  └─ contacts/
   │  │     ├─ contacts.module.ts
   │  │     ├─ contacts.service.ts
   │  │     └─ contacts.repository.ts    # in-memory for MVP
   │  │
   │  ├─ common/
   │  │  ├─ logging.interceptor.ts
   │  │  ├─ exception.filter.ts
   │  │  └─ types.ts
   │  │
   │  └─ testing/
   └─ test/
      ├─ unit/
      └─ e2e/
```

```
services/
└─ telegram-adapter/
   ├─ src/
   │  ├─ telegram/
   │  │  ├─ bot.ts
   │  │  ├─ commands.ts
   │  │  └─ polling.ts
   │  ├─ mapping/normalize.ts             # to MessageReceivedDto
   │  ├─ transport/agent.client.ts        # POST to /events
   │  └─ health/route.ts                  # GET /health
   └─ test/unit/
```

---

## 7) Deployment (Docker Compose)

- **Node 24** and **Redis 8** images.
- **No published port** for `tg-adapter` in polling mode.
- `agent-server` exposes `:3000` locally for `/health` and manual checks.
- Redis uses **AOF** for persistence and simple reliability.

_The compose file is already created in `infra/docker-compose.yml` (see repo); it wires `redis` → `agent-server` → `tg-adapter` with health checks and environment variables._

**Important env keys**
- `TG_BOT_TOKEN`, `ALLOWED_CHAT_ID`
- `OPENAI_API_KEY`, `LLM_MODEL`
- `REDIS_HOST=redis`, `REDIS_PORT=6379`, `MEM_WINDOW_SIZE=15`, `HANDLE_TTL_SECONDS=7200`
- `AGENT_BASE_URL=http://agent-server:3000` (adapter → agent)

---

## 8) Testing Strategy

- **Unit (Nest/Jest):**  
  - `orchestrator.service.spec.ts`: plans tool calls correctly.  
  - `memory.service.spec.ts`: window/handles TTL behavior.  
  - `quotes.service.spec.ts`: HTTP client and retries.

- **Adapter (Vitest):**  
  - Normalize Telegram updates → DTO; command parsing; polling loop.

- **E2E (Testcontainers):**  
  - Spin `redis:8` and the Nest app; hit `/events` with realistic messages; assert full flow.

- **Contract tests:**  
  - Validate schemas for `MessageReceivedDto` and `AgentResponseDto` (zod/class‑validator) to protect the boundary.

---

## 9) Security & Reliability Notes

- **Allow‑list** chat IDs in the transport controller guard (single‑user system).  
- **Validate tool inputs** (never pass LLM JSON straight to HTTP/DB).  
- **Timeouts/retries** for external APIs.  
- **Structured logging** of tool calls (args → result → elapsed).  
- **/clear** command wipes memory and handles for that chat only.  
- **No public ingress** required with polling. Switch to webhook later if needed.

---

## 10) Migration Paths (future)

- **Matrix adapter:** add new service reusing the same DTOs.  
- **Webhook switch:** expose adapter HTTP with TLS + secret header; controller remains the same.  
- **Durable memory:** introduce Postgres + LangGraph checkpointer for full step replays.  
- **Streaming responses:** add partial result streaming to adapter for better UX.  
- **Richer tools:** financial data, task runners, n8n integration over HTTP with signed requests.

---

## 11) Decision Rationale (quick table)

| Decision | Alternatives | Why chosen |
|---|---|---|
| NestJS | Fastify/Hono only | DI + modules + testability for a growing codebase |
| LangGraph in‑process | Ad‑hoc function calling | Declarative flows; easier multi‑step logic; still lightweight |
| Redis 8 | Postgres, file-based | Minimal persistence, fast TTL memory, fewer moving parts |
| Polling | Webhook | No HTTPS/domain; simplest ops for VPS + Docker |
| Separate adapter svc | Single monolith | Transport agnostic core; easy to add Matrix/Discord |
| Contracts (DTOs) | Implicit JSON | Enforces clean boundary; safer refactors |

---

## 12) “Day‑1” Checklist

- [ ] Fill `infra/.env` with tokens and keys.  
- [ ] Implement DTOs in agent `transport/dto`.  
- [ ] Scaffold Nest modules and empty services/controllers.  
- [ ] Implement `MemoryService` (Redis) and plug into `OrchestratorService`.  
- [ ] Add 2 tools: Quotes (HTTP) and Contacts (in‑memory).  
- [ ] Bring up `docker compose up -d --build` and test `/health` and a hello flow.  

---

**End of document.**
