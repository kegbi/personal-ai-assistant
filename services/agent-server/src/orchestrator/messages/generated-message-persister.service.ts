import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  isAIMessage,
  isToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { MemoryService } from '../../memory/memory.service';
import type { MessageSerializer } from './interfaces/message-serializer';
import { MESSAGE_SERIALIZER } from './tokens';

@Injectable()
export class GeneratedMessagePersisterService {
  private readonly logger = new Logger(GeneratedMessagePersisterService.name);

  constructor(
    private readonly memoryService: MemoryService,
    @Inject(MESSAGE_SERIALIZER)
    private readonly messageTransformer: MessageSerializer,
  ) {}

  /**
   * Persists assistant and tool responses generated during a LangGraph execution.
   */
  async persistGeneratedMessages(
    threadKey: string,
    messages: BaseMessage[],
  ): Promise<void> {
    for (const message of messages) {
      const memoryMessage = this.messageTransformer.fromBaseMessage(message);
      if (!memoryMessage) {
        this.logger.debug(
          `Skipping persistence for generated ${this.messageTransformer.describeMessageForLog(message)} message`,
        );
        continue;
      }

      this.logGeneratedMessageContent(
        threadKey,
        message,
        memoryMessage.content,
      );

      this.logger.debug(
        `Persisting generated ${memoryMessage.role} message for thread ${threadKey} (toolCalls=${
          this.messageTransformer.hasToolCalls(memoryMessage) ? 'yes' : 'no'
        })`,
      );

      await this.memoryService.pushMessage(threadKey, memoryMessage);
    }
  }

  private logGeneratedMessageContent(
    threadKey: string,
    message: BaseMessage,
    persistedContent?: string,
  ): void {
    if (!isAIMessage(message) && !isToolMessage(message)) {
      return;
    }

    const rawContent =
      persistedContent && persistedContent.length > 0
        ? persistedContent
        : this.messageTransformer.extractMessageContent(message);

    if (!rawContent || rawContent.length === 0) {
      return;
    }

    const truncated =
      rawContent.length > 1000 ? `${rawContent.slice(0, 1000)}…` : rawContent;

    this.logger.debug(
      `Generated ${message._getType()} message content for thread ${threadKey}: ${truncated}`,
    );
  }
}
