import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  BaseMessage,
  HumanMessage,
  isAIMessage,
  isBaseMessage,
} from '@langchain/core/messages';
import { NormalizedEventDto } from '../api/transport/dto/normalized-event.dto';
import { buildThreadKey } from '../common/keys.util';
import { MemoryService } from '../memory/memory.service';
import { AgentResponseDto } from '../transport/dto/agent-response.dto';
import { CommandRouter } from './command-router.service';
import { GraphFactory, type CompiledGraph } from './langgraph/graph.factory';
import { GeneratedMessagePersisterService } from './messages/generated-message-persister.service';
import type { MessageSerializer } from './messages/interfaces/message-serializer';
import { HistoryBuilderService } from './messages/history-builder.service';
import { MESSAGE_SERIALIZER } from './messages/tokens';
import { InputNormalizer } from './input-normalizer.service';
import { ResponseBuilder } from './response-builder.service';
import { AppConfigService } from '../config/config.service';
import { RequestContext } from '../common/request-context';

/**
 * Coordinates the orchestration pipeline, connecting memory, LangGraph, and response shaping.
 */
@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly graph: CompiledGraph;
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
    this.graph = this.graphFactory.build();
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

        if (useCheckpointer) {
          this.logDebug('Invoking LangGraph', {
            threadKey,
            mode: 'checkpointer',
          });

          const result = await this.graph.invoke(
            { messages: [new HumanMessage(userContent)] },
            { configurable: { thread_id: threadKey, chatId: threadKey } },
          );

          const rawMessages = Array.isArray(result.messages)
            ? result.messages
            : [];
          const messages = rawMessages.filter(
            (message): message is BaseMessage => isBaseMessage(message),
          );
          const elapsedMs = Date.now() - startedAt;

          this.logDebug('LangGraph completed', {
            threadKey,
            mode: 'checkpointer',
            messageCount: messages.length,
            elapsedMs,
            messages: this.describeMessages(messages),
          });

          if (!messages.some((message) => isAIMessage(message))) {
            this.logger.warn(
              `LangGraph completed without an assistant response (mode=checkpointer threadKey=${threadKey})`,
            );
          }

          span.setAttribute('app.mode', 'checkpointer');
          span.setAttribute('app.elapsed_ms', elapsedMs);
          span.setAttribute('app.message_count', messages.length);
          span.setStatus({ code: SpanStatusCode.OK });
          return this.responseBuilder.build(
            event.chatId,
            messages,
            0,
            elapsedMs,
          );
        }

        await this.memoryService.pushMessage(threadKey, {
          role: 'user',
          content: userContent,
          meta: this.inputNormalizer.userMeta(event),
        });

        const window = await this.memoryService.getWindow(threadKey);
        const history = this.historyBuilder.buildHistory(window);
        const initialLength = history.length;

        this.logDebug('Invoking LangGraph', {
          threadKey,
          mode: 'memory',
          historyLength: history.length,
          windowLength: window.length,
        });

        const result = await this.graph.invoke(
          { messages: history },
          { configurable: { chatId: threadKey } },
        );

        const rawMessages = Array.isArray(result.messages)
          ? result.messages
          : [];
        const messages = rawMessages.filter((message): message is BaseMessage =>
          isBaseMessage(message),
        );
        const generatedIndex = initialLength;
        const generatedMessages = messages.slice(generatedIndex);
        const elapsedMs = Date.now() - startedAt;

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

        if (!messages.some((message) => isAIMessage(message))) {
          this.logger.warn(
            `LangGraph completed without an assistant response (threadKey=${threadKey})`,
          );
        }

        span.setAttribute('app.mode', 'memory');
        span.setAttribute('app.elapsed_ms', elapsedMs);
        span.setAttribute('app.generated_count', generatedMessages.length);
        span.setAttribute('app.history_length', history.length);
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
