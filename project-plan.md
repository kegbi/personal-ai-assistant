# 🧠 Personal AI Assistant — System Design & Architecture Overview

## 1. Overview

**Goal:**
A modular, extensible AI agent system that processes user input from **Telegram** (and later other chat platforms like **Matrix**) and performs **tool-based actions** (e.g., fetch crypto quotes, create/update data entities) using **LLM orchestration (LangGraph)**.

**Core Principles:**

* Layered, clean architecture (each component has a single responsibility)
* Replaceable adapters for input/output (e.g., Telegram → Matrix)
* Lightweight persistence (Redis only)
* Dockerized environment for easy deployment
* Focus on local orchestration (no external SaaS dependency beyond LLM API)

---

## 2. Technology Stack

| Layer                   | Component                | Technology                  | Rationale                                                                  |
| ----------------------- | ------------------------ | --------------------------- | -------------------------------------------------------------------------- |
| **Framework**           | Backend core             | **NestJS (Node 24)**        | Mature modular architecture, dependency injection, decorators, testability |
| **LLM Orchestration**   | Agent reasoning layer    | **LangGraph (LangChain)**   | Declarative graph-based reasoning with tool-calling; simple integration    |
| **Messaging Transport** | Telegram adapter         | **grammY**                  | Modern, fully typed Telegram SDK for TypeScript                            |
| **Memory / Cache**      | Working memory & handles | **Redis 8**                 | Simple, reliable in-memory storage with TTL for context/handles            |
| **Containerization**    | Runtime isolation        | **Docker Compose**          | Consistent multi-service environment                                       |
| **Tests**               | Unit / E2E               | **Jest + Testcontainers**   | Nest-native unit testing and containerized E2E scenarios                   |
| **Language / Runtime**  | —                        | **TypeScript (Node.js 24)** | Stability, ES2024 features, and top-tier ecosystem support                 |

---

## 3. Architecture Layers

### 3.1 High-Level Components

```
User (Telegram)
   │
   ▼
[Telegram Adapter Service]
   │  Normalizes messages → Unified event contract
   ▼
[Agent Server (NestJS + LangGraph)]
   │  Plans → Calls tools → Generates result
   ▼
[Redis Memory Store]
   │  Stores chat windows, "last object" handles
   ▼
External APIs (Crypto quotes, DBs, etc.)
```

---

### 3.2 Services Overview

#### 🧩 1. **Telegram Adapter**

* **Purpose:** Convert raw Telegram updates into unified JSON events and send them to the agent server.
* **Library:** grammY
* **Mode:** Long **polling** (no need for public HTTPS endpoint)
* **Responsibilities:**

    * Handle `/start`, `/help`, `/clear` commands
    * Process text & voice messages
    * Call `agent-server` via REST API (`/events`)
    * Normalize message schema → `MessageReceived`
    * Maintain internal health endpoint `/health`
* **Future extension:** Add `matrix-adapter` with same event schema.

#### 🧠 2. **Agent Server**

* **Framework:** NestJS
* **LLM Engine:** LangGraph (in-process)
* **Responsibilities:**

    * Manage orchestration graph (plan → route → respond)
    * Tool execution and response generation
    * Maintain short-term message memory (via Redis)
    * Define domain tools (e.g., `quotes.tool.ts`, `contacts.tool.ts`)
    * Provide REST API endpoints `/events`, `/health`
* **Memory policy:**

    * Stores last 15 messages per chat
    * Optional conversation summarization
    * Per-chat “handles” (e.g., `last_contact_id`) with TTL (default 2 hours)

#### 🧱 3. **Redis**

* **Purpose:** Ephemeral working memory
* **Usage:**

    * Chat message window
    * Handles (links to recently created entities)
    * Transient context storage (short-lived summaries)

---

## 4. Project Structure

```
personal-ai-assistant/
├─ infra/
│  ├─ .env.example
│  ├─ telegram.env.example
│  └─ docker-compose.yml
│
├─ services/
│  ├─ agent-server/
│  │  ├─ infra/
│  │  │  └─ Dockerfile
│  │  ├─ src/
│  │  │  ├─ app.module.ts
│  │  │  ├─ main.ts
│  │  │  ├─ orchestrator/
│  │  │  │  ├─ langgraph/
│  │  │  │  │  ├─ graph.ts
│  │  │  │  │  ├─ planner.node.ts
│  │  │  │  │  └─ tool-router.node.ts
│  │  │  │  ├─ tools/
│  │  │  │  │  ├─ quotes.tool.ts
│  │  │  │  │  └─ contacts.tool.ts
│  │  │  │  └─ memory/
│  │  │  │     ├─ redis.store.ts
│  │  │  │     └─ policies.ts
│  │  │  ├─ transport/
│  │  │  │  ├─ http.controller.ts
│  │  │  │  └─ dto/
│  │  │  └─ common/
│  │  │     ├─ logger.interceptor.ts
│  │  │     └─ exception.filter.ts
│  │  └─ test/
│  │     ├─ unit/
│  │     └─ e2e/
│  │
│  └─ telegram-adapter/
│     ├─ infra/
│     │  └─ Dockerfile
│     ├─ src/
│     │  ├─ telegram/
│     │  │  ├─ bot.ts
│     │  │  ├─ commands.ts
│     │  │  └─ polling.ts
│     │  ├─ mapping/
│     │  │  └─ normalize.ts
│     │  ├─ transport/
│     │  │  └─ agent.client.ts
│     │  └─ health/
│     │     └─ route.ts
│     └─ test/
│        └─ unit/
│
└─ .gitignore
```

---

## 5. Deployment Setup (Docker Compose)

### 5.1 Updated Versions

* **Node.js:** `24-alpine`
* **Redis:** `8-alpine`

### 5.2 Compose Overview

```yaml
version: "3.9"

services:
  redis:
    image: redis:8-alpine
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10
    networks: [appnet]

  agent-server:
    build:
      context: ../services/agent-server
      dockerfile: ./infra/Dockerfile
    env_file:
      - ./.env
    environment:
      NODE_ENV: production
      PORT: 3000
      REDIS_HOST: redis
      REDIS_PORT: 6379
      MEM_WINDOW_SIZE: 15
      HANDLE_TTL_SECONDS: 7200
    depends_on:
      redis:
        condition: service_healthy
    ports: ["3000:3000"]
    networks: [appnet]

  tg-adapter:
    build:
      context: ../services/telegram-adapter
      dockerfile: ./infra/Dockerfile
    env_file:
      - ./.env
    environment:
      NODE_ENV: production
      TG_MODE: polling
      AGENT_BASE_URL: http://agent-server:3000
    depends_on:
      agent-server:
        condition: service_healthy
    networks: [appnet]

volumes:
  redis-data:

networks:
  appnet:
    driver: bridge
```

---

## 6. Environment Variables

### `.env.example`

```env
# === Common ===
ALLOWED_CHAT_ID=123456789
TZ=Europe/Belgrade

# === LLM ===
OPENAI_API_KEY=sk-xxxx
LLM_MODEL=gpt-5-thinking

# === Telegram ===
TG_BOT_TOKEN=123456:ABCDEF-xxx
TG_MODE=polling

# === Agent Communication ===
AGENT_BASE_URL=http://agent-server:3000

# === Redis ===
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_DB=0
```

---

## 7. Design Rationale

| Decision                               | Reasoning                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| **Long Polling Mode**                  | No external HTTPS needed; perfect for local/VPS setups; simpler for MVP             |
| **Redis for Memory**                   | Lightweight short-term store with TTL; no full database overhead                    |
| **NestJS Backend**                     | Clean modular structure, ideal for large-scale service evolution                    |
| **LangGraph Integration (in-process)** | Keeps reasoning local, easy to debug, extensible to multiple tools                  |
| **Separate Telegram Adapter**          | Enables adding new transports (Matrix, Discord) by just reusing same event contract |
| **Dockerized Setup**                   | Consistent across environments, easy dev-to-prod parity                             |
| **Minimal Persistence**                | Avoid early complexity — just store chat context and handles                        |
| **.env configuration**                 | Environment-driven; supports clean overrides in CI/CD or multiple deployments       |

---

## 8. Next Steps

1. **Implement message contract** between adapter ↔ agent (`MessageReceived`, `AgentResponse`).
2. **Bootstrap grammY bot** with long polling and command handlers.
3. **Implement NestJS controller `/events`** to accept incoming messages.
4. **Add basic LangGraph plan/tool graph**:

    * `planner.node.ts` → decides intent
    * `tool-router.node.ts` → executes appropriate tool
5. **Integrate Redis memory layer** with simple TTL-based context storage.
6. **Add health checks & testcontainers tests.**

---

## 9. Long-Term Extensions

* Matrix / Discord adapters using same event schema
* Persistent conversation DB (Postgres) for summaries / logs
* LangGraph checkpointer for multi-turn thread state
* Webhook-based Telegram delivery (with Nginx / Cloudflare Tunnel)
* LangGraph streaming responses for real-time UX