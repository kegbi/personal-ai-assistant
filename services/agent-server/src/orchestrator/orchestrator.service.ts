import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { BaseMessage, isAIMessage } from '@langchain/core/messages';
import { NormalizedEventDto } from '../api/transport/dto/normalized-event.dto';
import { buildThreadKey } from '../common/keys.util';
import { AgentResponseDto } from '../transport/dto/agent-response.dto';
import type { AgentStreamEvent } from '../transport/dto/agent-stream-event.dto';
import { CommandRouter } from './command-router.service';
import type { MessageSerializer } from './messages/interfaces/message-serializer';
import { MESSAGE_SERIALIZER } from './messages/tokens';
import { AppConfigService } from '../config/config.service';
import { RequestContext } from '../common/request-context';
import { ConversationOrchestrator } from './conversation/conversation-orchestrator';

/**
 * Coordinates the orchestration pipeline, connecting memory, LangGraph, and response shaping.
 */
@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly tracer = trace.getTracer('agent.orchestrator');

  constructor(
    private readonly commandRouter: CommandRouter,
    private readonly configService: AppConfigService,
    private readonly requestContext: RequestContext,
    private readonly conversationOrchestrator: ConversationOrchestrator,
    @Inject(MESSAGE_SERIALIZER)
    private readonly messageSerializer: MessageSerializer,
  ) {}

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

        const useCheckpointer =
          this.configService.features.enableCheckpointer === true;

        const outcome = await this.conversationOrchestrator.handle({
          threadKey,
          chatId: event.chatId,
          event,
          useCheckpointer,
        });

        const messages = outcome.transcript;
        const generatedMessages = messages.slice(outcome.generatedFromIndex);

        if (!messages.some((message) => isAIMessage(message))) {
          this.logger.warn(
            `LangGraph completed without an assistant response (mode=${outcome.mode} threadKey=${threadKey})`,
          );
        }

        if (outcome.mode === 'checkpointer') {
          this.logDebug('LangGraph completed', {
            threadKey,
            mode: 'checkpointer',
            messageCount: messages.length,
            elapsedMs: outcome.elapsedMs,
            messages: this.describeMessages(messages),
          });

          span.setAttribute('app.mode', 'checkpointer');
          span.setAttribute('app.elapsed_ms', outcome.elapsedMs);
          span.setAttribute('app.message_count', messages.length);
          span.setStatus({ code: SpanStatusCode.OK });

          return outcome.response;
        }

        this.logDebug('LangGraph completed', {
          threadKey,
          mode: 'memory',
          generatedCount: generatedMessages.length,
          elapsedMs: outcome.elapsedMs,
          messages: this.describeMessages(generatedMessages),
        });

        span.setAttribute('app.mode', 'memory');
        span.setAttribute('app.elapsed_ms', outcome.elapsedMs);
        span.setAttribute('app.generated_count', generatedMessages.length);
        span.setAttribute('app.history_length', outcome.generatedFromIndex);
        span.setAttribute('app.window_length', outcome.windowLength);
        span.setStatus({ code: SpanStatusCode.OK });

        return outcome.response;
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

      const stream = this.conversationOrchestrator.stream({
        threadKey,
        chatId: event.chatId,
        event,
        useCheckpointer,
      });

      for await (const chunk of stream.events) {
        yield chunk;
      }

      const outcome = await stream.result;
      const messages = outcome.transcript;
      const generatedMessages = messages.slice(outcome.generatedFromIndex);

      this.logDebug('LangGraph streaming completed', {
        threadKey,
        mode: outcome.mode,
        elapsedMs: outcome.elapsedMs,
        messageCount: messages.length,
        messages: this.describeMessages(messages),
      });

      if (outcome.mode === 'memory') {
        span.setAttribute('app.generated_count', generatedMessages.length);
        span.setAttribute('app.history_length', outcome.generatedFromIndex);
        span.setAttribute('app.window_length', outcome.windowLength);
      } else {
        span.setAttribute('app.generated_count', messages.length);
        span.setAttribute('app.history_length', outcome.windowLength);
      }

      span.setAttribute('app.mode', outcome.mode);
      span.setAttribute('app.elapsed_ms', outcome.elapsedMs);
      span.setAttribute('app.message_count', messages.length);
      span.setStatus({ code: SpanStatusCode.OK });
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
