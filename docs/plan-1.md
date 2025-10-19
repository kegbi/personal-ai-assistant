Target system: agent-server (NestJS), adapters (telegram-adapter)
Scope: Only refactor. Leave space/hooks for Phase 2 (perf/quality) and Phase 3 (BullMQ scheduling), but do not implement them now.

Goals
Reduce complexity and coupling in OrchestratorService by splitting responsibilities into smaller, testable services without changing external behavior or APIs.
Keep transport-agnostic design intact and compatible with existing telegram-adapter.
Preserve current features: commands, memory mode, checkpointer mode, streaming NDJSON, tool-hint streaming, idempotency, rate limiting, tracing/logging.
Establish extension points for:
Durable checkpointer strategy (future).
Quality/performance improvements (future).
Scheduling with BullMQ and decoupled delivery (future).
2. Non-goals

No behavior changes visible to clients.
No changes to DTOs, controllers, or adapter contracts.
No change in storage (still Redis for memory/idempotency).
Do not implement scheduling or BullMQ in this phase.
3. Constraints and compatibility

Keep Node/OpenAI/LangGraph versions as in package.json.
Maintain ResponseBuilder output and streaming protocol exactly.
Maintain threadKey contract: buildThreadKey(connectorId, chatId).
Maintain configurable.chatId semantics for tools/graph.
4. Deliverables

Refactored orchestrator with the following new components:
DeltaAccumulator (pure)
ToolEventExtractor (pure)
TextExtractor (pure)
GraphDriver (interface) and DefaultGraphDriver (impl)
ConversationStore
TranscriptAssembler
TranscriptPersister
ResponseComposer (thin wrapper over current ResponseBuilder)
ConversationOrchestrator
CheckpointerStrategy (interface) for future use
Wiring in OrchestratorModule; OrchestratorService delegates to ConversationOrchestrator.
Unit tests for new pure components and integration tests ensuring unchanged behavior.
5. Stepwise plan (each step builds on the previous)

Step 0 – Baseline and safety net

Add golden-path tests to lock current external behavior.
Tests:
/events: text request that triggers an AI reply (mock LLM) returns same AgentResponseDto as before.
/events: command /help returns same text.
/events/stream: verify start, several delta chunks, tool hint, and final match the current stream shape.
Mock GraphFactory.build() to a stub graph when needed; do not alter production code.
Acceptance:
New tests pass on current main before any refactor.
Step 1 – Extract pure helpers used by streaming
1.1 Add TextExtractor

File: src/orchestrator/streaming/text-extractor.ts
Responsibility: convert MessageContent to text (current extractTextFromContent logic).
Code sample:
// src/orchestrator/streaming/text-extractor.ts
import type { MessageContent } from '@langchain/core/messages';

export class TextExtractor {
extract(content: MessageContent): string {
if (typeof content === 'string') return content;
const out: string[] = [];
for (const seg of content) {
if (typeof seg !== 'object' || seg === null || Array.isArray(seg)) continue;
const type = Reflect.get(seg, 'type');
if (type === 'text') {
const text = Reflect.get(seg, 'text');
if (typeof text === 'string') out.push(text);
}
}
return out.join('');
}
}
1.2 Add DeltaAccumulator

File: src/orchestrator/streaming/delta-accumulator.ts
Responsibility: accumulate per-AI-message deltas based on stable message ids (with fallback keys).
Code sample:
// src/orchestrator/streaming/delta-accumulator.ts
export class DeltaAccumulator {
private readonly lastByKey = new Map<string, string>();

computeDelta(key: string, nextText: string): string {
const prev = this.lastByKey.get(key);
if (prev === undefined) {
this.lastByKey.set(key, nextText);
return nextText;
}
if (nextText.startsWith(prev)) {
const delta = nextText.slice(prev.length);
this.lastByKey.set(key, nextText);
return delta;
}
// Fallback when text was overwritten
this.lastByKey.set(key, nextText);
return nextText;
}
}
1.3 Add ToolEventExtractor

File: src/orchestrator/streaming/tool-event-extractor.ts
Responsibility: unique tool-hint emission per tool_call id.
Code sample:
// src/orchestrator/streaming/tool-event-extractor.ts
import type { AIMessage } from '@langchain/core/messages';
import type { AgentStreamEvent } from '../../transport/dto/agent-stream-event.dto';

export class ToolEventExtractor {
private readonly emitted = new Set<string>();

extract(message: AIMessage): AgentStreamEvent[] {
const events: AgentStreamEvent[] = [];
const calls = message.tool_calls;
if (!Array.isArray(calls)) return events;

    for (let i = 0; i < calls.length; i += 1) {
      const call = calls[i];
      const name = call?.name;
      if (typeof name !== 'string' || name.length === 0) continue;

      const callId = typeof call.id === 'string' && call.id.length > 0
        ? call.id
        : `${message.id ?? 'tool'}:${i}`;
      if (this.emitted.has(callId)) continue;

      const args = this.normalizeArgs(call.args);
      if (!args) continue;

      this.emitted.add(callId);
      events.push({ type: 'tool', name, args });
    }
    return events;
}

private normalizeArgs(args: unknown): Record<string, unknown> | null {
if (args && typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>;
if (typeof args === 'string') {
try {
const parsed = JSON.parse(args);
return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
? (parsed as Record<string, unknown>)
: null;
} catch { return null; }
}
return null;
}
}
1.4 Wire Step 1 (temporary)

Update OrchestratorService.streamEvent to use TextExtractor, DeltaAccumulator, ToolEventExtractor in place (do not move other logic yet).
Acceptance:
All tests pass, zero behavior change.
Step 2 – Introduce GraphDriver abstraction
2.1 Add GraphDriver interface and DefaultGraphDriver

Files:
src/orchestrator/graph/graph-driver.ts (interface)
src/orchestrator/graph/default-graph-driver.ts (implementation)
Responsibilities:
Encapsulate graph.invoke and graph.stream calls and the checkpointer vs memory “configurable” wiring.
Interface and impl:
// src/orchestrator/graph/graph-driver.ts
import type { BaseMessage } from '@langchain/core/messages';
import type { AgentStreamEvent } from '../../transport/dto/agent-stream-event.dto';

export interface RunInput {
history: BaseMessage[];
threadKey: string;
generatedFromIndex: number;
useCheckpointer: boolean;
}

export interface RunResult {
transcript: BaseMessage[];
generatedFromIndex: number;
elapsedMs: number;
}

export interface GraphDriver {
run(input: RunInput): Promise<RunResult>;
stream(input: RunInput): AsyncGenerator<AgentStreamEvent | { kind: 'internal'; messages?: BaseMessage[] }>;
}
// src/orchestrator/graph/default-graph-driver.ts
import type { BaseMessage, AIMessage } from '@langchain/core/messages';
import type { GraphDriver, RunInput, RunResult } from './graph-driver';
import type { AgentStreamEvent } from '../../transport/dto/agent-stream-event.dto';
import type { CompiledGraph } from '../langgraph/graph.factory';
import { isAIMessage, isBaseMessage } from '@langchain/core/messages';
import { TextExtractor } from '../streaming/text-extractor';
import { DeltaAccumulator } from '../streaming/delta-accumulator';
import { ToolEventExtractor } from '../streaming/tool-event-extractor';

export class DefaultGraphDriver implements GraphDriver {
constructor(private readonly graph: CompiledGraph) {}

async run(input: RunInput): Promise<RunResult> {
const { history, threadKey, generatedFromIndex, useCheckpointer } = input;
const startedAt = Date.now();
const configurable = useCheckpointer ? { thread_id: threadKey, chatId: threadKey } : { chatId: threadKey };

    const result = await this.graph.invoke({ messages: history }, { configurable });
    const rawMessages = Array.isArray(result.messages) ? result.messages : [];
    const transcript = rawMessages.filter((m): m is BaseMessage => isBaseMessage(m));
    return { transcript, generatedFromIndex, elapsedMs: Date.now() - startedAt };
}

async *stream(input: RunInput): AsyncGenerator<AgentStreamEvent | { kind: 'internal'; messages?: BaseMessage[] }> {
const { history, threadKey, useCheckpointer } = input;
const text = new TextExtractor();
const delta = new DeltaAccumulator();
const tools = new ToolEventExtractor();

    const stream = await this.graph.stream(
      { messages: history },
      useCheckpointer
        ? { configurable: { thread_id: threadKey, chatId: threadKey }, streamMode: ['messages', 'values'] }
        : { configurable: { chatId: threadKey }, streamMode: ['messages', 'values'] },
    );

    let fallbackIndex = 0;
    const resolveKey = (msg: AIMessage): string => (typeof msg.id === 'string' && msg.id.length ? msg.id : `ai-${fallbackIndex++}`);

    for await (const entry of stream as AsyncIterable<unknown>) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') continue;
      const [mode, payload] = entry;

      if (mode === 'messages' && Array.isArray(payload)) {
        for (const m of payload) {
          if (!isAIMessage(m)) continue;
          const key = resolveKey(m);
          const next = text.extract(m.content);
          const d = delta.computeDelta(key, next);
          if (d.length) yield { type: 'delta', text: d };
          for (const e of tools.extract(m)) yield e;
        }
      } else if (mode === 'values' && payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const messages = (payload as any).messages;
        if (Array.isArray(messages)) {
          const transcript = messages.filter((m: unknown) => isBaseMessage(m)) as BaseMessage[];
          yield { kind: 'internal', messages: transcript };
        }
      }
    }
}
}
2.2 Temporary orchestration

OrchestratorService.handleEvent/streamEvent use GraphDriver, but still keep memory writes, history build, response building inside OrchestratorService.
Acceptance:
All tests pass; no behavior change.
Step 3 – Extract storage and assembly
3.1 Add ConversationStore

File: src/orchestrator/conversation/conversation-store.ts
Wrap MemoryService interactions for user writes and window retrieval.
import { Injectable } from '@nestjs/common';
import { MemoryService, type MemoryMessage } from '../../memory/memory.service';
import { InputNormalizer } from '../input-normalizer.service';

@Injectable()
export class ConversationStore {
constructor(private readonly memory: MemoryService, private readonly normalizer: InputNormalizer) {}

async appendUser(threadKey: string, event: { type: string; text?: string; voiceUrl?: string; payload?: Record<string, unknown>; idempotencyKey?: string; connectorId?: string; }): Promise<void> {
const content = this.normalizer.toText(event as any);
await this.memory.pushMessage(threadKey, { role: 'user', content, meta: this.normalizer.userMeta(event as any) });
}

async loadWindow(threadKey: string): Promise<MemoryMessage[]> {
return this.memory.getWindow(threadKey);
}
}
3.2 Add TranscriptAssembler

File: src/orchestrator/conversation/transcript-assembler.ts
Wrap HistoryBuilder and compute generatedFromIndex for non-checkpointer mode.
import { Injectable } from '@nestjs/common';
import type { BaseMessage } from '@langchain/core/messages';
import { HistoryBuilderService } from '../messages/history-builder.service';
import type { MemoryMessage } from '../../memory/memory.service';

@Injectable()
export class TranscriptAssembler {
constructor(private readonly history: HistoryBuilderService) {}

buildFromWindow(window: MemoryMessage[]): { transcript: BaseMessage[]; generatedFromIndex: number } {
const transcript = this.history.buildHistory(window);
return { transcript, generatedFromIndex: transcript.length };
}

buildFromUserOnly(userMessage: BaseMessage): { transcript: BaseMessage[]; generatedFromIndex: number } {
return { transcript: [userMessage], generatedFromIndex: 0 };
}
}
3.3 Wire Step 3 (temporary)

OrchestratorService now delegates user persistence and history construction to ConversationStore and TranscriptAssembler. Response building and graph invocation still live in OrchestratorService with GraphDriver from Step 2.
Acceptance:
Tests still pass.
Step 4 – Extract persistence and composition
4.1 Add TranscriptPersister

File: src/orchestrator/conversation/transcript-persister.ts
Wrap GeneratedMessagePersisterService.
import { Injectable } from '@nestjs/common';
import type { BaseMessage } from '@langchain/core/messages';
import { GeneratedMessagePersisterService } from '../messages/generated-message-persister.service';

@Injectable()
export class TranscriptPersister {
constructor(private readonly persister: GeneratedMessagePersisterService) {}

async persist(threadKey: string, messages: BaseMessage[], generatedFromIndex: number): Promise<void> {
const toPersist = messages.slice(generatedFromIndex);
await this.persister.persistGeneratedMessages(threadKey, toPersist);
}
}
4.2 Add ResponseComposer

File: src/orchestrator/conversation/response-composer.ts
Thin wrapper around ResponseBuilder to keep dependency hidden from orchestrator.
import { Injectable } from '@nestjs/common';
import type { BaseMessage } from '@langchain/core/messages';
import { ResponseBuilder } from '../response-builder.service';
import type { AgentResponseDto } from '../../transport/dto/agent-response.dto';

@Injectable()
export class ResponseComposer {
constructor(private readonly builder: ResponseBuilder) {}

compose(chatId: string, transcript: BaseMessage[], generatedFromIndex: number, elapsedMs?: number): AgentResponseDto {
return this.builder.build(chatId, transcript, generatedFromIndex, elapsedMs);
}
}
4.3 Wire Step 4

OrchestratorService now calls TranscriptPersister and ResponseComposer instead of direct services.
Acceptance:
Tests still pass.
Step 5 – Introduce ConversationOrchestrator façade
5.1 Add ConversationOrchestrator

File: src/orchestrator/conversation/conversation-orchestrator.ts
Responsibilities:
End-to-end non-stream and stream execution for non-command events.
Uses ConversationStore, TranscriptAssembler, GraphDriver, TranscriptPersister, ResponseComposer.
import { Injectable } from '@nestjs/common';
import { HumanMessage, type BaseMessage, isAIMessage } from '@langchain/core/messages';
import type { NormalizedEventDto } from '../../api/transport/dto/normalized-event.dto';
import { ConversationStore } from './conversation-store';
import { TranscriptAssembler } from './transcript-assembler';
import { TranscriptPersister } from './transcript-persister';
import { ResponseComposer } from './response-composer';
import type { AgentResponseDto } from '../../transport/dto/agent-response.dto';
import type { AgentStreamEvent } from '../../transport/dto/agent-stream-event.dto';
import { GraphDriver } from '../graph/graph-driver';

@Injectable()
export class ConversationOrchestrator {
constructor(
private readonly store: ConversationStore,
private readonly assembler: TranscriptAssembler,
private readonly persister: TranscriptPersister,
private readonly composer: ResponseComposer,
private readonly graph: GraphDriver,
) {}

async handle(threadKey: string, chatId: string, useCheckpointer: boolean, event: NormalizedEventDto): Promise<AgentResponseDto> {
const started = Date.now();
let transcript: BaseMessage[] = [];
let generatedFromIndex = 0;

    if (useCheckpointer) {
      transcript = [new HumanMessage(event.text ?? '[empty message]')];
      generatedFromIndex = 0;
    } else {
      await this.store.appendUser(threadKey, event as any);
      const window = await this.store.loadWindow(threadKey);
      const built = this.assembler.buildFromWindow(window);
      transcript = built.transcript;
      generatedFromIndex = built.generatedFromIndex;
    }

    const run = await this.graph.run({ history: transcript, threadKey, generatedFromIndex, useCheckpointer });
    if (!useCheckpointer) {
      await this.persister.persist(threadKey, run.transcript, run.generatedFromIndex);
    }
    return this.composer.compose(chatId, run.transcript, run.generatedFromIndex, Date.now() - started);
}

async *handleStream(threadKey: string, chatId: string, useCheckpointer: boolean, event: NormalizedEventDto): AsyncGenerator<AgentStreamEvent> {
const started = Date.now();

    let transcript: BaseMessage[] = [];
    let generatedFromIndex = 0;

    if (useCheckpointer) {
      transcript = [new HumanMessage(event.text ?? '[empty message]')];
      generatedFromIndex = 0;
    } else {
      await this.store.appendUser(threadKey, event as any);
      const window = await this.store.loadWindow(threadKey);
      const built = this.assembler.buildFromWindow(window);
      transcript = built.transcript;
      generatedFromIndex = built.generatedFromIndex;
    }

    let finalMessages: BaseMessage[] | undefined;
    for await (const chunk of this.graph.stream({ history: transcript, threadKey, generatedFromIndex, useCheckpointer })) {
      if ((chunk as any).kind === 'internal') {
        finalMessages = (chunk as any).messages as BaseMessage[];
      } else {
        yield chunk as AgentStreamEvent;
      }
    }

    const messages = finalMessages ?? transcript;
    if (!useCheckpointer) {
      await this.persister.persist(threadKey, messages, generatedFromIndex);
    }

    const response = this.composer.compose(chatId, messages, generatedFromIndex, Date.now() - started);
    yield { type: 'final', text: response.text, meta: response.meta };
}
}
5.2 Replace OrchestratorService internals with delegation

OrchestratorService:
Keep top-level spans, logging, runWithThreadContext(), command short-circuit.
For non-command: compute threadKey and useCheckpointer, then delegate to ConversationOrchestrator.handle or handleStream.
Minimal diff example:
// in orchestrator.service.ts
const useCheckpointer = this.configService.features.enableCheckpointer === true;
if (streaming) {
yield* this.conversationOrchestrator.handleStream(threadKey, event.chatId, useCheckpointer, event);
} else {
return await this.conversationOrchestrator.handle(threadKey, event.chatId, useCheckpointer, event);
}
Acceptance:
All tests pass; streaming behavior and non-stream responses match baselines.
Step 6 – DI wiring and cleanup

OrchestratorModule: provide new classes and bind GraphDriver to DefaultGraphDriver; keep existing providers for backward compatibility.
Files to update:
src/orchestrator/orchestrator.module.ts
src/orchestrator/orchestrator.service.ts (delegate only)
src/orchestrator/langgraph/graph.factory.ts unchanged
Example wiring:
// orchestrator.module.ts (excerpt)
import { DefaultGraphDriver } from './graph/default-graph-driver';
import { GraphDriver } from './graph/graph-driver';
import { ConversationStore } from './conversation/conversation-store';
import { TranscriptAssembler } from './conversation/transcript-assembler';
import { TranscriptPersister } from './conversation/transcript-persister';
import { ResponseComposer } from './conversation/response-composer';
import { ConversationOrchestrator } from './conversation/conversation-orchestrator';
import { GraphFactory } from './langgraph/graph.factory';

@Module({
imports: [CommonModule, LanggraphModule, MemoryModule, ToolsModule, MessagesModule],
providers: [
OrchestratorService,
ConversationStore,
TranscriptAssembler,
TranscriptPersister,
ResponseComposer,
ConversationOrchestrator,
{
provide: GraphDriver,
useFactory: (factory: GraphFactory) => new DefaultGraphDriver(factory.build()),
inject: [GraphFactory],
},
],
exports: [OrchestratorService],
})
export class OrchestratorModule {}
Remove duplicated utility methods from OrchestratorService that are now inside helpers.
Acceptance:
Build succeeds; all unit/integration tests pass.
Step 7 – Introduce CheckpointerStrategy interface (placeholder only)

File: src/orchestrator/graph/checkpointer-strategy.ts
Interface to be used by GraphFactory in Phase 2; do not change behavior now.
export interface CheckpointerStrategy {
isEnabled(): boolean;
// Future: getSaver(): SomeSaverType
}
Update GraphFactory to still behave as before but accept an optional injected strategy later (no behavior changes now).
Acceptance:
No change in behavior; this step is scaffolding for future.
6. Backward compatibility and risk mitigation

OrchestratorService public methods and controllers unchanged.
Step-by-step verification after each step with the baseline tests.
Keep old code paths until the step that replaces them; then remove dead code in the same commit.
7. Testing plan

Unit tests:
DeltaAccumulator: initial delta, incremental delta, overwrite scenario.
ToolEventExtractor: emits once per tool_call id; stringified args parsing.
TextExtractor: string content and structured content.
DefaultGraphDriver.stream: simulate stream iterator with messages/values tuples to validate delta/tool/internal capture.
Integration tests:
ConversationOrchestrator.handle (memory mode): appends user, builds history, invokes driver (mock), persists generated, composes response.
ConversationOrchestrator.handleStream: emits deltas, a tool hint, and final; persists generated in memory mode.
Regression tests:
/events and /events/stream match the Step 0 baselines.
8. Acceptance criteria for the whole phase

No external API or behavior changes.
All unit and integration tests pass.
Complexity reduced:
OrchestratorService lines of code reduced by at least 50%.
Cyclomatic complexity of streaming path moved into small, tested helpers.
9. File map (new)

src/orchestrator/streaming/text-extractor.ts
src/orchestrator/streaming/delta-accumulator.ts
src/orchestrator/streaming/tool-event-extractor.ts
src/orchestrator/graph/graph-driver.ts
src/orchestrator/graph/default-graph-driver.ts
src/orchestrator/graph/checkpointer-strategy.ts (placeholder)
src/orchestrator/conversation/conversation-store.ts
src/orchestrator/conversation/transcript-assembler.ts
src/orchestrator/conversation/transcript-persister.ts
src/orchestrator/conversation/response-composer.ts
src/orchestrator/conversation/conversation-orchestrator.ts
10. Operational notes

Logging/tracing: keep top-level span creation in OrchestratorService; downstream services remain lightweight. Add debug logs sparingly in new helpers to ease troubleshooting.
No change to ENV/config in this phase.
11. Future phases (do not implement now; reserve space)

Phase 2 – Code quality and performance improvements

Replace MemorySaver with a durable CheckpointerStrategy (Redis/DB).
Token-bucket rate limiting with Redis Lua for smoother throttling (optional).
Fine-tune LLM parameters via config; add runId/correlationId to response_metadata for better traceability.
Expand tests, add contract tests for tool router and reminders pipeline.
Phase 3 – Scheduling with BullMQ

Introduce NotificationsModule, SubscriptionsRepository, OutboundPort abstraction, and adapter /deliver endpoint.
BullMQ repeatable jobs with idempotency keys per subscription/day.
Command UX: /subscribe, /unsubscribe, /subscriptions.
Appendix A: Constants hygiene (optional within refactor)

Add a shared constant for graph configurable key used in tools:
// src/orchestrator/constants.ts
export const CONFIGURABLE_CHAT_ID = 'chatId';
Use CONFIGURABLE_CHAT_ID everywhere you currently hardcode 'chatId'.
Appendix B: Keep room for future DI

GraphFactory to accept an optional checkpointer strategy in its constructor later; for now it continues to read from AppConfigService as today.