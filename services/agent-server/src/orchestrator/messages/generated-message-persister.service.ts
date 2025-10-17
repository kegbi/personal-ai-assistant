import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BaseMessage } from '@langchain/core/messages';
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

      this.logger.debug(
        `Persisting generated ${memoryMessage.role} message for thread ${threadKey} (toolCalls=${
          this.messageTransformer.hasToolCalls(memoryMessage) ? 'yes' : 'no'
        })`,
      );

      await this.memoryService.pushMessage(threadKey, memoryMessage);
    }
  }
}
