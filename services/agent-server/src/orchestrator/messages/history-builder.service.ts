import { Injectable, Logger } from '@nestjs/common';
import {
  BaseMessage,
  SystemMessage,
  isAIMessage,
  isToolMessage,
} from '@langchain/core/messages';
import { DEFAULT_SYSTEM_PROMPT } from '../../policies/prompt.policy';
import { MemoryMessage } from '../../memory/memory.service';
import { MessageTransformerService } from './message-transformer.service';

@Injectable()
export class HistoryBuilderService {
  private readonly logger = new Logger(HistoryBuilderService.name);

  constructor(private readonly messageTransformer: MessageTransformerService) {}

  /**
   * Rebuilds the LangChain conversation history, ensuring each tool response
   * is paired with the assistant tool call that produced it.
   */
  buildHistory(window: MemoryMessage[]): BaseMessage[] {
    const history: BaseMessage[] = [new SystemMessage(DEFAULT_SYSTEM_PROMPT)];

    for (const item of window) {
      const baseMessage = this.messageTransformer.toBaseMessage(item);

      if (isToolMessage(baseMessage)) {
        const previous = history[history.length - 1];
        if (
          !previous ||
          !isAIMessage(previous) ||
          !this.messageTransformer.toolCallMatches(previous, baseMessage)
        ) {
          // Downgrade orphaned tool responses so the LLM history stays valid.
          this.logger.warn(
            `Skipping tool message due to missing matching tool call (toolCallId=${
              baseMessage.tool_call_id ?? 'unknown'
            })`,
          );

          history.push(
            this.messageTransformer.createFallbackSystemMessage(baseMessage),
          );

          continue;
        }
      }

      history.push(baseMessage);
    }

    return history;
  }
}
