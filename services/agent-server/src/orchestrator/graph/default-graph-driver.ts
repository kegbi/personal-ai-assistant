import type { BaseMessage, AIMessage } from '@langchain/core/messages';
import { isAIMessage, isBaseMessage } from '@langchain/core/messages';
import type {
  GraphDriver,
  GraphStreamChunk,
  RunInput,
  RunResult,
} from './graph-driver';
import { TextExtractor } from '../streaming/text-extractor';
import { DeltaAccumulator } from '../streaming/delta-accumulator';
import { ToolEventExtractor } from '../streaming/tool-event-extractor';

/**
 * Minimal executor contract used by the driver.
 */
export interface GraphExecutor {
  invoke(
    input: { readonly messages: BaseMessage[] },
    options: Record<string, unknown>,
  ): Promise<{ readonly messages?: unknown }>;

  stream(
    input: { readonly messages: BaseMessage[] },
    options: Record<string, unknown>,
  ): Promise<AsyncIterable<unknown>>;
}

/**
 * Default LangGraph driver responsible for translating outputs into transport events.
 */
export class DefaultGraphDriver implements GraphDriver {
  private readonly textExtractor = new TextExtractor();

  constructor(private readonly graph: GraphExecutor) {}

  async run(input: RunInput): Promise<RunResult> {
    const { history, threadKey, generatedFromIndex, useCheckpointer } = input;
    const startedAt = Date.now();
    const configurable = useCheckpointer
      ? { thread_id: threadKey, chatId: threadKey }
      : { chatId: threadKey };

    const result = await this.graph.invoke(
      { messages: history },
      { configurable },
    );

    const transcript = this.extractMessages(result);

    return {
      transcript,
      generatedFromIndex,
      elapsedMs: Date.now() - startedAt,
    };
  }

  async *stream(input: RunInput): AsyncGenerator<GraphStreamChunk> {
    const { history, threadKey, useCheckpointer } = input;

    const deltaAccumulator = new DeltaAccumulator();
    const toolEventExtractor = new ToolEventExtractor();

    const stream = await this.graph.stream(
      { messages: history },
      useCheckpointer
        ? {
            configurable: { thread_id: threadKey, chatId: threadKey },
            streamMode: ['messages', 'values'],
          }
        : {
            configurable: { chatId: threadKey },
            streamMode: ['messages', 'values'],
          },
    );

    let fallbackIndex = 0;
    const resolveKey = (message: AIMessage): string => {
      const messageId = message.id;
      if (typeof messageId === 'string' && messageId.length > 0) {
        return messageId;
      }

      const key = `ai-${fallbackIndex}`;
      fallbackIndex += 1;
      return key;
    };

    for await (const entry of stream) {
      if (!this.isStreamEntry(entry)) {
        continue;
      }

      const [mode, payload] = entry;
      if (mode === 'messages' && this.isMessageArray(payload)) {
        for (const message of payload) {
          if (!isAIMessage(message)) {
            continue;
          }

          const key = resolveKey(message);
          const nextText = this.textExtractor.extract(message.content);
          const delta = deltaAccumulator.computeDelta(key, nextText);

          if (delta.length > 0) {
            yield {
              type: 'delta',
              text: delta,
            };
          }

          for (const event of toolEventExtractor.extract(message)) {
            yield event;
          }
        }
      } else if (mode === 'values' && this.isStateSnapshot(payload)) {
        yield {
          kind: 'internal',
          messages: payload.messages,
        };
      }
    }
  }

  private extractMessages(result: unknown): BaseMessage[] {
    if (!this.hasMessagesField(result)) {
      return [];
    }

    const rawMessages = result.messages;
    if (!Array.isArray(rawMessages)) {
      return [];
    }

    return rawMessages.filter((message): message is BaseMessage =>
      isBaseMessage(message),
    );
  }

  private hasMessagesField(
    value: unknown,
  ): value is { readonly messages: unknown } {
    return typeof value === 'object' && value !== null && 'messages' in value;
  }

  private isStreamEntry(value: unknown): value is readonly [string, unknown] {
    return (
      Array.isArray(value) && value.length === 2 && typeof value[0] === 'string'
    );
  }

  private isMessageArray(value: unknown): value is BaseMessage[] {
    return Array.isArray(value) && value.every((item) => isBaseMessage(item));
  }

  private isStateSnapshot(value: unknown): value is {
    readonly messages: BaseMessage[];
  } {
    if (!this.isRecord(value)) {
      return false;
    }

    const messagesField = value.messages;
    if (!this.isMessageArray(messagesField)) {
      return false;
    }

    return true;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
