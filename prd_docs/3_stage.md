------------------------------------------------------------
Stage 8 PRD — Observability: structured logs and lightweight tracing

Objective
- Standardize on structured JSON logs with run/correlation/thread metadata.
- Add operation timing for orchestrator runs and tool execution; include elapsedMs in AgentResponseDto.meta.
- Optional minimal OpenTelemetry (OTEL) traces behind a flag (no vendor lock; default console exporter).

In scope
- JSON logger for HTTP and application logs.
- Timing instrumentation around orchestrator.handleEvent, PlannerNode.execute, ToolRouterNode.execute.
- Optional OTEL init and spans for request → orchestrator → graph → tools.
- AsyncLocal request context to propagate correlationId/threadKey to non-HTTP code.

Out of scope
- CI/e2e, metrics backends, dashboards.

Config additions
- LOG_FORMAT: 'json' | 'pretty' (default 'pretty')
- ENABLE_OTEL_TRACING: boolean (default false)
- OTEL_EXPORTER: 'console' | 'otlp' (default 'console')
- OTEL_OTLP_ENDPOINT: string (optional; used when OTEL_EXPORTER='otlp')

Files to add/change (server)

1) common/request-context.ts (NEW) — AsyncLocalStorage
import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestCtx {
  correlationId: string;
  threadKey?: string;
  idempotencyKey?: string;
}

@Injectable()
export class RequestContext {
  private readonly als = new AsyncLocalStorage<RequestCtx>();
  run<T>(ctx: RequestCtx, fn: () => T): T { return this.als.run(ctx, fn); }
  get(): RequestCtx | undefined { return this.als.getStore(); }
}

2) common/json-logger.service.ts (NEW) — Structured logger implementing Nest LoggerService
import { ConsoleLogger, Injectable } from '@nestjs/common';
import { RequestContext } from './request-context';

@Injectable()
export class JsonLogger extends ConsoleLogger {
  constructor(private readonly rc: RequestContext) { super(); }
  private payload(level: string, message: any, meta?: Record<string, unknown>) {
    const ctx = this.rc.get();
    const base = { level, ts: new Date().toISOString(), msg: String(message) };
    return JSON.stringify({ ...base, ...meta, correlationId: ctx?.correlationId, threadKey: ctx?.threadKey, idempotencyKey: ctx?.idempotencyKey });
  }
  log(message: any, context?: string) { process.stdout.write(this.payload('info', message, { context }) + '\n'); }
  warn(message: any, context?: string) { process.stdout.write(this.payload('warn', message, { context }) + '\n'); }
  error(message: any, trace?: string, context?: string) { process.stderr.write(this.payload('error', message, { context, trace }) + '\n'); }
  debug(message: any, context?: string) { process.stdout.write(this.payload('debug', message, { context }) + '\n'); }
  verbose(message: any, context?: string) { process.stdout.write(this.payload('verbose', message, { context }) + '\n'); }
}

3) common/logging.interceptor.ts (UPDATE) — Wrap request in RequestContext and include timing
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { RequestContext } from './request-context';
import { buildThreadKey, pickIdempotencyKey } from './keys.util';
import { AppConfigService } from '../config/config.service';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private readonly rc: RequestContext, private readonly cfg: AppConfigService) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const startedAt = Date.now();
    const correlationId = (req.headers['x-correlation-id'] as string) || randomUUID();

    const body: any = req.body ?? {};
    const connectorId = typeof body?.connectorId === 'string' ? body.connectorId : undefined;
    const chatId = typeof body?.chatId === 'string' ? body.chatId : undefined;
    const threadKey = connectorId && chatId ? buildThreadKey(connectorId, chatId) : undefined;
    const idempotencyKey = pickIdempotencyKey(body);

    res.setHeader('x-correlation-id', correlationId);

    return this.rc.run({ correlationId, threadKey, idempotencyKey }, () =>
      next.handle().pipe(
        tap({
          next: () => {
            const ms = Date.now() - startedAt;
            if (this.cfg.features.enableStreaming) {
              // leave as-is; streaming responses may not have a standard size
            }
            // JsonLogger prints structured line; nothing else needed
          },
          error: () => { /* JsonLogger will log through GlobalExceptionFilter */ },
        }),
      ),
    );
  }
}

4) main.ts (UPDATE) — Swap Nest logger when LOG_FORMAT=json
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const cfg = app.get(AppConfigService);
  if ((process.env.LOG_FORMAT ?? 'pretty').toLowerCase() === 'json') {
    const rc = app.get(RequestContext);
    const jsonLogger = new JsonLogger(rc);
    app.useLogger(jsonLogger);
  }
  // existing pipes...
  await app.listen(cfg.app.port);
}

5) common/common.module.ts (REGISTER RequestContext, JsonLogger)
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { GlobalExceptionFilter } from './exception.filter';
import { LoggingInterceptor } from './logging.interceptor';
import { RequestContext } from './request-context';
import { JsonLogger } from './json-logger.service';

@Module({
  providers: [
    RequestContext,
    JsonLogger,
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
  exports: [RequestContext, JsonLogger],
})
export class CommonModule {}

6) Orchestrator timing and meta.elapsedMs (UPDATE orchestrator.service.ts)
- Wrap run with timing and include elapsedMs in meta.

const t0 = Date.now();
// ... existing branch (checkpointer vs legacy)
const response = this.responseBuilder.build(evt.chatId, messages, offset);
const elapsed = Date.now() - t0;
response.meta = { ...(response.meta ?? {}), elapsedMs: elapsed };
this.logger.debug(`Orchestrator run completed in ${elapsed}ms`);
return response;

7) Optional minimal OTEL init (NEW) — observability/otel.ts
- Only if ENABLE_OTEL_TRACING=true; you can call initOtel() in main.ts.

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

export async function initOtel() {
  const exporter = (process.env.OTEL_EXPORTER ?? 'console') === 'otlp'
    ? new OTLPTraceExporter({ url: process.env.OTEL_OTLP_ENDPOINT })
    : new ConsoleSpanExporter();

  const sdk = new NodeSDK({
    traceExporter: exporter,
    instrumentations: [getNodeAutoInstrumentations()],
  });
  await sdk.start();
  return () => sdk.shutdown();
}

8) Optional spans (light-touch) — Orchestrator and Tool nodes
- Add simple spans if OTEL is enabled (guarded by try/catch and dynamic import of @opentelemetry/api to avoid hard dep).

const otel = safeGetOtel(); // helper to lazy-import api and no-op if missing
const span = otel?.startSpan?.('orchestrator.handleEvent', { attributes: { threadKey } });
// ... finally: span?.end();

Acceptance criteria
- When LOG_FORMAT=json, all logs are JSON with correlationId/threadKey/idempotencyKey.
- Orchestrator logs duration and meta.elapsedMs is returned to adapter.
- With ENABLE_OTEL_TRACING=true, spans are emitted to console or OTLP endpoint; system still works if OTEL libs are missing (no-op).

Rollback
- Set LOG_FORMAT=pretty and ENABLE_OTEL_TRACING=false; keep code.

------------------------------------------------------------
Stage 9 PRD — Streaming and better UX in adapter

Objective
- Optional streaming path: incremental model output to adapter for improved UX.
- Maintain compatibility: if streaming disabled, current POST /events remains unchanged.
- Adapter: show typing indicator; in streaming mode, send a placeholder message and edit it as chunks arrive with a minimum edit interval.

In scope
- Server: add POST /events/stream returning NDJSON chunks.
- Use graph.stream when features.enableStreaming=true; otherwise, fall back to invoke and send a single final chunk.
- Adapter: AgentClient.sendMessageStream() reading NDJSON; TelegramBridge streaming send/edit loop with rate-limited edits.
- Feature flags: server-side features.enableStreaming and adapter-side STREAMING_MODE.

Adapter config additions
- STREAMING_MODE: 'disabled' | 'edit' (default 'disabled')
- STREAMING_MIN_EDIT_INTERVAL_MS: number (default 400)

Server data format (NDJSON)
- Each line is a JSON object terminated by '\n'.
- Shapes:
    - { type: 'start' }
    - { type: 'delta', text: '...' }            // appendable text chunk
    - { type: 'tool', name: '...', args: {...}} // optional hints
    - { type: 'final', text: '...', meta?: {...}}
    - { type: 'error', message: '...' }

Files to add/change

Server

1) api/transport/events-stream.controller.ts (NEW)
   import { Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
   import type { Response } from 'express';
   import { NormalizedEventDto } from './dto/normalized-event.dto';
   import { BearerGuard } from './guards/bearer.guard';
   import { AppConfigService } from '../../config/config.service';
   import { GraphFactory } from '../../orchestrator/langgraph/graph.factory';
   import { InputNormalizer } from '../../orchestrator/input-normalizer.service';
   import { buildThreadKey } from '../../common/keys.util';
   import { HumanMessage, isBaseMessage, isToolMessage, isAIMessage } from '@langchain/core/messages';

@UseGuards(BearerGuard)
@Controller('events')
export class EventsStreamController {
constructor(
private readonly cfg: AppConfigService,
private readonly graphFactory: GraphFactory,
private readonly input: InputNormalizer,
) {}

@Post('stream')
async stream(@Body() evt: NormalizedEventDto, @Res() res: Response): Promise<void> {
res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
res.setHeader('Transfer-Encoding', 'chunked');
const write = (obj: unknown) => res.write(JSON.stringify(obj) + '\n');

    write({ type: 'start' });

    try {
      const graph = this.graphFactory.build();
      const threadKey = buildThreadKey(evt.connectorId, evt.chatId);
      const text = this.input.toText(evt);

      // If streaming disabled, do one-shot invoke and emit final
      if (!this.cfg.features.enableStreaming) {
        const result = await graph.invoke(
          { messages: [new HumanMessage(text)] },
          { configurable: { thread_id: threadKey, chatId: threadKey } },
        );
        const messages = (Array.isArray(result.messages) ? result.messages : []).filter(isBaseMessage);
        const finalText = this.collectAssistantText(messages);
        write({ type: 'final', text: finalText, meta: { via: 'invoke' } });
        res.end();
        return;
      }

      // Streaming via LangGraph
      // stream_mode: 'messages' is typically supported; adjust if your version differs
      const stream = await (graph as any).stream(
        { messages: [new HumanMessage(text)] },
        { configurable: { thread_id: threadKey, chatId: threadKey }, stream_mode: 'messages' },
      );

      for await (const event of stream) {
        // Heuristic: when we receive an AIMessage delta, emit {delta}
        // Depending on your installed API, event may contain a 'messages' or granular updates.
        const chunk = this.extractDelta(event);
        if (chunk?.length) write({ type: 'delta', text: chunk });

        const tool = this.extractToolHint(event);
        if (tool) write({ type: 'tool', ...tool });
      }

      // After stream ends, do a final summarization if needed (optional)
      // You may keep track of the concatenated text; for simplicity, send empty final with via flag.
      write({ type: 'final', text: '', meta: { via: 'stream' } });
      res.end();
    } catch (err) {
      write({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      res.end();
    }
}

private collectAssistantText(messages: any[]): string {
for (let i = messages.length - 1; i >= 0; i--) {
if (isAIMessage(messages[i])) {
const content = messages[i].content;
return typeof content === 'string' ? content : JSON.stringify(content);
}
}
return '';
}

private extractDelta(event: any): string | null {
// Implement based on your @langchain/langgraph version. Placeholder:
// If event contains { messages: [{ type: 'ai', content: '...' }] } use that.
try {
const msgs = event?.messages;
if (Array.isArray(msgs)) {
const ai = msgs.find((m: any) => m?._getType?.() === 'ai' || m?.type === 'ai');
if (!ai) return null;
return typeof ai.content === 'string' ? ai.content : null;
}
const text = event?.delta ?? event?.chunk ?? null;
return typeof text === 'string' ? text : null;
} catch { return null; }
}

private extractToolHint(event: any): { name: string; args: Record<string, unknown> } | null {
try {
const msgs = event?.messages;
if (!Array.isArray(msgs)) return null;
const toolMsg = msgs.find((m: any) => isToolMessage(m));
if (!toolMsg) return null;
return { name: toolMsg.name ?? 'tool_call', args: (toolMsg.additional_kwargs ?? {}) as Record<string, unknown> };
} catch { return null; }
}
}

2) api/transport/transport.module.ts (REGISTER stream controller)
   import { Module } from '@nestjs/common';
   import { EventsController } from './events.controller';
   import { EventsStreamController } from './events-stream.controller';
   import { BearerGuard } from './guards/bearer.guard';

@Module({
controllers: [EventsController, EventsStreamController],
providers: [BearerGuard],
})
export class TransportModule {}

Adapter

3) src/agent-client.ts (ADD sendMessageStream with NDJSON)
   export class AgentClient {
   // ...
   private readonly eventsUrl: string;
   private readonly streamUrl: string;

constructor(baseUrl: string, options: AgentClientOptions) {
this.eventsUrl = new URL('/events', baseUrl).toString();
this.streamUrl = new URL('/events/stream', baseUrl).toString();
// ...
}

async *sendMessageStream(payload: MessageReceivedPayload): AsyncGenerator<{ type: string; text?: string; meta?: any }> {
const headers: Record<string, string> = { 'content-type': 'application/json' };
if (this.authToken) headers.authorization = `Bearer ${this.authToken}`;
const resp = await fetch(this.streamUrl, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(this.timeoutMs) });
if (!resp.ok || !resp.body) throw new Error(`Agent stream failed: ${resp.status} ${resp.statusText}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try { yield JSON.parse(line); } catch { /* ignore parse errors */ }
      }
    }
}
}

4) src/telegram-bridge.ts (STREAMING MODE 'edit')
- Add config options; when STREAMING_MODE='edit', use sendMessageStream; else fallback to sendMessage.

class TelegramBridge {
// ...
private readonly minEditInterval: number;

constructor(config: AdapterConfig, agentClient: AgentClient) {
// ...
this.minEditInterval = Math.max(200, config.streamingMinEditIntervalMs ?? 400);
}

private async deliverAgentResponseStreaming(ctx: Context, payload: MessageReceivedPayload): Promise<void> {
// typing indicator
const chatId = ctx.chat?.id ? String(ctx.chat.id) : undefined;
if (!chatId) return;

    let messageId: number | undefined;
    let buffer = '';
    let lastEdit = 0;

    try {
      for await (const evt of this.agentClient.sendMessageStream(payload)) {
        if (evt.type === 'start') {
          await ctx.api.sendChatAction(chatId, 'typing').catch(() => {});
          continue;
        }
        if (evt.type === 'delta') {
          buffer += evt.text ?? '';
          const now = Date.now();
          if (!messageId) {
            // create placeholder
            const sent = await ctx.api.sendMessage(chatId, buffer || '…', { reply_to_message_id: ctx.message?.message_id }).catch(() => null);
            messageId = sent?.message_id;
            lastEdit = now;
          } else if (now - lastEdit >= this.minEditInterval) {
            await ctx.api.editMessageText(chatId, messageId, buffer).catch(() => {});
            lastEdit = now;
          }
          continue;
        }
        if (evt.type === 'final') {
          if (!messageId) {
            await ctx.api.sendMessage(chatId, evt.text ?? buffer, { reply_to_message_id: ctx.message?.message_id });
          } else {
            await ctx.api.editMessageText(chatId, messageId, evt.text ?? buffer).catch(() => {});
          }
          return;
        }
        if (evt.type === 'error') {
          await this.safeReply(ctx, 'Sorry, something went wrong while streaming the response.');
          return;
        }
      }
    } catch (e) {
      await this.safeReply(ctx, 'Streaming failed. Please try again.');
    }
}

private async forwardToAgent(ctx: Context, payload: MessageReceivedPayload): Promise<void> {
this.metrics.processedUpdates += 1;
this.metrics.lastUpdateAt = new Date();

    const streaming = (this.config.streamingMode ?? 'disabled') === 'edit';
    if (streaming) {
      await this.deliverAgentResponseStreaming(ctx, payload);
      return;
    }

    // fallback to non-streaming
    let response: AgentResponsePayload;
    try {
      response = await this.agentClient.sendMessage(payload);
      this.metrics.lastAgentInteractionAt = new Date();
      this.metrics.lastAgentError = undefined;
    } catch (error) {
      // same as before...
      await this.safeReply(ctx, 'Sorry, something went wrong while talking to the assistant.');
      return;
    }
    await this.deliverAgentResponse(ctx, response);
}
}

5) adapter config.ts (ADD)
   export interface AdapterConfig {
   // ...
   streamingMode?: 'disabled' | 'edit';
   streamingMinEditIntervalMs?: number;
   }

const configSchema = z.object({
// ...
streamingMode: z.enum(['disabled', 'edit']).default('disabled'),
streamingMinEditIntervalMs: z.number().int().positive().default(400),
// ...
});

export const loadConfig = (): AdapterConfig => {
const parsed = configSchema.parse({
// ...
streamingMode: (process.env.STREAMING_MODE ?? 'disabled').toLowerCase(),
streamingMinEditIntervalMs: process.env.STREAMING_MIN_EDIT_INTERVAL_MS ? Number(process.env.STREAMING_MIN_EDIT_INTERVAL_MS) : undefined,
});
return { /* map fields incl. streaming props */ };
};

Acceptance criteria
- With server features.enableStreaming=false, /events/stream still returns a single final chunk (invoke path) and adapter edits once.
- With features.enableStreaming=true and STREAMING_MODE='edit', Telegram users see progressive updates with rate-limited edits; final text is correct.
- If streaming errors, adapter falls back gracefully with a simple error message.

Rollback
- Set STREAMING_MODE=disabled or stop calling /events/stream; use existing /events.

------------------------------------------------------------
Stage 10 PRD — Security and ops hardening

Objective
- Strengthen runtime posture: Redis TLS/password, API rate limits per thread, container health checks, leaner Docker images.
- Keep defaults friendly for local dev.

In scope
- Redis auth/TLS support.
- RateLimitGuard on /events and /events/stream (per threadKey).
- Docker HEALTHCHECK for server and adapter; install only prod deps in runtime images.

Out of scope
- mTLS between services, WAF, or complex auth flows.

Config additions
- REDIS_PASSWORD: string (optional)
- REDIS_TLS: boolean (default false)
- REDIS_TLS_REJECT_UNAUTHORIZED: boolean (default true)
- RATE_LIMIT_PER_MIN: number (default 60)
- RATE_LIMIT_BURST: number (default 10) — optional soft burst allowance

Files to add/change (server)

1) memory/redis.provider.ts (TLS/PASSWORD)
   import { Logger, Provider } from '@nestjs/common';
   import { createClient } from 'redis';
   import { AppConfigService } from '../config/config.service';

export const RedisProvider: Provider = {
provide: REDIS_CLIENT,
inject: [AppConfigService],
useFactory: async (config: AppConfigService): Promise<RedisClient> => {
const logger = new Logger('RedisClient');
const useTls = (process.env.REDIS_TLS ?? 'false').toLowerCase() === 'true';
const rejectUnauthorized = (process.env.REDIS_TLS_REJECT_UNAUTHORIZED ?? 'true').toLowerCase() === 'true';
const client = createClient({
password: process.env.REDIS_PASSWORD || undefined,
socket: {
host: config.redis.host,
port: config.redis.port,
tls: useTls ? { rejectUnauthorized } as any : undefined,
},
});
client.on('error', (e) => logger.error(`Redis error: ${e instanceof Error ? e.message : String(e)}`));
await client.connect();
return client;
},
};

2) common/rate-limit.guard.ts (NEW) — simple fixed window per threadKey
   import { CanActivate, ExecutionContext, Injectable, TooManyRequestsException } from '@nestjs/common';
   import { Inject } from '@nestjs/common';
   import { REDIS_CLIENT, RedisClient } from '../memory/redis.provider';
   import { buildThreadKey } from './keys.util';

@Injectable()
export class RateLimitGuard implements CanActivate {
constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {}
private key(threadKey: string): string {
const minute = Math.floor(Date.now() / 60000);
return `rl:${threadKey}:${minute}`;
}

async canActivate(ctx: ExecutionContext): Promise<boolean> {
const req = ctx.switchToHttp().getRequest<any>();
const body = req.body ?? {};
const connectorId = body?.connectorId;
const chatId = body?.chatId;
if (!connectorId || !chatId) return true; // ignore when not provided

    const thread = buildThreadKey(connectorId, chatId);
    const max = Number(process.env.RATE_LIMIT_PER_MIN ?? 60);
    const burst = Number(process.env.RATE_LIMIT_BURST ?? 10);

    const key = this.key(thread);
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, 65);
    }
    if (count > max + burst) {
      throw new TooManyRequestsException('Rate limit exceeded for this chat. Please slow down.');
    }
    return true;
}
}

3) api/transport/transport.module.ts (APPLY guard at controller level)
- Use @UseGuards(RateLimitGuard, BearerGuard) on EventsController and EventsStreamController, or apply globally via APP_GUARD if you prefer.

import { Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsStreamController } from './events-stream.controller';
import { BearerGuard } from './guards/bearer.guard';
import { RateLimitGuard } from '../../common/rate-limit.guard';

@Module({
controllers: [EventsController, EventsStreamController],
providers: [BearerGuard, RateLimitGuard],
})
export class TransportModule {}

4) Dockerfiles — lean runtime images + healthchecks

Server Dockerfile (services/agent-server/Dockerfile)
# ---------- build stage ----------
FROM node:22-alpine AS build
WORKDIR /app
RUN npm i -g pnpm
COPY package.json pnpm-lock.yaml* .npmrc* ./
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN pnpm run build

# ---------- run stage ----------
FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
RUN npm i -g pnpm
COPY package.json pnpm-lock.yaml* .npmrc* ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist ./dist
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:3000/health || exit 1
RUN addgroup -S app && adduser -S app -G app
USER app
CMD ["node", "dist/main.js"]

Adapter Dockerfile (services/telegram-adapter/Dockerfile)
# ---------- build stage ----------
FROM node:22-alpine AS build
WORKDIR /app
RUN npm i -g pnpm
COPY package.json pnpm-lock.yaml* .npmrc* ./
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json ./
COPY src ./src
RUN pnpm run build

# ---------- run stage ----------
FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
RUN npm i -g pnpm
COPY package.json pnpm-lock.yaml* .npmrc* ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist ./dist
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:8081/health || exit 1
RUN addgroup -S app && adduser -S app -G app
USER app
CMD ["node", "dist/index.js"]

Acceptance criteria
- Redis can connect with password and TLS when configured; defaults work locally without TLS/password.
- Excessive requests per threadKey are throttled with 429 (configurable limits).
- Containers report healthy via HEALTHCHECK; runtime images only include prod deps.

Rollback
- Unset REDIS_TLS/REDIS_PASSWORD; remove RateLimitGuard from controllers; HEALTHCHECK is harmless if kept.

------------------------------------------------------------
Quick implementation checklist

Stage 8
- Add RequestContext (ALS) and JsonLogger; wire into CommonModule and main.ts when LOG_FORMAT=json.
- Update LoggingInterceptor to populate RequestContext and keep correlation/thread/idempotency metadata.
- Add orchestrator elapsedMs in response meta and debug log.
- Optional: add OTEL init and light spans (flagged by ENABLE_OTEL_TRACING).

Stage 9
- Server: add /events/stream (NDJSON). Use graph.stream when features.enableStreaming=true, else single-shot invoke.
- Adapter: add AgentClient.sendMessageStream and TelegramBridge flow to send placeholder and edit with rate-limited updates.
- Adapter config: STREAMING_MODE and STREAMING_MIN_EDIT_INTERVAL_MS.

Stage 10
- Redis provider: support password and TLS.
- Add RateLimitGuard per threadKey; apply to /events and /events/stream.
- Update both Dockerfiles to prod-only installs and HEALTHCHECKs.