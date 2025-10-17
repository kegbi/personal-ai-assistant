Below is a practical, end‑to‑end analysis and a concrete refactoring blueprint you can use as a working document. I’ve organized it to first address your concerns, then add my own research and findings, and finally provide a high‑level architecture and detailed code‑level guidance, including example module/function structures and code snippets you can drop in.

Executive summary (what’s good now vs. what to change)
- What’s already strong
    - Clear layering and DI via NestJS modules; config is validated; Redis usage is clean (window + ephemeral handles); Monica integration is strongly typed and guarded; LangGraph MessagesAnnotation + ToolNode use is pragmatic; well-factored message hydrators with tests.
    - Telegram adapter is isolated and speaks to the server over HTTP on an internal network with allow‑list support. Health endpoints present on both server and adapter.
- What should change first (highest ROI, lowest risk)
    - Decouple orchestrator from any transport semantics and shrink its responsibilities. Introduce a small “Router” that delegates commands, LLM runs, and tool execution; move all input normalization out of orchestrator.
    - Introduce an interface/port for memory and use LangGraph checkpointers for durable, thread‑aware runs. Keep Redis for ephemeral handles but stop replaying long history yourself when the graph can persist it.
    - Add a small EventsController with token auth and idempotency to actually receive /events from Telegram adapter (missing in the snippet).
    - Make tools robust to user date formats; normalize and validate to ISO in the tool implementation rather than relying on “LLM got this right.”
    - Add service‑to‑service auth, request correlation IDs, structured logs and an error taxonomy for Monica calls (timeouts, backoff).
- What to plan for soon (scalability and flexibility)
    - Port/adapter model for transports (Telegram/Matrix/Web): normalize inbound events into a canonical DTO (connectorId + chatId + userId + messageType + payload). The orchestrator should not care which adapter sent it.
    - Unified identity and memory keys across connectors. Adopt a ThreadKey composed of connectorId + chatId + (optional) userId and keep a mapping table for future multi‑connector experiences.
    - Observability (OpenTelemetry), streaming replies, and interruptible runs using LangGraph’s streaming/checkpointing APIs.

1) Addressing your stated concerns
   A. Decoupling transport and server; ability to swap Telegram with Matrix/Web
- Current state: Telegram adapter is a separate service. On the server side, OrchestratorService consumes MessageReceivedDto that looks conceptually aligned with the adapter but is assumed rather than defined as a versioned, transport‑agnostic contract.
- Issues
    - Orchestrator has a resolveUserContent method that is effectively transport content normalization (text vs. voiceUrl). That belongs in a transport adapter or an input normalizer layer, not in the orchestrator.
    - Memory keys use chatId with no connector dimension; collisions will occur when you add other connectors or test sandboxes.
- Fix
    - Define a transport‑agnostic inbound event contract and a small “InputNormalizer” per connector. Or, standardize on an event envelope with fields: connectorId, chatId, userId, messageType (“text|voice|command|other”), text?, voiceUrl?, payload?, idempotencyKey?.
    - Use a ThreadKey = `${connectorId}:${chatId}` as the primary context key in memory and handles. Maintain a UserKey when you need cross‑chat aggregation (optional).

B. Orchestrator module has “non‑trivial functions/solutions” and may be coupled with Telegram message structure
- Current state: OrchestratorService does:
    - Command interpretation (/start, /help, /clear)
    - Push user message to memory, reconstruct history, invoke graph, persist generated messages, pick the final assistant message, and format the transport response.
    - Minor transport normalization for voice messages.
- What’s OK
    - The class is cohesive within an MVP. Logging and persistence are clear; a single GraphFactory is fine.
- What to improve
    - Extract “commands” into a CommandRouter with a dictionary of handlers.
    - Extract “LLM run” into a GraphRunner that knows how to invoke/stream/checkpoint a run and return a RunResult.
    - Extract “input normalization” so Orchestrator only deals with normalized events (no mention of voiceUrl).
    - Define a ResponseBuilder to transform LangGraph messages into a transport‑agnostic reply (text + optional meta).
- Net effect: Orchestrator shrinks to orchestration: it routes normalized events to either a CommandRouter or GraphRunner and then uses ResponseBuilder. No Telegram references remain.

C. Context/memory consistency across connectors; single‑user assumption
- Current state: Redis window keyed by chatId; ephemeral handles keyed by chatId + handleKey.
- Risks
    - If/when you add connectors, the same chatId string may collide; memory leaks across channels.
- Recommended
    - Key memory by ThreadKey = {connectorId}:{chatId}. Use the same ThreadKey as LangGraph thread_id.
    - If multi‑user emerges later, introduce a stable “principalId” abstraction mapping to one or more ThreadKeys.

D. Performance and correctness of command orchestrator
- Current state: Graph.invoke with a reconstructed message history. Tool calls stored/replayed via hydrators. Good.
- Improvements
    - For long conversations, replay cost grows. Prefer LangGraph’s checkpointer (MemorySaver, Redis, SQLite, or Postgres) to resume from checkpoints instead of replaying windowed history yourself. This reduces latency, memory, and complexity in HistoryBuilder.
    - Add idempotency at the transport boundary to avoid double processing (Telegram can deliver duplicates; you already track updateId in payload — use it).

2) LangChain/LangGraph (JS/TS) research you asked me to do
- LangChain.js and @langchain/core continue to push the Runnable protocol and messages abstraction you’re using. Tools with zod schemas and ChatOpenAI.bindTools remain the recommended approach.
- LangGraph’s model (Pregel engine, StateGraph, ToolNode, MessagesAnnotation) is steady, and the TS API stays very close to Python’s conceptual model. Newer guidance emphasizes:
    - Using checkpointers and stores to persist state after each super‑step (reduces the need for bespoke history memory).
    - Streaming graph runs (stream_mode=values|updates|messages) to build responsive UIs or chat bridges.
    - Interrupts/human‑in‑the‑loop via resumable runs.
- What to apply here
    - Add a Checkpointer (e.g., MemorySaver now, Redis/Postgres later) to compiled graph; pass thread_id=configurable.ThreadKey so runs per chat can resume without replaying memory.
    - Prefer graph.stream for Telegram typing indicator + incremental message edits when feasible.

3) High‑level architecture, deployment, inter‑service interaction, data
   Target architecture (hexagonal, scalable)
- Domain (pure logic)
    - Contacts domain (your app “contacts service” and Monica integration live here)
    - Reminders domain
    - Memory domain (abstraction over short‑term thread memory and long‑term store)
- Application
    - Orchestrator (tiny): routes events to CommandRouter or GraphRunner
    - GraphRunner: wraps LangGraph compiled graph, checkpointer, streaming
    - ToolRegistry and ToolRouter (kept stateless; receives RunnableConfig with ThreadKey)
    - CommandRouter: stateless handlers (/start, /help, /clear)
- Adapters (ports)
    - Transport adapters: Telegram, Matrix, Web
    - Persistence adapters: Redis window memory, checkpointer backend, long‑term store
    - External integrations: MonicaClient
- Cross‑cutting
    - Observability (OpenTelemetry), structured logs with correlationId and thread_id
    - Security/auth between adapter and server (shared token or mTLS), rate limits
    - Idempotency (dedupe by idempotencyKey)

Deployment (first phases)
- docker-compose services (all on an internal network)
    - agent-server (Nest)
    - redis
    - telegram-adapter
    - (optional) postgres (later, for checkpointer or Monica caching)
- Security
    - Only telegram‑adapter is allowed to egress to Telegram
    - telegram‑adapter → agent-server: HTTP over the internal network with an Authorization: Bearer token. Add a Guard on server.
    - Redis not exposed outside the internal network
- Observability
    - Add request logs with chatId/ThreadKey and updateId/idempotencyKey. Enable traces for graph runs.

Data model and keys
- ThreadKey: connectorId + chatId (e.g., “tg:12345678”)
- RunId: generated per orchestrator handling (logged, trace root)
- IdempotencyKey: connector’s updateId or messageId (Telegram: update.update_id or message_id)
- Memory
    - Short‑term: checkpointer + Redis handles (handles keep last_contact_id, etc.)
    - Long‑term: optional Postgres store (later) for real durable memory not tied to window

4) Code‑level analysis and fixes
   A. OrchestratorService
- Strengths: Compact, readable; good logging; persistence of generated messages; transport meta extraction.
- Issues/risks
    - resolveUserContent belongs to a normalization step (or the adapter).
    - Works by replaying MemoryService window; long‑term this won’t scale as threads lengthen.
    - No idempotency guard; may persist duplicates on retries.
    - Authentication and /events controller are missing in the snippet; ensure there is an HTTP endpoint and a Guard.
- Actions
    - Introduce CommandRouter, GraphRunner, InputNormalizer, ResponseBuilder; see blueprint below.
    - Add a DedupeService (Redis set with TTL) keyed by ThreadKey + idempotencyKey; if seen, ignore.
    - Add an EventsController POST /events that passes through Nest ValidationPipe and an AuthGuard.

B. GraphFactory, PlannerNode, ToolRouterNode
- Strengths: MessagesAnnotation + ToolNode composition; RunnableConfig configurable.chatId is leveraged (good).
- Fixes
    - Add checkpointer at compile time and accept thread_id from config.configurable.
    - ToolRouterNode.isPartialMessagesState checks “record-ness” only. Tighten: assert it has messages: BaseMessage[] and matches MessagesAnnotation.State shape.
    - Tool schemas: z.string for date is fragile. Parse human input robustly inside tools.
    - PlannerNode caches ChatOpenAI.bindTools per process, which is fine. Consider binding temperature/top_p from config and allowing per‑connector overrides later.
- Performance
    - Streaming: Use graph.stream to deliver progressive responses (Telegram can edit a single message) and to show “typing”.

C. Messages module (hydrators, transformer, history builder)
- Strengths: Well‑tested, thoughtful handling of legacy tool shapes; safe deep copies; fallback SystemMessage for orphaned tool responses.
- Improvement
    - Once a checkpointer is used, HistoryBuilder becomes optional. You can keep it for initial local memory mode, but prefer graph persistence for correctness and speed.
    - MessageTransformer.fromBaseMessage for ToolMessage stores both toolCallId and tool_call_id in meta; keep one canonical field internally and provide both only for back‑compat in persistence.

D. MemoryService and Redis provider
- Strengths: Window management with LTRIM; handles with TTL; scanIterator to clear handles.
- Fixes
    - Key by ThreadKey (connectorId:chatId). Add a helper to compose keys consistently.
    - Add optional Redis TLS/auth config. Accept REDIS_PASSWORD/REDIS_TLS envs.
    - Add getWindowRange or getRecent(n) if you keep windowed replay in some paths.
    - Add a small async withRetry (exponential backoff) around Redis ops if needed.

E. Reminders, Monica client/services
- Strengths: Rigorous type guards (monica.guards), strong separation in module; good logs.
- Fixes
    - MonicaClient: add timeouts via AbortController; backoff/retry transient 5xx and 429; classify MonicaApiError status codes. Return typed errors to caller.
    - fetchAllReminders: respect pagination limits; introduce max pages guard; add optional caching (Redis) with short TTL to avoid hammering Monica on every reminders_get_upcoming tool call.
    - RemindersService: date formatting is fine; consider separating presentational string building from data shaping (so web/UI adapters can reuse the data).

F. Telegram adapter
- Strengths: Allowed chat IDs; leaves group chats; robust error logging; small health server; metric snapshot.
- Fixes
    - Add idempotencyKey to payload (use update.update_id) and forward to server.
    - In long polling, use sendChatAction('typing') while awaiting the agent; optionally edit a placeholder message with streaming output.
    - Handle Telegram rate limits (429) with simple backoff on sendMessage.

G. Transport layer on server (missing piece)
- Add EventsController:
    - POST /events with DTO mirroring adapter payload. Validate with class-validator.
    - Bearer token Guard (compare against env).
    - Return AgentResponseDto. Consider returning meta.elapsedMs and tool summary.

H. Config and Common
- Config: You already validate with zod. Add REDIS_PASSWORD, REDIS_TLS, AGENT_AUTH_TOKEN.
- Logging: Replace default Nest logger with pino or add a PinoLogger provider; include correlationId=RunId and threadId=ThreadKey in each log line (via interceptor).

I. Dockerfiles
- Improve run image size:
    - In run stage, use “pnpm install --prod --frozen-lockfile” (don’t install dev deps).
    - Consider using node:22‑alpine for a smaller base unless 24 features are needed.
    - Add non‑root user (you already do). Ensure proper folder ownership for pnpm store if needed.
    - Add HEALTHCHECK for server.

5) Refactoring blueprint (module/function structure + code samples)
   Goal: shrink orchestrator, isolate transport, adopt checkpointer, add idempotency and streaming.

A. Contracts
- Normalized inbound event
  interface NormalizedEvent {
  connectorId: 'telegram' | 'matrix' | 'web';
  chatId: string;
  userId?: string;
  type: 'text' | 'voice' | 'command' | 'other';
  text?: string;
  voiceUrl?: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string; // e.g., Telegram update.update_id
  }
- ThreadKey helper
  const threadKey = (connectorId: string, chatId: string) => `${connectorId}:${chatId}`;

B. Transport adapter contract (server side)
- EventsController (server/api/transport/events.controller.ts)
  import { Controller, Post, Body, UseGuards } from '@nestjs/common';
  import { OrchestratorService } from '../../orchestrator/orchestrator.service';
  import { AuthGuard } from '../guards/bearer.guard';
  import { NormalizedEventDto } from '../dto/normalized-event.dto';
  import { AgentResponseDto } from '../dto/agent-response.dto';

  @UseGuards(AuthGuard)
  @Controller('events')
  export class EventsController {
  constructor(private readonly orchestrator: OrchestratorService) {}
  @Post()
  async post(@Body() dto: NormalizedEventDto): Promise<AgentResponseDto> {
  return this.orchestrator.handleEvent(dto);
  }
  }

- BearerGuard skeleton (server/api/transport/guards/bearer.guard.ts)
  import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
  import { AppConfigService } from '../../../config/config.service';

  @Injectable()
  export class AuthGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}
  canActivate(ctx: ExecutionContext): boolean {
  const req = ctx.switchToHttp().getRequest();
  const header = req.headers?.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || token !== process.env.AGENT_AUTH_TOKEN) {
  throw new UnauthorizedException('Invalid token');
  }
  return true;
  }
  }

- NormalizedEventDto (class-validator)
  export class NormalizedEventDto {
  connectorId!: string; // telegram|matrix|web
  chatId!: string;
  userId?: string;
  type!: 'text' | 'voice' | 'command' | 'other';
  text?: string;
  voiceUrl?: string;
  idempotencyKey?: string;
  payload?: Record<string, unknown>;
  }

C. Orchestrator shrink and separation
- New small services
    - InputNormalizer: per connector mapping (mostly used on adapter side; server fallback is OK)
    - CommandRouter: pure dictionary of handlers (start/help/clear…)
    - GraphRunner: wraps compiled graph with checkpointer and streaming
    - ResponseBuilder: converts final AIMessage into AgentResponseDto
    - DedupeService: Redis‑backed idempotency guard

- Sample orchestrator (server/orchestrator/orchestrator.service.ts)
  async handleEvent(evt: NormalizedEventDto): Promise<AgentResponseDto> {
  const thread = threadKey(evt.connectorId, evt.chatId);

  if (evt.idempotencyKey && !(await this.dedupe.tryMark(thread, evt.idempotencyKey))) {
  // already processed
  return { chatId: evt.chatId, text: '[duplicate ignored]' };
  }

  if (evt.type === 'command' && evt.text) {
  return this.commandRouter.handle(evt, thread);
  }

  const userContent = this.inputNormalizer.toText(evt); // e.g., voiceUrl -> '[voice message received: ...]'
  await this.memory.pushMessage(thread, { role: 'user', content: userContent, meta: evt.payload });

  const result = await this.graphRunner.run(thread); // see GraphRunner below
  await this.generatedPersister.persistGeneratedMessages(thread, result.generatedMessages);

  return this.responseBuilder.build(evt.chatId, result);
  }

D. GraphRunner with checkpointer and streaming
- GraphFactory with checkpointer (server/orchestrator/langgraph/graph.factory.ts)
  import { MemorySaver } from '@langchain/langgraph'; // or Redis/Postgres when ready

  build(): CompiledGraph {
  if (!this.compiledGraph) {
  const workflow = new StateGraph(MessagesAnnotation)
  .addNode('planner', (s,c)=>this.planner.execute(s,c))
  .addNode('tool-router', (s,c)=>this.tools.execute(s,c))
  .addEdge(START, 'planner')
  .addConditionalEdges('planner', (s)=>this.planner.determineNext(s), { tool: 'tool-router', respond: END })
  .addEdge('tool-router', 'planner');

      const saver = new MemorySaver(); // later replace with Redis or Postgres saver
      this.compiledGraph = workflow.compile({ checkpointer: saver });
  }
  return this.compiledGraph;
  }

- GraphRunner (server/orchestrator/graph-runner.service.ts)
  async run(thread: string): Promise<{ generatedMessages: BaseMessage[]; final: AIMessage | null; toolMeta?: ToolInvocationMeta; }> {
  // stream variant to support progressive UX
  // For a simple invoke (non-stream):
  const result = await this.graph.invoke({ messages: [] }, { configurable: { thread_id: thread, chatId: thread } });
  const raw = Array.isArray(result.messages) ? result.messages : [];
  const messages = raw.filter(isBaseMessage);
  const final = this.pickFinal(messages);
  const toolMeta = this.serializer.extractToolMeta(messages);

  // With checkpointer, no need to rebuild history — graph resumes from checkpoint using thread_id
  const generated = messages; // or slice if you keep a snapshot of previous count per run
  return { generatedMessages: generated, final, toolMeta: toolMeta ?? undefined };
  }

  private pickFinal(messages: BaseMessage[]): AIMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) if (isAIMessage(messages[i])) return messages[i] as AIMessage;
  return null;
  }

E. Tool robustness and date normalization
- Replace birthday strings with a parsing helper inside tools. Accept common formats and normalize to ISO.
  // tools/dates.service.ts
  import { parse, isValid, format } from 'date-fns';
  const formats = ['yyyy-MM-dd', 'dd.MM.yyyy', 'dd-MM-yyyy', 'MM/dd/yyyy'];

  export const normalizeToISO = (input: string): string | null => {
  for (const f of formats) {
  const d = parse(input, f, new Date());
  if (isValid(d)) return format(d, 'yyyy-MM-dd');
  }
  return null;
  };

  // In contacts_set_birthday tool:
  const iso = normalizeToISO(birthday) ?? birthday.match(/^\d{4}-\d{2}-\d{2}$/)?.[0] ?? null;
  if (!iso) return 'Please provide a valid date (e.g., 1991-05-14 or 14.05.1991).';

- Adjust zod schema to accept string but not enforce ISO. Validation and coercion happens in the tool function.

F. Idempotency service (server/common/idempotency.service.ts)
export class DedupeService {
constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {}
async tryMark(thread: string, key: string, ttlSec = 600): Promise<boolean> {
const redisKey = `idemp:${thread}:${key}`;
const res = await this.redis.set(redisKey, '1', { NX: true, EX: ttlSec });
return res === 'OK';
}
}

G. Memory keying and helpers
- MemoryService should accept threadKey instead of chatId or keep both methods and delegate:
  private windowKey(thread: string): string { return `memory:window:${thread}`; }
  private handleKey(thread: string, key: string): string { return `memory:handle:${thread}:${key}`; }

H. Auth and validation on /events
- Ensure EventsController uses the global ValidationPipe (already set in main.ts).
- Add AGENT_AUTH_TOKEN to server config and adapter uses the same token (already supported by AgentClient).

I. Streaming to Telegram (optional now, easy later)
- Use graph.stream to iterate updates and send a temporary “typing…” followed by message edits. If you stick to invoke for now, at least send ChatAction.typing while waiting.

J. Tests to add
- Orchestrator integration test: text message → GraphRunner, persistence, response
- ToolRouterNode unit tests: missing chatId in RunnableConfig → throws
- Date normalization unit tests with edge formats
- DedupeService test
- EventsController e2e test with token guard

6) Example tool and prompt tweaks
- Prompt: expand policy to explicitly ask the model to normalize dates through the date tool or enforce “call contacts_set_birthday whenever user mentions a date, even if not ISO; pass raw string, tool will normalize.”
- Tool definition names should reflect actions the LLM can pick easily; they look good now. Consider adding contacts_find_by_name to let LLM find contact IDs rather than relying solely on last_contact_id handle (more robust across sessions).

7) Prioritized backlog (short, medium, long)
- Short (1–2 days)
    - Add EventsController + BearerGuard; wire adapter auth
    - Add DedupeService and use idempotencyKey
    - Refactor Orchestrator into CommandRouter + GraphRunner + ResponseBuilder; move resolveUserContent out
    - Date normalization inside tools
    - Memory keys switched to ThreadKey

- Medium (1–2 weeks)
    - Introduce checkpointer in GraphFactory; pass thread_id = ThreadKey
    - Add streaming path (optional) with Telegram typing/edit flow
    - Monica client timeouts and backoff; reminders caching
    - Observability: add correlationId (RunId), threadId, and operation names to logs; basic OTEL traces
    - Hardening Redis provider (TLS/password)

- Long (2–6 weeks)
    - Multi‑connector identity mapping and unified user model (principalId)
    - Replace MemorySaver with Redis/Postgres checkpointer; Postgres store for durable long‑term memory
    - Add a small vector store for semantic memory (optional)
    - Matrix/Web adapters; shared adapter interfaces and adapter tests
    - Human‑in‑the‑loop interrupts via LangGraph (approve tool writes, etc.)

Appendix: Sample nested module structure (server)
- src/
    - api/
        - transport/
            - events.controller.ts
            - dto/
                - normalized-event.dto.ts
            - guards/
                - bearer.guard.ts
    - orchestrator/
        - orchestrator.module.ts
        - orchestrator.service.ts
        - command-router.service.ts
        - graph-runner.service.ts
        - response-builder.service.ts
        - langgraph/
            - graph.factory.ts
            - nodes/
                - planner.node.ts
                - tool-router.node.ts
    - memory/
        - memory.module.ts
        - memory.service.ts
    - tools/
        - tools.module.ts
        - contacts/
            - contacts.service.ts
        - dates/
            - dates.service.ts
    - integrations/
        - monica/
            - monica.module.ts
            - monica.client.ts
            - contacts/
            - reminders/
            - notes/
    - common/
        - idempotency.service.ts
        - logging.interceptor.ts (augmented to add correlationId/threadId)
        - exception.filter.ts
    - config/
        - config.module.ts
        - config.service.ts
        - configuration.ts
        - config.validation.ts
    - policies/
        - prompt.policy.ts

Appendix: Minimal code for CommandRouter and ResponseBuilder
- CommandRouter
  export class CommandRouter {
  constructor(private readonly memory: MemoryService) {}
  async handle(evt: NormalizedEventDto, thread: string): Promise<AgentResponseDto> {
  const cmd = (evt.text ?? '').split(' ')[0].toLowerCase();
  switch (cmd) {
  case '/start':
  await this.memory.clear(thread);
  return { chatId: evt.chatId, text: 'Hello! I am your personal AI assistant...' };
  case '/clear':
  await this.memory.clear(thread);
  return { chatId: evt.chatId, text: 'Cleared recent conversation memory for this chat.' };
  case '/help':
  return { chatId: evt.chatId, text: 'Try:\n• “Remember that Alice...”\n• “Set Alice’s birthday...”\n• “Who is Alice?”' };
  default:
  return { chatId: evt.chatId, text: `Unknown command ${cmd}. Available: /start, /help, /clear.` };
  }
  }
  }

- ResponseBuilder
  export class ResponseBuilder {
  constructor(@Inject(MESSAGE_SERIALIZER) private readonly serializer: MessageSerializer) {}
  build(chatId: string, result: { final: AIMessage | null; generatedMessages: BaseMessage[]; toolMeta?: ToolInvocationMeta }): AgentResponseDto {
  if (!result.final) {
  return { chatId, text: 'I am not sure how to respond to that just yet.' };
  }
  return {
  chatId,
  text: this.serializer.extractMessageContent(result.final),
  meta: result.toolMeta ? { tool: result.toolMeta.name, args: result.toolMeta.args } : undefined,
  };
  }
  }

Closing notes
- The current codebase is a good foundation. The biggest practical wins are to (1) shrink and purify the orchestrator, (2) embrace LangGraph checkpointer to eliminate manual history replay, (3) make tools resilient to real‑world inputs (dates), and (4) add a minimal transport boundary with auth + idempotency. These changes will make swapping connectors easy, improve performance/robustness immediately, and set you up for multi‑connector and streaming experiences with minimal rework later.