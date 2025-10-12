import { Injectable, Logger } from '@nestjs/common';
import type { BaseMessage } from '@langchain/core/messages';
import { MemoryService } from '../../memory/memory.service';
import { MessageTransformerService } from './message-transformer.service';

@Injectable()
export class GeneratedMessagePersisterService {
  private readonly logger = new Logger(GeneratedMessagePersisterService.name);

  constructor(
    private readonly memoryService: MemoryService,
    private readonly messageTransformer: MessageTransformerService,
  ) {}

  /**
   * Persists assistant and tool responses generated during a LangGraph execution.
   */
  async persistGeneratedMessages(
    chatId: string,
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

      this.logger.debug(
        `Persisting generated ${memoryMessage.role} message for chat ${chatId} (toolCalls=${
          this.messageTransformer.hasToolCalls(memoryMessage) ? 'yes' : 'no'
        })`,
      );

      await this.memoryService.pushMessage(chatId, memoryMessage);
    }
  }
}
