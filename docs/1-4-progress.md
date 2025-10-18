# Implementation Summary — Stages 0 → 4

This document captures the incremental work completed across the four preparation stages, highlighting project structure, key additions, and representative code excerpts.

## Project Overview

```text
personal-ai-assistant/
├─ docs/
│  └─ stage-progress.md
├─ prd_docs/
│  ├─ 1_stage.md
│  ├─ global_refactor_plan.md
│  └─ roadmap_full.md
├─ services/
│  ├─ agent-server/
│  │  ├─ src/
│  │  │  ├─ api/
│  │  │  │  ├─ health/
│  │  │  │  │  ├─ health.controller.ts
│  │  │  │  │  └─ health.module.ts
│  │  │  │  ├─ reminders/
│  │  │  │  │  ├─ reminders.controller.ts
│  │  │  │  │  ├─ reminders.module.ts
│  │  │  │  │  ├─ reminders.service.ts
│  │  │  │  │  └─ reminders.types.ts
│  │  │  │  └─ transport/
│  │  │  │     ├─ dto/
│  │  │  │     │  └─ normalized-event.dto.ts
│  │  │  │     ├─ events.controller.ts
│  │  │  │     └─ guards/
│  │  │  │        └─ bearer.guard.ts
│  │  │  ├─ common/
│  │  │  │  ├─ common.module.ts
│  │  │  │  ├─ exception.filter.ts
│  │  │  │  ├─ idempotency.service.ts
│  │  │  │  ├─ keys.util.ts
│  │  │  │  ├─ logging.interceptor.ts
│  │  │  │  └─ types.ts
│  │  │  ├─ config/
│  │  │  │  ├─ config.defaults.ts
│  │  │  │  ├─ config.module.ts
│  │  │  │  ├─ config.service.ts
│  │  │  │  ├─ config.types.ts
│  │  │  │  ├─ config.validation.ts
│  │  │  │  └─ configuration.ts
│  │  │  ├─ memory/
│  │  │  │  ├─ memory.module.ts
│  │  │  │  ├─ memory.service.ts
│  │  │  │  └─ redis.provider.ts
│  │  │  ├─ orchestrator/
│  │  │  │  ├─ command-router.service.ts
│  │  │  │  ├─ input-normalizer.service.ts
│  │  │  │  ├─ langgraph/
│  │  │  │  │  ├─ graph.factory.ts
│  │  │  │  │  ├─ langgraph.module.ts
│  │  │  │  │  └─ nodes/
│  │  │  │  │     ├─ planner.node.ts
│  │  │  │  │     └─ tool-router.node.ts
│  │  │  │  ├─ messages/
│  │  │  │  │  ├─ generated-message-persister.service.ts
│  │  │  │  │  ├─ history-builder.service.ts
│  │  │  │  │  ├─ interfaces/
│  │  │  │  │  │  └─ message-serializer.ts
│  │  │  │  │  ├─ message-transformer.service.spec.ts
│  │  │  │  │  ├─ message-transformer.service.ts
│  │  │  │  │  ├─ tokens.ts
│  │  │  │  │  ├─ transformers/
│  │  │  │  │  │  ├─ assistant-message.hydrator.spec.ts
│  │  │  │  │  │  ├─ assistant-message.hydrator.ts
│  │  │  │  │  │  ├─ tool-message.hydrator.spec.ts
│  │  │  │  │  │  └─ tool-message.hydrator.ts
│  │  │  │  │  ├─ types/
│  │  │  │  │  │  └─ tool-invocation-meta.ts
│  │  │  │  │  └─ utils/
│  │  │  │  │     └─ message-structure.utils.ts
│  │  │  │  ├─ orchestrator.module.ts
│  │  │  │  ├─ orchestrator.service.ts
│  │  │  │  └─ response-builder.service.ts
│  │  │  ├─ transport/
│  │  │  │  ├─ dto/
│  │  │  │  │  ├─ agent-response.dto.ts
│  │  │  │  │  └─ message-received.dto.ts
│  │  │  │  └─ transport.module.ts
│  │  │  ├─ app.module.ts
│  │  │  └─ main.ts
│  │  ├─ package.json
│  │  └─ tsconfig.json
│  └─ telegram-adapter/
│     ├─ src/
│     │  ├─ agent-client.ts
│     │  ├─ config.ts
│     │  ├─ health.ts
│     │  ├─ index.ts
│     │  ├─ telegram-bridge.ts
│     │  └─ types.ts
│     └─ package.json
└─ AGENTS.md
```

---

## Stage 0 — Guardrails & Observability

- Introduced a feature-flag section to the configuration schema.
- Added helper utilities to build deterministic thread identifiers and extract idempotency keys.
- Extended the HTTP logging interceptor to propagate correlation, run, idempotency, and thread metadata.

```typescript
// services/agent-server/src/common/keys.util.ts
export const buildThreadKey = (connectorId: string, chatId: string): string =>
  `${connectorId}:${chatId}`;

export const pickIdempotencyKey = (body: unknown): string | undefined => {
  if (!isRecord(body)) {
    return undefined;
  }

  const key = toStringOrUndefined(body.idempotencyKey);
  if (key !== undefined) {
    return key;
  }

  if (!isRecord(body.payload)) {
    return undefined;
  }

  return toStringOrUndefined(body.payload.updateId);
};
```

---

## Stage 1 — Secure Transport Boundary

- Defined a transport-agnostic `NormalizedEventDto` and bearer guard.
- Created `EventsController` that fronts the orchestrator.
- Updated the Telegram adapter to include `connectorId` and `idempotencyKey` in every payload.

```typescript
// services/agent-server/src/api/transport/dto/normalized-event.dto.ts
export class NormalizedEventDto {
  @IsString()
  connectorId!: string;

  @IsString()
  chatId!: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsString()
  @IsIn(['text', 'voice', 'command', 'other'])
  type!: 'text' | 'voice' | 'command' | 'other';

  @IsOptional()
  @IsString()
  text?: string;

  @IsOptional()
  @IsString()
  voiceUrl?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}
```

```typescript
// services/telegram-adapter/src/telegram-bridge.ts
private buildBasePayload(ctx: Context): MessageReceivedPayload {
  const chatId = ctx.chat?.id ? String(ctx.chat.id) : 'unknown';
  const userId = ctx.from?.id ? String(ctx.from.id) : chatId;
  const idempotencyKey = String(ctx.update.update_id);

  return {
    connectorId: 'telegram',
    idempotencyKey,
    chatId,
    userId,
    payload: {
      messageId: ctx.message?.message_id ?? ctx.update.update_id,
      chatType: ctx.chat?.type,
      updateId: ctx.update.update_id,
    },
  };
}
```

---

## Stage 2 — Ingress Idempotency

- Implemented a Redis-backed `IdempotencyService` gated by `features.enableIdempotency`.
- Ensured duplicates short‑circuit in `EventsController` with cached responses and a safe fallback.

```typescript
// services/agent-server/src/common/idempotency.service.ts
@Injectable()
export class IdempotencyService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redisClient: RedisClient,
  ) {}

  async tryStart(threadKey: string, idempotencyKey: string): Promise<boolean> {
    const status = await this.redisClient.set(
      this.requestKey(threadKey, idempotencyKey),
      '1',
      { NX: true, EX: DEFAULT_TTL_SECONDS },
    );
    return status === 'OK';
  }

  async getResponse(threadKey: string, idempotencyKey: string): Promise<unknown> {
    const raw = await this.redisClient.get(this.responseKey(threadKey, idempotencyKey));
    if (raw === null) {
      return undefined;
    }
    try {
      const parsed = parseJson(raw);
      if (isCachedEnvelope(parsed)) {
        return parsed.payload;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
}
```

---

## Stage 3 — Orchestrator Purification

- Split responsibilities into `CommandRouter`, `InputNormalizer`, and `ResponseBuilder`.
- Updated `OrchestratorService` to accept `NormalizedEventDto` directly, delegating command handling, message normalization, and response shaping to the new services.

```typescript
// services/agent-server/src/orchestrator/orchestrator.service.ts
async handleEvent(event: NormalizedEventDto): Promise<AgentResponseDto> {
  if (event.type === 'command' && event.text) {
    return this.commandRouter.handle(event);
  }

  const threadKey = buildThreadKey(event.connectorId, event.chatId);
  const userContent = this.inputNormalizer.toText(event);

  await this.memoryService.pushMessage(threadKey, {
    role: 'user',
    content: userContent,
    meta: this.inputNormalizer.userMeta(event),
  });

  const window = await this.memoryService.getWindow(threadKey);
  const history = this.historyBuilder.buildHistory(window);

  const result = await this.graph.invoke(
    { messages: history },
    { configurable: { chatId: threadKey } },
  );

  const messages = (Array.isArray(result.messages) ? result.messages : []).filter(
    (message): message is BaseMessage => isBaseMessage(message),
  );

  await this.generatedMessagePersister.persistGeneratedMessages(threadKey, messages.slice(history.length));

  return this.responseBuilder.build(event.chatId, messages, history.length);
}
```

---

## Stage 4 — Thread-Keyed Memory

- Added helpers for memory window and handle key generation based on thread keys.
- Updated `MemoryService`, orchestrator components, and command routing to consistently use thread keys for Redis operations and graph configuration.

```typescript
// services/agent-server/src/memory/memory.service.ts
async getWindow(threadKey: string): Promise<MemoryMessage[]> {
  const key = this.windowKey(threadKey);
  const entries = await this.redisClient.lRange(key, 0, -1);
  if (!entries?.length) {
    return [];
  }

  return entries
    .map((item) => {
      try {
        return JSON.parse(item) as MemoryMessage;
      } catch (error) {
        const reason = error instanceof Error ? error.message : JSON.stringify(error);
        this.logger.warn(`Failed to parse memory message for thread ${threadKey}: ${reason}`);
        return null;
      }
    })
    .filter((item): item is MemoryMessage => item !== null);
}

async clear(threadKey: string): Promise<void> {
  const windowKey = this.windowKey(threadKey);
  await this.redisClient.del(windowKey);

  const handleKeys: string[] = [];
  const iterator = this.redisClient.scanIterator({
    MATCH: `${this.handleKey(threadKey, '*')}`,
    COUNT: 50,
  });

  for await (const handleKey of iterator) {
    handleKeys.push(typeof handleKey === 'string' ? handleKey : handleKey.toString());
  }

  if (handleKeys.length > 0) {
    await this.redisClient.del(handleKeys);
  }
}
```

---

## Verification

Each stage concluded with `pnpm lint`, `pnpm build`, and `pnpm test` within `services/agent-server`, ensuring the codebase remained healthy after the incremental changes.
