# Personal AI Assistant — Architecture & Design (Nest MCS Edition)

**Status:** Draft v0.4 • _Pre‑development_  
**Runtime Targets:** **Node.js 24**, **Redis 8**  
**Transports:** Telegram (long polling), later Matrix  
**Core:** NestJS (module → controller → service), LangGraph (in‑process)

---

## 1) Executive Summary

We are building a modular AI agent that receives user messages from **Telegram**, plans actions using **LangGraph**, executes domain **tools** (e.g., contacts CRUD today, extensible later), and replies. The system intentionally keeps persistence **minimal** (Redis only) and separates **transport adapters** from the **agent server** so we can add Matrix (or any other chat) later without touching the core.

**Key decisions**
- **NestJS** for clean layered architecture and DI.
- **Module → Controller → Service** pattern everywhere.
- **LangGraph (in‑process)** inside the Nest “orchestrator” module.
- **Redis 8** for short‑term conversation memory and “handles” (`last_contact_id`, etc.).
- **Monica API connector** abstracts CRM calls (reminders, contacts, notes) behind typed services.
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
   ├─ Tools manage chat-scoped data (e.g., contacts)
   └─ Replies returned to adapter → user
```

**Why separate the adapter?**  
Transport concerns (webhooks, polling, auth, rate limits) are isolated. The agent speaks in a **transport‑agnostic** contract (DTOs), allowing us to bolt on Matrix or Discord later.

---

## 3) Nest Modules (M‑C‑S)

### 3.1 ConfigModule
- Loads/validates env (Zod + class-validator).
- Provides typed access via `ConfigService` (Redis host/port, window size, LLM keys).

### 3.2 HealthModule
- `HealthController` → `GET /health` (used by Docker healthcheck).

### 3.3 TransportModule
- **Controller:** `POST /events` receives a normalized `MessageReceivedDto`.  
- **Guards/Pipes:** validation pipe for DTOs (chat allow-list enforced in adapters).  
- **Service (optional):** thin façade to call the orchestrator (keeps controller ultra-thin).

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
- **contacts/**  
  - `ContactsModule` → `ContactsService` (createContact, setBirthday, lookup).  
  - Repository is in-memory for now (chat-scoped), swappable for DB later.
- Tools expose **typed methods**; LangGraph nodes call them via DI. No transport-specific logic leaks into tool code.

### 3.7 MonicaModule (integrations)
- Provides `MonicaClient` (REST wrapper with auth + pagination helpers).
- Exposes typed services for CRM features (reminders, contacts, notes).
- Shared across tools so orchestrator and future transports can reuse the same adapter.

### 3.8 FutureEventsModule
- Wraps Monica reminders into a consumption-friendly `FutureEventsService`.
- Exposes GET `/future-events` alongside the `events_get_future` LangGraph tool for upcoming events.

### 3.9 CommonModule
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
│  ├─ .agent-server.env.example
│  ├─ docker-compose.yml
│  └─ .telegram.env.example
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
   │  ├─ integrations/
   │  │  └─ monica/
   │  │     ├─ monica.module.ts
   │  │     ├─ monica.client.ts
   │  │     └─ reminders/
   │  │        ├─ monica-reminders.service.ts
   │  │        └─ monica-reminders.types.ts
   │  │
   │  ├─ tools/
   │  │  ├─ tools.module.ts
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
_(Agent secrets live in `infra/.agent-server.env`; Telegram adapter keys go in `infra/.telegram.env`.)_
- `TG_BOT_TOKEN`, `ALLOWED_CHAT_IDS` (adapter-side chat allow-list)
- `OPENAI_API_KEY`, `LLM_MODEL`
- `REDIS_HOST=redis`, `REDIS_PORT=6379`, `MEM_WINDOW_SIZE=15`, `HANDLE_TTL_SECONDS=7200`
- `AGENT_BASE_URL=http://agent-server:3000` (adapter → agent)
- `MONICA_API_URL`, `MONICA_API_TOKEN` (OAuth token for Monica API access)
- `MONICA_WEB_URL` (public Monica app base, used for human-facing links)
_Set `LLM_MODEL` in `.agent-server.env` to pick the LangGraph planner model (compose defaults to `gpt-5-mini`)._

---

## 8) Testing Strategy

- **Unit (Nest/Jest):**  
  - `orchestrator.service.spec.ts`: plans tool calls correctly.  
  - `memory.service.spec.ts`: window/handles TTL behavior.  
  - `contacts.service.spec.ts`: creation/update flows and handle propagation.

- **Adapter (Vitest):**  
  - Normalize Telegram updates → DTO; command parsing; polling loop.

- **E2E (Testcontainers):**  
  - Spin `redis:8` and the Nest app; hit `/events` with realistic messages; assert full flow.

- **Contract tests:**  
  - Validate schemas for `MessageReceivedDto` and `AgentResponseDto` (zod/class‑validator) to protect the boundary.

---

## 9) Security & Reliability Notes

- **Allow-list** chat IDs inside the Telegram adapter (single-user system).  
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

- [ ] Fill `infra/.agent-server.env` with agent secrets (Monica, OpenAI, model).  
- [x] Implement DTOs in agent `transport/dto`.  
- [x] Scaffold Nest modules and empty services/controllers.  
- [x] Implement `MemoryService` (Redis) and plug into `OrchestratorService`.  
- [x] Add Contacts tool (create, lookup, set birthday) and wire LangGraph handles.  
- [x] Introduce Monica API connector with reminders pagination helpers.  
- [x] Implement Monica contacts service (list/get/search/update/delete).  
- [x] Implement Monica notes service (list/contact notes/CRUD).  
- [x] Add reminders aggregator (GET /reminders/upcoming + LangGraph tool).  
- [ ] Bring up `docker compose up -d --build` and test `/health` and a hello flow.  

---

## 13) Progress Snapshot (2025‑10‑12)

**Completed**
- Bootstrap Nest server with Config, Common, Health, Transport, Orchestrator, Memory, and Tools modules wired end-to-end.
- Added global validation (Zod-config + class-validator DTOs) and request validation pipeline.
- Implemented Redis-backed `MemoryService` with window + handle helpers.
- Built LangGraph planner/router with OpenAI planning and contact-management tools.
- Added structured logging interceptor and global exception formatting.
- Introduced Monica connector module with reminders fetch + digest helpers.
- Added Monica contacts service (list/get/search/update/delete + career updates).
- Added Monica notes service (list, per-contact, CRUD with favorites support).
- Delivered reminders aggregator (GET /reminders/upcoming \+ LangGraph tool) extracting Monica data.

**Remaining (near-term)**
- Flesh out contact repository persistence (beyond in-memory) and add list/search surfaces.
- Expand orchestrator tests (unit + E2E) and add contract coverage for DTOs.
- Extend Monica integrations to cover people updates digest and richer contact enrichment flows.
- Wire Telegram adapter (grammY) service with new contacts-centric flows and smoke-test end to end.
- Execute Docker Compose stack, verify `/health`, and add initial unit/E2E tests per testing strategy.

---

**End of document.**
