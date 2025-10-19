import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  BaseMessage,
  HumanMessage,
  isAIMessage,
} from '@langchain/core/messages';
import { NormalizedEventDto } from '../api/transport/dto/normalized-event.dto';
import { buildThreadKey } from '../common/keys.util';
import { MemoryService } from '../memory/memory.service';
import { AgentResponseDto } from '../transport/dto/agent-response.dto';
import type { AgentStreamEvent } from '../transport/dto/agent-stream-event.dto';
import { CommandRouter } from './command-router.service';
import { GraphFactory } from './langgraph/graph.factory';
import { GeneratedMessagePersisterService } from './messages/generated-message-persister.service';
import type { MessageSerializer } from './messages/interfaces/message-serializer';
import { HistoryBuilderService } from './messages/history-builder.service';
import { MESSAGE_SERIALIZER } from './messages/tokens';
import { InputNormalizer } from './input-normalizer.service';
import { ResponseBuilder } from './response-builder.service';
import { AppConfigService } from '../config/config.service';
import { RequestContext } from '../common/request-context';
import type {
  GraphDriver,
  GraphInternalChunk,
  GraphStreamChunk,
} from './graph/graph-driver';
import { DefaultGraphDriver } from './graph/default-graph-driver';

/**
 * Coordinates the orchestration pipeline, connecting memory, LangGraph, and response shaping.
 */
@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly graphDriver: GraphDriver;
  private readonly tracer = trace.getTracer('agent.orchestrator');

  constructor(
    private readonly memoryService: MemoryService,
    private readonly graphFactory: GraphFactory,
    private readonly historyBuilder: HistoryBuilderService,
    private readonly generatedMessagePersister: GeneratedMessagePersisterService,
    private readonly commandRouter: CommandRouter,
    private readonly inputNormalizer: InputNormalizer,
    private readonly responseBuilder: ResponseBuilder,
    private readonly configService: AppConfigService,
    private readonly requestContext: RequestContext,
    @Inject(MESSAGE_SERIALIZER)
    private readonly messageSerializer: MessageSerializer,
  ) {
    this.graphDriver = new DefaultGraphDriver(this.graphFactory.build());
  }

  /**
   * Routes inbound events through the orchestration stack to produce an assistant reply.
   *
   * @param event Normalized transport event emitted by the ingress controller.
   * @returns Response ready to be delivered back to the transport adapter.
   */
  async handleEvent(event: NormalizedEventDto): Promise<AgentResponseDto> {
    const threadKey = buildThreadKey(event.connectorId, event.chatId);
    return this.runWithThreadContext(threadKey, async () => {
      const startedAt = Date.now();
      const span = this.tracer.startSpan('orchestrator.handleEvent', {
        attributes: {
          'app.thread_key': threadKey,
          'app.connector_id': event.connectorId,
          'app.chat_id': event.chatId,
          'app.event_type': event.type,
        },
      });

      try {
        if (event.type === 'command' && event.text) {
          const response = await this.commandRouter.handle(event);
          const elapsedMs = Date.now() - startedAt;
          this.logDebug('Command routed', {
            threadKey,
            elapsedMs,
          });
          span.setAttribute('app.mode', 'command');
          span.setAttribute('app.elapsed_ms', elapsedMs);
          span.setStatus({ code: SpanStatusCode.OK });
          return response;
        }

        const userContent = this.inputNormalizer.toText(event);
        const useCheckpointer =
          this.configService.features.enableCheckpointer === true;

        let history: BaseMessage[] = [];
        let generatedFromIndex = 0;
        let windowLength = 0;

        if (useCheckpointer) {
          history = [new HumanMessage(userContent)];
          windowLength = history.length;
          this.logDebug('Invoking LangGraph', {
            threadKey,
            mode: 'checkpointer',
          });
        } else {
          await this.memoryService.pushMessage(threadKey, {
            role: 'user',
            content: userContent,
            meta: this.inputNormalizer.userMeta(event),
          });

          const window = await this.memoryService.getWindow(threadKey);
          windowLength = window.length;
          history = this.historyBuilder.buildHistory(window);
          generatedFromIndex = history.length;

          this.logDebug('Invoking LangGraph', {
            threadKey,
            mode: 'memory',
            historyLength: history.length,
            windowLength,
          });
        }

        const runResult = await this.graphDriver.run({
          history,
          threadKey,
          generatedFromIndex,
          useCheckpointer,
        });

        const messages = runResult.transcript;
        const elapsedMs = runResult.elapsedMs;
        const generatedIndex = runResult.generatedFromIndex;

        if (!messages.some((message) => isAIMessage(message))) {
          const modeLabel = useCheckpointer ? 'checkpointer' : 'memory';
          this.logger.warn(
            `LangGraph completed without an assistant response (mode=${modeLabel} threadKey=${threadKey})`,
          );
        }

        if (useCheckpointer) {
          this.logDebug('LangGraph completed', {
            threadKey,
            mode: 'checkpointer',
            messageCount: messages.length,
            elapsedMs,
            messages: this.describeMessages(messages),
          });

          span.setAttribute('app.mode', 'checkpointer');
          span.setAttribute('app.elapsed_ms', elapsedMs);
          span.setAttribute('app.message_count', messages.length);
          span.setStatus({ code: SpanStatusCode.OK });

          return this.responseBuilder.build(
            event.chatId,
            messages,
            generatedIndex,
            elapsedMs,
          );
        }

        const generatedMessages = messages.slice(generatedIndex);

        this.logDebug('LangGraph completed', {
          threadKey,
          mode: 'memory',
          generatedCount: generatedMessages.length,
          elapsedMs,
          messages: this.describeMessages(generatedMessages),
        });

        await this.generatedMessagePersister.persistGeneratedMessages(
          threadKey,
          generatedMessages,
        );

        span.setAttribute('app.mode', 'memory');
        span.setAttribute('app.elapsed_ms', elapsedMs);
        span.setAttribute('app.generated_count', generatedMessages.length);
        span.setAttribute('app.history_length', history.length);
        span.setAttribute('app.window_length', windowLength);
        span.setStatus({ code: SpanStatusCode.OK });

        return this.responseBuilder.build(
          event.chatId,
          messages,
          generatedIndex,
          elapsedMs,
        );
      } catch (error) {
        span.recordException(
          error instanceof Error ? error : this.describeError(error),
        );
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: this.describeError(error),
        });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async *streamEvent(
    event: NormalizedEventDto,
  ): AsyncGenerator<AgentStreamEvent> {
    const startedAt = Date.now();

    if (event.type === 'command' && event.text) {
      const response = await this.commandRouter.handle(event);
      const elapsedMs = Date.now() - startedAt;
      const meta =
        response.meta !== undefined
          ? {
              ...response.meta,
              elapsedMs: response.meta.elapsedMs ?? elapsedMs,
            }
          : { elapsedMs };
      yield {
        type: 'final',
        text: response.text,
        meta,
      };
      return;
    }

    const threadKey = buildThreadKey(event.connectorId, event.chatId);
    const span = this.tracer.startSpan('orchestrator.streamEvent', {
      attributes: {
        'app.thread_key': threadKey,
        'app.connector_id': event.connectorId,
        'app.chat_id': event.chatId,
        'app.event_type': event.type,
      },
    });

    try {
      const useCheckpointer =
        this.configService.features.enableCheckpointer === true;
      const userContent = this.inputNormalizer.toText(event);

      let history: BaseMessage[] = [];
      let generatedIndex = 0;
      let windowLength = 0;

      if (useCheckpointer) {
        history = [new HumanMessage(userContent)];
        windowLength = history.length;
        this.logDebug('Streaming LangGraph', {
          threadKey,
          mode: 'checkpointer',
          historyLength: history.length,
        });
      } else {
        await this.memoryService.pushMessage(threadKey, {
          role: 'user',
          content: userContent,
          meta: this.inputNormalizer.userMeta(event),
        });

        const window = await this.memoryService.getWindow(threadKey);
        windowLength = window.length;
        history = this.historyBuilder.buildHistory(window);
        generatedIndex = history.length;

        this.logDebug('Streaming LangGraph', {
          threadKey,
          mode: 'memory',
          historyLength: history.length,
          windowLength,
        });
      }

      const streamIterator = this.graphDriver.stream({
        history,
        threadKey,
        generatedFromIndex: generatedIndex,
        useCheckpointer,
      });

      let finalMessages: BaseMessage[] = history;
      for await (const chunk of streamIterator) {
        if (this.isInternalChunk(chunk)) {
          if (Array.isArray(chunk.messages)) {
            finalMessages = chunk.messages;
          }
          continue;
        }

        yield chunk;
      }

      if (!finalMessages.length) {
        finalMessages = history;
      }

      const elapsedMs = Date.now() - startedAt;
      const modeLabel = useCheckpointer ? 'checkpointer' : 'memory';

      if (!useCheckpointer) {
        const generatedMessages = finalMessages.slice(generatedIndex);
        await this.generatedMessagePersister.persistGeneratedMessages(
          threadKey,
          generatedMessages,
        );
        span.setAttribute('app.generated_count', generatedMessages.length);
        span.setAttribute('app.history_length', history.length);
      } else {
        span.setAttribute('app.generated_count', finalMessages.length);
        span.setAttribute('app.history_length', windowLength);
      }

      this.logDebug('LangGraph streaming completed', {
        threadKey,
        mode: modeLabel,
        elapsedMs,
        messageCount: finalMessages.length,
        messages: this.describeMessages(finalMessages),
      });

      span.setAttribute('app.mode', modeLabel);
      span.setAttribute('app.elapsed_ms', elapsedMs);
      span.setAttribute('app.message_count', finalMessages.length);
      span.setStatus({ code: SpanStatusCode.OK });

      const response = this.responseBuilder.build(
        event.chatId,
        finalMessages,
        useCheckpointer ? 0 : generatedIndex,
        elapsedMs,
      );

      yield {
        type: 'final',
        text: response.text,
        meta: response.meta,
      };
    } catch (error) {
      span.recordException(
        error instanceof Error ? error : this.describeError(error),
      );
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: this.describeError(error),
      });
      throw error;
    } finally {
      span.end();
    }
  }

  private isInternalChunk(
    chunk: GraphStreamChunk,
  ): chunk is GraphInternalChunk {
    return 'kind' in chunk && chunk.kind === 'internal';
  }

  private runWithThreadContext<T>(
    threadKey: string,
    handler: () => Promise<T>,
  ): Promise<T> {
    const current = this.requestContext.get();
    const correlationId = current?.correlationId ?? randomUUID();

    return this.requestContext.run(
      {
        correlationId,
        threadKey,
        idempotencyKey: current?.idempotencyKey,
      },
      handler,
    );
  }

  private logDebug(message: string, meta: Record<string, unknown>): void {
    if (this.configService.logging.format === 'json') {
      this.logger.debug({ message, ...meta });
      return;
    }

    this.logger.debug(`${message} ${this.stringifyMeta(meta)}`);
  }

  private stringifyMeta(meta: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(meta)) {
      parts.push(`${key}=${this.describeMetaValue(value)}`);
    }
    return parts.join(' ');
  }

  private describeMetaValue(value: unknown): string {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? String(value) : 'NaN';
    }

    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }

    if (typeof value === 'bigint') {
      return value.toString();
    }

    if (typeof value === 'symbol') {
      return value.description ?? value.toString();
    }

    if (typeof value === 'function') {
      return '[function]';
    }

    if (Array.isArray(value)) {
      try {
        return JSON.stringify(value);
      } catch {
        return '[array]';
      }
    }

    if (value === null || value === undefined) {
      return 'null';
    }

    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return '[object]';
      }
    }

    return '[unknown]';
  }

  private describeMessages(messages: BaseMessage[]): string[] {
    return messages.map((message) =>
      this.messageSerializer.describeMessageForLog(message),
    );
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
}
