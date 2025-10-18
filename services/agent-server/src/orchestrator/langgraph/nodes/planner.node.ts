import { Injectable, Logger } from '@nestjs/common';
import { MessagesAnnotation } from '@langchain/langgraph';
import { AIMessage, BaseMessage, isAIMessage } from '@langchain/core/messages';
import type { Runnable, RunnableConfig } from '@langchain/core/runnables';
import { ChatOpenAI } from '@langchain/openai';
import { AppConfigService } from '../../../config/config.service';
import { ToolRouterNode } from './tool-router.node';
import { SpanStatusCode, trace } from '@opentelemetry/api';

@Injectable()
export class PlannerNode {
  private readonly logger = new Logger(PlannerNode.name);
  private cachedModel?: Runnable<BaseMessage[], AIMessage>;
  private readonly tracer = trace.getTracer('agent.planner');

  constructor(
    private readonly config: AppConfigService,
    private readonly toolRouterNode: ToolRouterNode,
  ) {}

  private buildModel(): Runnable<BaseMessage[], AIMessage> | null {
    if (!this.config.ai.apiKey) {
      return null;
    }

    if (!this.cachedModel) {
      const model = new ChatOpenAI({
        apiKey: this.config.ai.apiKey,
        model: this.config.ai.model,
      });

      this.cachedModel = model.bindTools(this.toolRouterNode.tools);
    }

    return this.cachedModel;
  }

  async execute(
    state: typeof MessagesAnnotation.State,
    config?: RunnableConfig,
  ): Promise<Partial<typeof MessagesAnnotation.State>> {
    const span = this.tracer.startSpan('planner.execute');
    const startedAt = Date.now();
    const model = this.buildModel();

    if (!model) {
      this.logger.warn('Planner invoked without an AI API key');
      this.logDebug('Planner skipped', {
        reason: 'missing_api_key',
        elapsedMs: Date.now() - startedAt,
      });
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'missing_api_key',
      });
      span.setAttribute('app.elapsed_ms', Date.now() - startedAt);
      span.end();
      return {
        messages: [
          new AIMessage(
            'LLM capabilities are not configured yet. Please set OPENAI_API_KEY to enable reasoning.',
          ),
        ],
      };
    }

    try {
      const response = await model.invoke(state.messages, config);
      const elapsedMs = Date.now() - startedAt;
      this.logDebug('Planner completed', {
        elapsedMs,
      });
      span.setAttribute('app.elapsed_ms', elapsedMs);
      span.setStatus({ code: SpanStatusCode.OK });
      return { messages: [response] };
    } catch (error) {
      this.logger.error(
        'Planner failed to invoke the language model',
        error instanceof Error ? error.stack : String(error),
      );
      const elapsedMs = Date.now() - startedAt;
      this.logDebug('Planner failed', {
        elapsedMs,
      });
      span.recordException(error instanceof Error ? error : String(error));
      span.setAttribute('app.elapsed_ms', elapsedMs);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'planner_invoke_failed',
      });
      return {
        messages: [
          new AIMessage(
            'I ran into an error while thinking about that. Please try again shortly.',
          ),
        ],
      };
    } finally {
      span.end();
    }
  }

  determineNext(state: typeof MessagesAnnotation.State): 'tool' | 'respond' {
    const lastMessage = state.messages[state.messages.length - 1];

    if (isAIMessage(lastMessage) && lastMessage.tool_calls?.length) {
      return 'tool';
    }

    return 'respond';
  }

  private logDebug(message: string, meta: Record<string, unknown>): void {
    if (this.config.logging.format === 'json') {
      this.logger.debug({ message, ...meta });
      return;
    }

    const parts: string[] = [];
    for (const [key, value] of Object.entries(meta)) {
      parts.push(`${key}=${this.describeValue(value)}`);
    }
    this.logger.debug(`${message} ${parts.join(' ')}`);
  }

  private describeValue(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? String(value) : 'NaN';
    }

    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }

    if (value === null || value === undefined) {
      return 'null';
    }

    try {
      return JSON.stringify(value);
    } catch {
      return '[object]';
    }
  }
}
