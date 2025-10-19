Below is a concrete, engineering-focused review with an emphasis on the orchestrator. I’ll start with an architecture snapshot, then deep‑dive into OrchestratorService and propose a refactor plan and interfaces. I’ll close with broader improvement ideas and a decoupled approach for scheduled jobs/cron-like deliveries (daily reminders to Telegram, etc.).

High-level architecture review

Good things

Clear separation of concerns between transport (telegram-adapter) and the agent-server over a normalized DTO. Nice: the server is not internet-exposed; adapter is the only ingress.
Server layering is clean for a first cut: transport (controllers/guards), common (logging, rate limit, idempotency), orchestrator (graph + memory + message transform), tools (contacts/dates/reminders), integrations (Monica). Redis-backed window memory and idempotency are practical and simple.
Orchestrator is already using a SystemMessage policy, a dedicated HistoryBuilder, and a ResponseBuilder; these are solid boundaries.
Streamed NDJSON from /events/stream and edit-mode in the adapter are implemented with attention to UX and Telegram constraints.
Where the coupling stands today

Transport → Server contract is normalized (NormalizedEventDto), not Telegram specific. Good.
Thread identity is connectorId + chatId; tools get chatId via config.configurable.chatId. You use the thread key (“telegram:123”) as that chatId. That’s OK and consistent across graph, memory, tools.
Biggest risks

OrchestratorService does too much: routing modes, memory writes, history assembly, graph invocation in two flavors, streaming orchestration, delta emission, tool event dedupe, persistence, tracing/log formatting, error mapping. This makes change-risk high and testability low.
Checkpointer: MemorySaver is ephemeral. With streaming enabled and restarts, you cannot resume. Also, graph.compile() is recreated only when enableCheckpointer changes; otherwise OK, but a durable checkpointer would be safer.
Tests: some Nest template leftovers (e2e tests for “/” route) don’t match your actual API. You’ll want focused tests for the orchestrator pipeline and message (de)serializers.
Deep dive: OrchestratorService refactor
Current responsibilities in OrchestratorService

Thread context propagation (runWithThreadContext) and tracing
Command short-circuit (/start, /help, /clear)
Input normalization (via InputNormalizer)
Memory write for user message (non-checkpointer mode)
History reconstruction from memory (HistoryBuilder)
Graph invocation (two modes: checkpointer vs memory)
Streaming driver: accumulate deltas, emit tool events, finalize, and persistence
Persistence of generated messages (GeneratedMessagePersister)
Response building (ResponseBuilder)
Error mapping/log formatting
Refactor goals

Make OrchestratorService a thin façade that coordinates smaller, single-purpose services.
Unify streaming/non-streaming paths behind a common GraphDriver interface so both routes share 90% of logic.
Extract reusable streaming helpers (delta calc, tool event extraction) and make them unit-testable.
Push tracing/logging details down to components but keep high-level spans in OrchestratorService.
Proposed structure (interfaces and boundaries)

OrchestratorService (façade)

Decides command vs conversation path.
Delegates to CommandRouter or ConversationOrchestrator.
Holds the top-level span and error boundary.
ConversationOrchestrator

Performs the end-to-end pipeline for a user input:
build ConversationContext (threadKey, checkpointer flag)
call ConversationStore.persistUserInput (non-checkpointer mode only)
assemble history via TranscriptAssembler (uses HistoryBuilder under the hood)
invoke GraphDriver.run or GraphDriver.stream
persist generated messages via TranscriptPersister
compose final AgentResponse via ResponseComposer
No Telegram awareness; only normalized DTO and threadKey.
ConversationStore

Wraps MemoryService for user message write and window retrieval.
Knows the data shape for user meta and window trimming policy.
TranscriptAssembler

Wraps HistoryBuilder, MessageSerializer; returns BaseMessage[] and generatedFromIndex.
GraphDriver

run(input: GraphInput, opts): GraphRunResult
stream(input: GraphInput, opts): AsyncGenerator<StreamEvent>
Hidden inside, it chooses between checkpointer/memory modes and invokes compiled graph with proper configurable fields.
Returns canonical result shapes (messages[], generatedFromIndex, elapsedMs).
StreamEngine

Given langgraph async iterator, produces:
delta events (via DeltaAccumulator)
tool hint events (via ToolEventExtractor)
final transcript (for persistence and final response)
Stateless except for a small accumulator struct.
DeltaAccumulator

Map messageId -> lastText; produces minimal deltas per message update.
ToolEventExtractor

Given AIMessage, returns unique tool events, deduped by tool-call id.
TranscriptPersister

Wraps GeneratedMessagePersisterService with a narrow interface for “persistGenerated(messages, fromIndex)”.
ConversationStore handles user-side persistence; this handles assistant/tool.
ResponseComposer

Thin wrapper over ResponseBuilder to compose transport response and meta.
CheckpointerStrategy

Hides the choice and configuration of checkpointers (MemorySaver vs Redis/Postgres saver).
Injected into GraphFactory so GraphFactory.build() compiles with the right saver.
How this looks in code (high-level skeletons)

interface GraphDriver {
run(input: { history: BaseMessage[]; threadKey: string; generatedFromIndex: number; }): Promise<{ transcript: BaseMessage[]; generatedFromIndex: number; elapsedMs: number; }>;
stream(input: { history: BaseMessage[]; threadKey: string; generatedFromIndex: number; }): AsyncGenerator<AgentStreamEvent & { kind?: 'internal' }>;
}

class DefaultGraphDriver implements GraphDriver {
constructor(private readonly graph: CompiledGraph, private readonly checkpointer: boolean) {}
async run(input) { /* invoke graph.invoke with appropriate configurable, return uniform result */ }
async stream(input) { / invoke graph.stream, pipe through StreamEngine */ }
}

class StreamEngine {
private readonly delta = new DeltaAccumulator();
private readonly tools = new ToolEventExtractor();
async consume(iterator: AsyncIterable<unknown>) { / yield 'delta' | 'tool'; capture final transcript / }
getFinalTranscript(): BaseMessage[] { / ... */ }
}

class ConversationOrchestrator {
constructor(private readonly store: ConversationStore, private readonly assembler: TranscriptAssembler, private readonly driver: GraphDriver, private readonly persister: TranscriptPersister, private readonly composer: ResponseComposer) {}

async handle(event: NormalizedEventDto): Promise<AgentResponseDto> { /* non-stream path */ }
async handleStream(event: NormalizedEventDto): AsyncGenerator<AgentStreamEvent> { / stream path */ }
}

What this buys you

Smaller, testable units: delta calc, tool event extraction, drivers, and store can be tested in isolation.
OrchestratorService shrinks to a dozen lines. Most “non-trivial” logic moves behind crisp interfaces.
Future adapters (Matrix/web) require zero changes here.
Notes on current Telegram coupling

The orchestrator is already transport-agnostic; the only “transport knowledge” is the existence of connectorId/chatId forming threadKey and that events carry text/voice/command. Keep it that way. Your proposed refactor maintains this.
LangGraph and checkpointer notes

You compile with MemorySaver when ENABLE_CHECKPOINTER=true, otherwise no saver. MemorySaver is process-local; consider a durable checkpointer when you need resilience (Redis/Postgres). Put the saver selection behind CheckpointerStrategy and make GraphFactory accept an injected saver.
Stepwise refactor plan

Extract DeltaAccumulator and ToolEventExtractor from OrchestratorService.streamEvent into standalone classes with pure unit tests.
Extract GraphDriver (DefaultGraphDriver) encapsulating invoke/stream logic and “configurable” wiring for both modes.
Extract ConversationStore (wrap MemoryService calls) and TranscriptPersister (wrap GeneratedMessagePersisterService).
Extract ConversationOrchestrator that uses the above and make OrchestratorService delegate to it.
Move checkpointer selection to CheckpointerStrategy; let GraphFactory take it via DI.
Add contract tests around ConversationOrchestrator (run and stream).
Code quality and performance improvements (outside orchestrator)

Rate limiting
Fixed-window counter is OK; if you run multiple replicas you may get short bursts at window edges. If you ever need smoother control, switch to a sliding window or token bucket in Redis (Lua script). Keep the current default simple for now.
Idempotency
Works and is scoped to threadKey + idempotencyKey. Consider returning 202 or including a hint in meta for “in-progress duplicate” so adapters can render a nicer UX.
MemoryService
lTrim(-windowSize, -1) is correct; consider making window size adjustable per connector/thread if you later want different behaviors.
Messages transformers
Excellent separation with hydrators and tests. Keep these as-is; they’re already extracted and easy to test.
Graph nodes
PlannerNode caches and binds tools once. Consider surfacing temperature/top_p/max_tokens via config; right now defaults are implicit. Add request/run id to response_metadata for better traceability.
ToolRouterNode
Good shape. Minor tweaks:
contacts_find_by_name returns JSON string. Consider returning a structured object and letting ResponseBuilder serialize (only if the LLM needs to read it back; since it is a tool return, JSON text is acceptable).
Use a constant for last_contact_id handle name.
The node gets chatId from config.configurable.chatId; standardize this key in one place (a constant) to avoid typos.
Configuration
Config guards in AppConfigService are good. You might move env normalization (configuration.ts) into zod validation entirely for one source of truth, but your current split is readable.
Tracing/logging
You already emit span attributes and structured logs. Consider adding runId/correlationId as LLM tool hints (additional_kwargs) if you want downstream observability inside tools.
Testing
Replace the template e2e test with a “/health” test and API contract tests for /events and /events/stream.
Add unit tests for InputNormalizer, ResponseBuilder, Orchestrator streaming delta logic (after you extract it).
Security
BearerGuard is straightforward. In production, remove the “ports:” mapping for agent-server from compose to ensure it’s only on the bridge network.
Telegram adapter: streaming edits every 400ms is fine; wrap editMessageText in a retry backoff on 429 to be extra safe.
Pluggable scheduling/cron jobs (daily reminders to Telegram)
Requirement: “Run jobs on a schedule, execute functions, and deliver results to one or more recipients over any connector.”

Design goals

Decoupled from orchestrator/transport ingress; no Telegram-specific code in the server.
Durable, at-least-once execution with dedupe, and ability to target multiple connectors/users.
Re-usable “publish” path so future connectors (Matrix/web) use the same mechanism.
Recommended approach (phased)
Phase A: Simple and reliable (single instance)

Use @nestjs/schedule (ScheduleModule) for the scheduler and Redlock for leader election if you plan to run >1 replica later. For single instance, pure cron is fine.

Add a NotificationsModule with:

SubscriptionsRepository: stores subscriptions in Redis (or a DB later). Entity:
id, ownerChatId, connectorId, topic, schedule (cron or preset “daily 08:00 Europe/Belgrade”), params (JSON).
NotificationComposer: builds the message for a topic. For “reminders_digest_daily” call RemindersService.getRemindersTodayMessage().
OutboundPort (interface): send(target: DeliveryTarget, message: string, meta?): Promise<void>.
Implement TelegramOutboundClient in the telegram-adapter service via a new internal endpoint to keep tokens out of agent-server.
DeliveryTarget: { connectorId: string; chatId: string }.
Add an internal delivery endpoint in telegram-adapter, e.g. POST /deliver

Auth: Bearer token (AGENT_AUTH_TOKEN)
Body: { chatId: string; text: string }
Adapter calls ctx.api.sendMessage(chatId, text).
This keeps the adapter as the only component talking to Telegram.
Agent-server adds a DeliveryGateway client

TelegramDeliveryClient: POST to tg-adapter /deliver with bearer.
OutboundPort implementation in server calls this gateway. No Telegram coupling on the server.
A Cron job (e.g., at 08:00 local time) in NotificationsModule:

Read all active subscriptions with topic “reminders_digest_daily”.
For each, call NotificationComposer for the topic.
Publish via OutboundPort.
Store an outbox/dedupe key in Redis, e.g. notify:{topic}:{date}:{chatId} to prevent duplicates if the process restarts mid-run.
Phase B: Durable and horizontal

Switch from @nestjs/schedule to BullMQ repeatable jobs (you already run Redis). Benefits:
Persistent schedules, no double sending on restarts, rate limiting, retries, dead-letter queues.
Model:
Queue: notifications (repeatable jobs keyed by subscription id).
Worker in NotificationsModule pulls and sends via OutboundPort.
Idempotency key per job (subscriptionId + ISO date) stored in Redis to avoid dupes.
Optional: add a generic Outbox (“notification_outbox”) with “pending/sent/failed” state for auditability.
Command UX to manage subscriptions

Extend CommandRouter with:
/subscribe reminders daily — creates a subscription with topic reminders_digest_daily for the current connectorId/chatId at the default schedule.
/unsubscribe reminders — removes it.
/subscriptions — lists current topics.
SubscriptionsRepository stores per threadKey (connectorId:chatId). That gives you a trivial “send to myself on Telegram” mapping.
Minimal interfaces to add

// agent-server: Notifications
export interface DeliveryTarget { connectorId: string; chatId: string; }
export interface OutboundPort { send(target: DeliveryTarget, text: string): Promise<void>; }

// telegram-adapter: new controller
POST /deliver
Headers: Authorization: Bearer <AGENT_AUTH_TOKEN>
Body: { chatId: string; text: string }
Behavior: ctx.api.sendMessage(chatId, text)

Example job handler (simple cron, single instance)

@Cron('0 8 * * *', { timeZone: 'Europe/Belgrade' })
async sendDailyReminders() {
const subs = await this.subscriptions.findByTopic('reminders_digest_daily');
for (const sub of subs) {
const digest = await this.reminders.getRemindersTodayMessage();
if (!digest.dataAvailable) continue;

const idempotencyKey = `notif:${sub.id}:${new Date().toISOString().slice(0,10)}`;
const already = await this.cache.get(idempotencyKey);
if (already) continue;

await this.outbound.send({ connectorId: sub.connectorId, chatId: sub.chatId }, digest.message);
await this.cache.set(idempotencyKey, 1, 24*60*60);
}
}

Why adapter endpoint for delivery?

Keeps tokens and connector-specific error handling (rate limits, retries) in the adapter.
Lets you add Matrix/web adapters later by implementing the same /deliver shape.
Server stays connector-agnostic.
Smaller codebase improvements

Docker/infra
For production, remove agent-server port mapping. Keep only internal bridge networking.
Add resource limits and healthcheck for Redis in compose.
Telegram adapter
Add a small retry/backoff helper for editMessageText on 429/5xx.
Consider a maximum placeholder lifetime to avoid a stuck “Thinking…” message if the stream fails silently upstream.
DTO/validation
You have class-validator on server and zod on adapter. That’s fine. If you later share DTOs between services, consider a small shared package for the normalized event contract to avoid drift.
Contacts repository
It is in-memory. Fine for a prototype. Add a pluggable persistence port (e.g., ContactsStore) to swap for a DB without touching tools.
Feature flags
You already have features.enableStreaming and enableCheckpointer. Expose all run-mode changes through config (e.g., LLM model/parameters).
Observability
Tag all graph spans with runId/correlationId and threadKey (you already add threadKey).
Emit tool name and args (sanitized) into span events for quicker debugging.
What to verify before upgrading langchain-ts

Tool calling and streaming payloads changed occasionally in the past; you’ve isolated most of the shape assumptions. If/when upgrading @langchain/*:
Validate AIMessage.id availability in streaming (you correctly fallback to “ai-x” key).
Validate stream iterator tuple shapes ([mode, payload]); keep the type guards you wrote.
If you adopt a Redis/SQL checkpointer, swap MemorySaver in GraphFactory via the CheckpointerStrategy without touching orchestrator logic.
Bottom line

The core architecture is sound: a transport-agnostic server with a normalized ingress, a memory+graph orchestrator, and explicit tools. The main challenge is the size/complexity of OrchestratorService; splitting it as proposed will lower cognitive load and improve testability without affecting behavior.
For scheduled jobs and push delivery, add a NotificationsModule with a Subscription store and an OutboundPort. Implement a /deliver endpoint in each adapter so the server never holds connector tokens. Start with Nest cron; move to BullMQ repeatables when you need durability/horizontal scale.