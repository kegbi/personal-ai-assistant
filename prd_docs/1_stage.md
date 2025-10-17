Below are product requirement documents (PRDs) for Stages 0–4. Each PRD includes scope, requirements, data contracts, config changes, security/logging requirements, and concrete code skeletons you can hand to an LLM for implementation.

Notes
- Keep each stage as an independent, safe PR you can roll back.
- We intentionally do not include CI/e2e items.
- Code samples assume the existing NestJS layout and your current TypeScript/Node versions.

------------------------------------------------------------
Stage 0 PRD — Project prep and guardrails
Objective
- Add feature flags.
- Introduce threadKey helper without changing persistence yet.
- Add correlationId/runId, idempotencyKey, and provisional threadKey propagation into logs.
- Keep behavior identical for users.

In scope
- New feature flags in config.
- Common helpers for threadKey and correlationId.
- Update LoggingInterceptor to include correlationId, idempotencyKey, and a provisional threadKey if present in request payload.
- No changes to Redis keys or orchestrator behavior yet.

Out of scope
- Memory namespacing change.
- Checkpointer, streaming, or API changes.

Config changes (server)
- Add a new config section features with three booleans.
- Add AGENT_AUTH_TOKEN placeholder (used in Stage 1 Guard).

Files to change or add
1) src/config/config.types.ts
- Add a FeaturesSection and extend AppConfig.

Code
```
export interface FeaturesSection {
  enableCheckpointer: boolean;
  enableStreaming: boolean;
  enableIdempotency: boolean;
}

export interface AppConfig {
  app: AppSection;
  redis: RedisSection;
  memory: MemorySection;
  ai: AiSection;
  monica: MonicaSection;
  features: FeaturesSection; // NEW
}
```

2) src/config/config.validation.ts
- Add booleans using z.coerce.boolean().

Code
```
import { z } from 'zod';
import { DEFAULT_LLM_MODEL, DEFAULT_REDIS_HOST } from './config.defaults';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).default(3000),
  REDIS_HOST: z.string().default(DEFAULT_REDIS_HOST),
  REDIS_PORT: z.coerce.number().int().default(6379),
  MEM_WINDOW_SIZE: z.coerce.number().int().min(1).default(15),
  HANDLE_TTL_SECONDS: z.coerce.number().int().min(0).default(7200),
  OPENAI_API_KEY: z.string().optional().default(''),
  LLM_MODEL: z.string().default(DEFAULT_LLM_MODEL),
  MONICA_API_URL: z.string().url().default('https://app.monicahq.com/api'),
  MONICA_API_TOKEN: z.string().min(1, 'MONICA_API_TOKEN is required'),
  MONICA_WEB_URL: z.string().url().default('https://app.monicahq.com'),

  // NEW
  ENABLE_CHECKPOINTER: z.coerce.boolean().default(false),
  ENABLE_STREAMING: z.coerce.boolean().default(false),
  ENABLE_IDEMPOTENCY: z.coerce.boolean().default(false),

  // Placeholder for Stage 1
  AGENT_AUTH_TOKEN: z.string().optional(),
});

export type EnvSchema = z.infer<typeof envSchema>;
```

3) src/config/configuration.ts
- Map parsed booleans to features.

Code
```
export default (): AppConfig => ({
  app: { port: parseNumber(process.env.PORT, 3000) },
  redis: {
    host: process.env.REDIS_HOST ?? DEFAULT_REDIS_HOST,
    port: parseNumber(process.env.REDIS_PORT, 6379),
  },
  memory: {
    windowSize: parseNumber(process.env.MEM_WINDOW_SIZE, 15),
    handleTtlSeconds: parseNumber(process.env.HANDLE_TTL_SECONDS, 7200),
  },
  ai: {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL,
  },
  monica: {
    url: process.env.MONICA_API_URL ?? 'https://app.monicahq.com/api',
    token: process.env.MONICA_API_TOKEN ?? '',
    websiteUrl: process.env.MONICA_WEB_URL ?? 'https://app.monicahq.com',
  },
  features: {
    enableCheckpointer:
      String(process.env.ENABLE_CHECKPOINTER ?? '').toLowerCase() === 'true',
    enableStreaming:
      String(process.env.ENABLE_STREAMING ?? '').toLowerCase() === 'true',
    enableIdempotency:
      String(process.env.ENABLE_IDEMPOTENCY ?? '').toLowerCase() === 'true',
  },
});
```

4) src/config/config.service.ts
- Add accessor for features.

Code
```
import { AiSection, AppConfig, AppSection, FeaturesSection, MemorySection, MonicaSection, RedisSection } from './config.types';

@Injectable()
export class AppConfigService {
  // ...
  get features(): FeaturesSection {
    return this.readSection('features', (v): v is FeaturesSection => {
      return !!v && typeof (v as any).enableCheckpointer === 'boolean';
    });
  }
}
```

5) src/common/keys.util.ts (NEW)
- Thread key and correlation id helpers.

Code
```
export const buildThreadKey = (connectorId: string, chatId: string): string =>
  `${connectorId}:${chatId}`;

export const pickIdempotencyKey = (body: any): string | undefined => {
  try {
    const key = body?.idempotencyKey ?? body?.payload?.updateId;
    return typeof key === 'string' || typeof key === 'number' ? String(key) : undefined;
  } catch {
    return undefined;
  }
}
```

6) src/common/logging.interceptor.ts (augment existing)
- Include correlationId (from header x-correlation-id or generated), idempotencyKey, and provisional threadKey in every line.

Code (replace existing LoggingInterceptor with):
```
import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { buildThreadKey, pickIdempotencyKey } from './keys.util';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Request & { correlationId?: string }>();
    const res = http.getResponse<Response>();

    const startedAt = Date.now();
    const { method, url } = req;

    // CorrelationId
    const corr = (req.headers['x-correlation-id'] as string) || randomUUID();
    req.correlationId = corr;
    res.setHeader('x-correlation-id', corr);

    // Provisional threadKey & idempotencyKey (best-effort)
    let idempotencyKey: string | undefined;
    let threadKey: string | undefined;
    try {
      const body: any = req.body ?? {};
      idempotencyKey = pickIdempotencyKey(body);
      const connectorId = body?.connectorId;
      const chatId = body?.chatId;
      if (typeof connectorId === 'string' && typeof chatId === 'string') {
        threadKey = buildThreadKey(connectorId, chatId);
      }
    } catch {}

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = Date.now() - startedAt;
          this.logger.log(
            `${method} ${url} ${duration}ms corr=${corr}${threadKey ? ` thread=${threadKey}` : ''}${idempotencyKey ? ` idem=${idempotencyKey}` : ''}`,
          );
        },
        error: (error: unknown) => {
          const duration = Date.now() - startedAt;
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `${method} ${url} failed ${duration}ms corr=${corr}${threadKey ? ` thread=${threadKey}` : ''}${idempotencyKey ? ` idem=${idempotencyKey}` : ''}: ${message}`,
          );
        },
      }),
    );
  }
}
```

Security and logging
- No behavior change; only logs get richer.
- No new external exposure.

Acceptance criteria
- Server boots with new features section visible via AppConfigService.
- Logs include correlationId; if the payload contains connectorId/chatId/idempotencyKey, logs include provisional threadKey and idem key.
- No memory key or API behavior changes.

Rollback
- Revert the added features section and LoggingInterceptor changes.

------------------------------------------------------------
Stage 1 PRD — Secure transport boundary (EventsController + token auth)
Objective
- Expose a single POST /events endpoint on the server.
- Protect it with a Bearer token.
- Accept a normalized, transport-agnostic DTO.
- Map to the current OrchestratorService (which still expects MessageReceivedDto) to minimize churn now.

In scope
- Add EventsController and BearerGuard.
- Add NormalizedEventDto (transport-agnostic).
- Adapter: send connectorId and idempotencyKey.

Out of scope
- Changing orchestrator signature (done in Stage 3).
- Idempotency enforcement (Stage 2).

Data contract (server)
NormalizedEventDto v1
- connectorId: string, required (e.g., "telegram")
- chatId: string, required
- userId: string, optional
- type: 'text' | 'voice' | 'command' | 'other', required
- text: string, optional
- voiceUrl: string, optional
- idempotencyKey: string, optional (Telegram: update.update_id)
- payload: Record<string, unknown>, optional

Files to add/change (server)
1) src/api/transport/dto/normalized-event.dto.ts (NEW)
```
import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';

export class NormalizedEventDto {
  @IsString() connectorId!: string; // 'telegram' | 'matrix' | 'web' etc.
  @IsString() chatId!: string;
  @IsOptional() @IsString() userId?: string;

  @IsString() @IsIn(['text', 'voice', 'command', 'other'])
  type!: 'text' | 'voice' | 'command' | 'other';

  @IsOptional() @IsString() text?: string;
  @IsOptional() @IsString() voiceUrl?: string;

  @IsOptional() @IsString() idempotencyKey?: string;

  @IsOptional() @IsObject() payload?: Record<string, unknown>;
}
```

2) src/api/transport/guards/bearer.guard.ts (NEW)
```
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class BearerGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const header = (req.headers?.authorization ?? '') as string;
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const expected = process.env.AGENT_AUTH_TOKEN ?? '';
    if (!expected) return true; // allow if not configured (dev)
    if (token && token === expected) return true;
    throw new UnauthorizedException('Invalid or missing token');
  }
}
```

3) src/api/transport/events.controller.ts (NEW)
- Map NormalizedEventDto to the current MessageReceivedDto to reuse OrchestratorService.handleEvent for now.

```
import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { OrchestratorService } from '../../orchestrator/orchestrator.service';
import { NormalizedEventDto } from './dto/normalized-event.dto';
import { BearerGuard } from './guards/bearer.guard';
import { AgentResponseDto } from '../../transport/dto/agent-response.dto'; // existing
import { MessageReceivedDto } from '../../transport/dto/message-received.dto'; // existing

@UseGuards(BearerGuard)
@Controller('events')
export class EventsController {
  constructor(private readonly orchestrator: OrchestratorService) {}

  @Post()
  async post(@Body() dto: NormalizedEventDto): Promise<AgentResponseDto> {
    const legacy: MessageReceivedDto = {
      chatId: dto.chatId,
      userId: dto.userId ?? dto.chatId,
      text: dto.text,
      voiceUrl: dto.voiceUrl,
      isCommand: dto.type === 'command',
      command: dto.type === 'command' ? (dto.text ?? '').split(' ')[0] : undefined,
      payload: {
        ...(dto.payload ?? {}),
        connectorId: dto.connectorId,
        eventType: dto.type,
        idempotencyKey: dto.idempotencyKey,
      },
    };
    return this.orchestrator.handleEvent(legacy);
  }
}
```

4) src/transport/transport.module.ts (CREATE or UPDATE)
- Ensure this module exports the new controller. If you already have TransportModule, add the controller and guard provider.

```
import { Module } from '@nestjs/common';
import { EventsController } from '../api/transport/events.controller';
import { BearerGuard } from '../api/transport/guards/bearer.guard';

@Module({
  controllers: [EventsController],
  providers: [BearerGuard],
})
export class TransportModule {}
```

Adapter changes (telegram-adapter)
- Send connectorId and idempotencyKey with every message. Authorization header already supported by AgentClient.

Files to change
1) src/telegram-bridge.ts (buildBasePayload and forwardToAgent callers)
- Add connectorId and idempotencyKey.

```
private buildBasePayload(ctx: Context): MessageReceivedPayload {
  const chatId = ctx.chat?.id ? String(ctx.chat.id) : 'unknown';
  const userId = ctx.from?.id ? String(ctx.from.id) : chatId;

  const idempotencyKey = String(ctx.update.update_id);

  return {
    connectorId: 'telegram', // NEW (update MessageReceivedPayload to allow this field)
    idempotencyKey,          // NEW
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

2) src/types.ts (adapter)
- Extend MessageReceivedPayload to carry connectorId and idempotencyKey to server.

```
export interface MessageReceivedPayload {
  connectorId?: string; // NEW
  idempotencyKey?: string; // NEW
  chatId: string;
  userId: string;
  text?: string;
  voiceUrl?: string;
  isCommand?: boolean;
  command?: string;
  payload?: Record<string, unknown>;
}
```

Security
- Require AGENT_AUTH_TOKEN in production. In development, guard allows missing token (see code) but prefer setting the token.

Acceptance criteria
- POST /events with a valid Bearer token reaches orchestrator and returns a normal AgentResponseDto.
- Unauthorized without/invalid token.
- Adapter includes connectorId and idempotencyKey in payload.

Rollback
- Remove EventsController and BearerGuard; adapter can be pointed at any legacy endpoint if you had one.

------------------------------------------------------------
Stage 2 PRD — Idempotency at ingress
Objective
- Ensure repeated deliveries of the same event (e.g., Telegram update retries) do not cause duplicate processing or duplicate writes.
- Cache and return the first response for the same idempotencyKey.

In scope
- Redis-backed DedupeService.
- EventsController checks idempotency before calling Orchestrator.
- Cache first AgentResponseDto for duplicates.
- Feature flag features.enableIdempotency gate.

Out of scope
- Changing orchestrator’s signature.
- Streaming.

Key behavior
- If features.enableIdempotency is false: no change.
- If true:
    - On first-seen (threadKey + idempotencyKey), process and store response for TTL.
    - On duplicates:
        - Try return cached response; if not yet cached (rare race), return a minimal 202 or a generic 200 with “[duplicate in progress]”. For Telegram, prefer returning the cached response; if missing, return the same minimal response text to avoid user confusion. Given Telegram updates are sequential, the race is unlikely.

Files to add/change (server)
1) src/common/idempotency.service.ts (NEW)
```
import { Inject, Injectable } from '@nestjs/common';
import { REDIS_CLIENT, RedisClient } from '../memory/redis.provider';

interface CachedResponse {
  payload: unknown;
  storedAt: number;
}

@Injectable()
export class IdempotencyService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {}

  private key(threadKey: string, idemKey: string): string {
    return `idemp:${threadKey}:${idemKey}`;
  }
  private respKey(threadKey: string, idemKey: string): string {
    return `idempresp:${threadKey}:${idemKey}`;
  }

  // Returns true if this is the first time we see the key (caller should process)
  async tryStart(threadKey: string, idemKey: string, ttlSec = 600): Promise<boolean> {
    const status = await this.redis.set(this.key(threadKey, idemKey), '1', { NX: true, EX: ttlSec });
    return status === 'OK';
  }

  async storeResponse(threadKey: string, idemKey: string, response: unknown, ttlSec = 600): Promise<void> {
    const payload: CachedResponse = { payload: response, storedAt: Date.now() };
    await this.redis.set(this.respKey(threadKey, idemKey), JSON.stringify(payload), { EX: ttlSec });
  }

  async getResponse(threadKey: string, idemKey: string): Promise<unknown | null> {
    const raw = await this.redis.get(this.respKey(threadKey, idemKey));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as CachedResponse;
      return parsed.payload;
    } catch {
      return null;
    }
  }
}
```

2) src/api/transport/events.controller.ts (augment)
- Use IdempotencyService and feature flag; compute threadKey via buildThreadKey.

```
import { AppConfigService } from '../../config/config.service';
import { IdempotencyService } from '../../common/idempotency.service';
import { buildThreadKey } from '../../common/keys.util';

// ... constructor: inject AppConfigService and IdempotencyService

constructor(
  private readonly orchestrator: OrchestratorService,
  private readonly config: AppConfigService,
  private readonly idem: IdempotencyService,
) {}

@Post()
async post(@Body() dto: NormalizedEventDto): Promise<AgentResponseDto> {
  const threadKey = buildThreadKey(dto.connectorId, dto.chatId);
  const idemKey = dto.idempotencyKey;

  const useIdem = this.config.features.enableIdempotency && !!idemKey;

  if (useIdem) {
    const cached = await this.idem.getResponse(threadKey, idemKey!);
    if (cached) return cached as AgentResponseDto;

    const first = await this.idem.tryStart(threadKey, idemKey!);
    if (!first) {
      const again = await this.idem.getResponse(threadKey, idemKey!);
      if (again) return again as AgentResponseDto;
      // Fallback minimal response to avoid duplicate sends
      return { chatId: dto.chatId, text: 'Processing duplicate, please wait…' };
    }
  }

  const legacy: MessageReceivedDto = {
    chatId: dto.chatId,
    userId: dto.userId ?? dto.chatId,
    text: dto.text,
    voiceUrl: dto.voiceUrl,
    isCommand: dto.type === 'command',
    command: dto.type === 'command' ? (dto.text ?? '').split(' ')[0] : undefined,
    payload: {
      ...(dto.payload ?? {}),
      connectorId: dto.connectorId,
      eventType: dto.type,
      idempotencyKey: dto.idempotencyKey,
    },
  };

  const response = await this.orchestrator.handleEvent(legacy);

  if (useIdem) {
    await this.idem.storeResponse(threadKey, idemKey!, response);
  }

  return response;
}
```

3) src/common/common.module.ts (register IdempotencyService)
```
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { GlobalExceptionFilter } from './exception.filter';
import { LoggingInterceptor } from './logging.interceptor';
import { IdempotencyService } from './idempotency.service';

@Module({
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    IdempotencyService,
  ],
  exports: [IdempotencyService],
})
export class CommonModule {}
```

Acceptance criteria
- With ENABLE_IDEMPOTENCY=true and idempotencyKey provided, repeated POST /events returns the first response.
- Without idempotencyKey or with feature disabled, behavior unchanged.

Rollback
- Remove IdempotencyService usage in controller (one diff block).

------------------------------------------------------------
Stage 3 PRD — Orchestrator split (purify responsibilities)
Objective
- Decouple Orchestrator from transport details and shrink responsibilities.
- Introduce CommandRouter, ResponseBuilder, and InputNormalizer.
- Orchestrator now consumes a normalized DTO (NormalizedEventDto) directly.
- Keep LangGraph invocation and HistoryBuilder as-is for now.

In scope
- New services (CommandRouter, InputNormalizer, ResponseBuilder).
- Change OrchestratorService.handleEvent signature to NormalizedEventDto.
- Update EventsController to call new signature (no more legacy mapping).
- Keep current GraphFactory, HistoryBuilder, and GeneratedMessagePersister.

Out of scope
- Checkpointer, streaming.
- Memory key changes (Stage 4).

Data contract
- Reuse NormalizedEventDto from Stage 1 as the orchestrator input.

Files to add/change (server)
1) src/orchestrator/command-router.service.ts (NEW)
```
import { Injectable } from '@nestjs/common';
import { MemoryService } from '../memory/memory.service';
import { AgentResponseDto } from '../transport/dto/agent-response.dto';
import { NormalizedEventDto } from '../api/transport/dto/normalized-event.dto';

@Injectable()
export class CommandRouter {
  constructor(private readonly memory: MemoryService) {}

  async handle(evt: NormalizedEventDto): Promise<AgentResponseDto> {
    const cmd = (evt.text ?? '').split(' ')[0].toLowerCase();
    switch (cmd) {
      case '/start':
        await this.memory.clear(evt.chatId);
        return {
          chatId: evt.chatId,
          text: 'Hello! I am your personal AI assistant. Ask me to remember contacts, update details, or just chat.',
        };
      case '/clear':
        await this.memory.clear(evt.chatId);
        return { chatId: evt.chatId, text: 'Cleared recent conversation memory for this chat.' };
      case '/help':
        return {
          chatId: evt.chatId,
          text: 'Try:\n• “Remember that Alice is my designer friend.”\n• “Set Alice’s birthday to 1991-05-14.”\n• “Who is Alice?”',
        };
      default:
        return {
          chatId: evt.chatId,
          text: `Unknown command ${cmd}. Available: /start, /help, /clear.`,
        };
    }
  }
}
```

2) src/orchestrator/input-normalizer.service.ts (NEW)
```
import { Injectable } from '@nestjs/common';
import { NormalizedEventDto } from '../api/transport/dto/normalized-event.dto';

@Injectable()
export class InputNormalizer {
  toText(evt: NormalizedEventDto): string {
    if (evt.type === 'text' && evt.text && evt.text.trim().length > 0) {
      return evt.text.trim();
    }
    if (evt.type === 'voice' && evt.voiceUrl) {
      return `[voice message received: ${evt.voiceUrl}]`;
    }
    if (evt.type === 'command' && evt.text) {
      return evt.text.trim();
    }
    return '[empty message]';
  }

  userMeta(evt: NormalizedEventDto): Record<string, unknown> | undefined {
    const meta: Record<string, unknown> = {};
    if (evt.voiceUrl) meta.voiceUrl = evt.voiceUrl;
    if (evt.payload) meta.payload = evt.payload;
    if (evt.idempotencyKey) meta.idempotencyKey = evt.idempotencyKey;
    if (evt.connectorId) meta.connectorId = evt.connectorId;
    return Object.keys(meta).length ? meta : undefined;
  }
}
```

3) src/orchestrator/response-builder.service.ts (NEW)
```
import { Inject, Injectable } from '@nestjs/common';
import { AIMessage, BaseMessage, isAIMessage, isBaseMessage } from '@langchain/core/messages';
import { AgentResponseDto } from '../transport/dto/agent-response.dto';
import { MESSAGE_SERIALIZER } from './messages/tokens';
import type { MessageSerializer } from './messages/interfaces/message-serializer';
import type { ToolInvocationMeta } from './messages/types/tool-invocation-meta';

@Injectable()
export class ResponseBuilder {
  constructor(@Inject(MESSAGE_SERIALIZER) private readonly serializer: MessageSerializer) {}

  build(chatId: string, transcript: BaseMessage[], generatedFromIndex: number): AgentResponseDto {
    const generated = transcript.slice(generatedFromIndex);
    const final = this.pickFinalAssistantMessage(transcript);
    if (!final) {
      return { chatId, text: 'I am not sure how to respond to that just yet.' };
    }
    const toolMeta: ToolInvocationMeta | null = this.serializer.extractToolMeta(generated);
    return {
      chatId,
      text: this.serializer.extractMessageContent(final),
      meta: toolMeta ? { tool: toolMeta.name, args: toolMeta.args } : undefined,
    };
  }

  private pickFinalAssistantMessage(messages: BaseMessage[]): AIMessage | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const candidate = messages[i];
      if (isAIMessage(candidate)) return candidate;
    }
    return null;
  }
}
```

4) src/orchestrator/orchestrator.service.ts (REPLACE handleEvent signature and simplify)
```
import { Inject, Injectable, Logger } from '@nestjs/common';
import { BaseMessage, isBaseMessage } from '@langchain/core/messages';
import { NormalizedEventDto } from '../api/transport/dto/normalized-event.dto';
import { AgentResponseDto } from '../transport/dto/agent-response.dto';
import { MemoryService } from '../memory/memory.service';
import { GraphFactory, type CompiledGraph } from './langgraph/graph.factory';
import { HistoryBuilderService } from './messages/history-builder.service';
import { GeneratedMessagePersisterService } from './messages/generated-message-persister.service';
import { MESSAGE_SERIALIZER } from './messages/tokens';
import type { MessageSerializer } from './messages/interfaces/message-serializer';
import { CommandRouter } from './command-router.service';
import { InputNormalizer } from './input-normalizer.service';
import { ResponseBuilder } from './response-builder.service';

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly graph: CompiledGraph;

  constructor(
    private readonly memoryService: MemoryService,
    private readonly graphFactory: GraphFactory,
    private readonly historyBuilder: HistoryBuilderService,
    private readonly generatedMessagePersister: GeneratedMessagePersisterService,
    private readonly commandRouter: CommandRouter,
    private readonly inputNormalizer: InputNormalizer,
    private readonly responseBuilder: ResponseBuilder,
    @Inject(MESSAGE_SERIALIZER) private readonly messageTransformer: MessageSerializer,
  ) {
    this.graph = this.graphFactory.build();
  }

  async handleEvent(evt: NormalizedEventDto): Promise<AgentResponseDto> {
    // Commands short-circuit
    if (evt.type === 'command' && evt.text) {
      return this.commandRouter.handle(evt);
    }

    // Persist user message
    const text = this.inputNormalizer.toText(evt);
    await this.memoryService.pushMessage(evt.chatId, {
      role: 'user',
      content: text,
      meta: this.inputNormalizer.userMeta(evt),
    });

    // Build history (temporary until checkpointer)
    const window = await this.memoryService.getWindow(evt.chatId);
    const history = this.historyBuilder.buildHistory(window);
    const initialLength = history.length;

    // Run graph
    const result = await this.graph.invoke(
      { messages: history },
      { configurable: { chatId: evt.chatId } }, // will become threadKey in Stage 4
    );

    const rawMessages = Array.isArray(result.messages) ? result.messages : [];
    const messages = rawMessages.filter((m): m is BaseMessage => isBaseMessage(m));
    const generatedIndex = initialLength;

    await this.generatedMessagePersister.persistGeneratedMessages(evt.chatId, messages.slice(generatedIndex));

    return this.responseBuilder.build(evt.chatId, messages, generatedIndex);
  }
}
```

5) src/orchestrator/orchestrator.module.ts (register new services)
```
import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { ToolsModule } from '../tools/tools.module';
import { LanggraphModule } from './langgraph/langgraph.module';
import { MessagesModule } from './messages/messages.module';
import { OrchestratorService } from './orchestrator.service';
import { CommandRouter } from './command-router.service';
import { InputNormalizer } from './input-normalizer.service';
import { ResponseBuilder } from './response-builder.service';

@Module({
  imports: [LanggraphModule, MemoryModule, ToolsModule, MessagesModule],
  providers: [OrchestratorService, CommandRouter, InputNormalizer, ResponseBuilder],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}
```

6) src/api/transport/events.controller.ts (switch to new signature)
```
@Post()
async post(@Body() dto: NormalizedEventDto): Promise<AgentResponseDto> {
  // Idempotency remains here (Stage 2 logic unchanged)
  // ...
  return this.orchestrator.handleEvent(dto);
}
```

Acceptance criteria
- Orchestrator no longer accesses Telegram-specific shapes; it accepts NormalizedEventDto.
- Commands routed by CommandRouter.
- Non-commands: user content normalized, history built, graph invoked, messages persisted, response built.
- Behavior for end users unchanged.

Rollback
- Revert Orchestrator signature and controller call; retain new services (they are additive).

------------------------------------------------------------
Stage 4 PRD — Memory namespacing (threadKey) and safe migration
Objective
- Eliminate cross-connector collisions by namespacing memory and handles by threadKey = connectorId:chatId.
- Update orchestrator and graph invocation to use threadKey for all memory operations.
- Provide a one-off migration script to rename existing Redis keys.

In scope
- MemoryService key scheme change.
- Orchestrator and EventsController: compute threadKey and use for memory and for configurable.chatId passed to graph (tools will see threadKey via config).
- Migration script to rename Redis keys from memory:window:<chatId> to memory:window:<threadKey> and handles likewise.

Out of scope
- Checkpointer adoption (later).
- Tool code changes (they already read configurable.chatId; we’ll pass threadKey there).

Key behavior
- All memory windows and handles are keyed by threadKey.
- Tools requiring chatId in RunnableConfig will now receive threadKey (backwards-compatible with current usage since it’s treated as opaque key in MemoryService).

Files to change/add (server)
1) src/common/keys.util.ts (add helper to compute keys for MemoryService)
```
export const windowKeyFor = (threadKey: string): string => `memory:window:${threadKey}`;
export const handleKeyFor = (threadKey: string, key: string): string => `memory:handle:${threadKey}:${key}`;
```

2) src/memory/memory.service.ts (switch to threadKey; keep compatibility shim)
- Replace chatId params with threadKey.
- Provide deprecated overloads for chatId to minimize code churn in other places if any remain.

Code (replace methods; illustrative diffs):
```
@Injectable()
export class MemoryService {
  // ...

  private windowKey(threadKey: string): string {
    return `memory:window:${threadKey}`;
  }

  private handleKey(threadKey: string, key: string): string {
    return `memory:handle:${threadKey}:${key}`;
  }

  // NEW: Threaded API
  async getWindow(threadKey: string): Promise<MemoryMessage[]> {
    const key = this.windowKey(threadKey);
    const entries = await this.redisClient.lRange(key, 0, -1);
    // ... (unchanged)
  }

  async pushMessage(threadKey: string, message: MemoryMessage): Promise<void> {
    const key = this.windowKey(threadKey);
    const serialized = JSON.stringify(message);
    const windowSize = this.config.memory.windowSize;
    await this.redisClient.multi().rPush(key, serialized).lTrim(key, -windowSize, -1).exec();
  }

  async getHandle(threadKey: string, key: string): Promise<unknown> {
    const handleKey = this.handleKey(threadKey, key);
    const raw = await this.redisClient.get(handleKey);
    // ... (unchanged)
  }

  async setHandle(threadKey: string, key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const handleKey = this.handleKey(threadKey, key);
    // ... (unchanged)
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
      handleKeys.push(typeof handleKey === 'string' ? handleKey : handleKey instanceof Buffer ? handleKey.toString() : String(handleKey));
    }
    if (handleKeys.length > 0) await this.redisClient.del(handleKeys);
  }

  // OPTIONAL: Back-compat shims (deprecate soon). They map chatId -> threadKey('telegram', chatId) only if connector unknown.
  /** @deprecated pass threadKey instead */
  async getWindowByChatId(chatId: string): Promise<MemoryMessage[]> {
    return this.getWindow(chatId);
  }
  /** @deprecated pass threadKey instead */
  async pushMessageForChat(chatId: string, message: MemoryMessage): Promise<void> {
    return this.pushMessage(chatId, message);
  }
  // ... same for handles and clear
}
```

3) src/orchestrator/orchestrator.service.ts (use threadKey everywhere)
```
import { buildThreadKey } from '../common/keys.util';

async handleEvent(evt: NormalizedEventDto): Promise<AgentResponseDto> {
  if (evt.type === 'command' && evt.text) {
    return this.commandRouter.handle(evt);
  }
  const threadKey = buildThreadKey(evt.connectorId, evt.chatId);

  const text = this.inputNormalizer.toText(evt);
  await this.memoryService.pushMessage(threadKey, {
    role: 'user',
    content: text,
    meta: this.inputNormalizer.userMeta(evt),
  });

  const window = await this.memoryService.getWindow(threadKey);
  const history = this.historyBuilder.buildHistory(window);
  const initialLength = history.length;

  const result = await this.graph.invoke(
    { messages: history },
    { configurable: { chatId: threadKey } }, // important: pass threadKey so tools use same key for handles
  );

  const rawMessages = Array.isArray(result.messages) ? result.messages : [];
  const messages = rawMessages.filter(isBaseMessage);
  await this.generatedMessagePersister.persistGeneratedMessages(threadKey, messages.slice(initialLength));

  return this.responseBuilder.build(evt.chatId, messages, initialLength);
}
```

4) src/api/transport/events.controller.ts (compute threadKey for idempotency)
- Already done in Stage 2. No change except ensure buildThreadKey uses dto.connectorId.

5) src/orchestrator/langgraph/nodes/tool-router.node.ts (no code change needed)
- It calls extractChatId(config) reading configurable.chatId; we now pass threadKey as that value. MemoryService will use threadKey, so tools that call memoryService.* will be consistent.

Migration script (one-off, run manually)
- Goal: rename existing keys memory:window:<chatId> → memory:window:<connectorId>:<chatId> and same for handles. For initial rollout, connectorId='telegram' for all existing keys.

Create scripts/redis-migrate-thread-keys.ts
```
import { createClient } from 'redis';

async function run() {
  const host = process.env.REDIS_HOST ?? 'localhost';
  const port = Number(process.env.REDIS_PORT ?? '6379');
  const connector = process.env.MIGRATION_CONNECTOR_ID ?? 'telegram';

  const client = createClient({ socket: { host, port }});
  await client.connect();

  let renamed = 0;

  // Windows
  for await (const key of client.scanIterator({ MATCH: 'memory:window:*', COUNT: 100 })) {
    const k = String(key);
    const parts = k.split(':'); // ['memory','window','<chatId or threadKey>']
    if (parts.length === 3 && !parts[2].includes(':')) {
      const chatId = parts[2];
      const newKey = `memory:window:${connector}:${chatId}`;
      await client.rename(k, newKey).catch(async (e) => {
        if (String(e).includes('no such key')) return;
        // if target exists, skip
      });
      renamed++;
    }
  }

  // Handles
  for await (const key of client.scanIterator({ MATCH: 'memory:handle:*', COUNT: 100 })) {
    const k = String(key);
    // memory:handle:<chatId or threadKey>:<handleName>
    const segments = k.split(':');
    if (segments.length >= 4 && !segments[2].includes(':')) {
      const chatId = segments[2];
      const rest = segments.slice(3).join(':');
      const newKey = `memory:handle:${connector}:${chatId}:${rest}`;
      await client.rename(k, newKey).catch(async (e) => {
        if (String(e).includes('no such key')) return;
      });
      renamed++;
    }
  }

  console.log(`Renamed keys: ${renamed}`);
  await client.quit();
}

run().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});
```

Run
- Export REDIS_HOST/REDIS_PORT if non-default.
- Optionally set MIGRATION_CONNECTOR_ID=telegram.
- node scripts/redis-migrate-thread-keys.js (ts-node if TypeScript).

Acceptance criteria
- New conversations read/write Redis under memory:window:<connectorId>:<chatId>.
- Tools that use MemoryService handles resolve under the same prefix (because threadKey is passed via configurable.chatId).
- Existing data can be migrated with the script; non-migrated keys won’t be read anymore (acceptable if you don’t need historical state).

Rollback
- Revert MemoryService changes and orchestrator threadKey usage.
- If migration ran, you can rename back by inverting the script or accept new keys.

Security/logging
- No new network exposure.
- Logs will now include the accurate threadKey from EventsController payload (already shown since Stage 0).

Non-functional notes
- Memory cardinality grows with connectors (as intended).
- Redis key sizes grow minimally; no performance impact expected.

------------------------------------------------------------
Summary of developer tasks per stage

Stage 0
- Add features section to config, update service accessors.
- Add keys.util.ts and augment LoggingInterceptor to log correlationId, threadKey, idempotencyKey.

Stage 1
- Create NormalizedEventDto, BearerGuard, EventsController.
- Extend adapter payload with connectorId and idempotencyKey.

Stage 2
- Implement IdempotencyService and wire into EventsController behind feature flag.
- Store and replay first response for duplicates.

Stage 3
- Introduce CommandRouter, InputNormalizer, ResponseBuilder.
- Change OrchestratorService to accept NormalizedEventDto and use new helpers.
- Update EventsController to call the new signature.

Stage 4
- Change MemoryService to use threadKey.
- Update OrchestratorService to compute and use threadKey for memory and configurable.chatId.
- Provide migration script for Redis key rename.