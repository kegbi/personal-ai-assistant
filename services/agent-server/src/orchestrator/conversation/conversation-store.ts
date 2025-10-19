import { Inject, Injectable } from '@nestjs/common';
import type { NormalizedEventDto } from '../../api/transport/dto/normalized-event.dto';
import { MemoryService, type MemoryMessage } from '../../memory/memory.service';
import { InputNormalizer } from '../input-normalizer.service';

/**
 * Minimal contract the conversation store requires from the memory layer.
 */
export interface ConversationMemory {
  /**
   * Persists a memory message inside the rolling window.
   *
   * @param threadKey Deterministic identifier for the conversation.
   * @param message Structured message payload for storage.
   */
  pushMessage(threadKey: string, message: MemoryMessage): Promise<void>;

  /**
   * Fetches the current rolling window for a conversation.
   *
   * @param threadKey Deterministic identifier for the conversation.
   * @returns Ordered memory messages composing the window.
   */
  getWindow(threadKey: string): Promise<MemoryMessage[]>;
}

/**
 * Coordinates conversation persistence concerns around the rolling memory window.
 */
@Injectable()
export class ConversationStore {
  constructor(
    @Inject(MemoryService) private readonly memory: ConversationMemory,
    private readonly normalizer: InputNormalizer,
  ) {}

  /**
   * Appends the normalized user message to the memory window.
   *
   * @param threadKey Deterministic identifier representing connector and chat.
   * @param event Normalized transport event describing the user input.
   */
  async appendUser(
    threadKey: string,
    event: NormalizedEventDto,
  ): Promise<void> {
    const content = this.normalizer.toText(event);
    const meta = this.normalizer.userMeta(event);

    const message: MemoryMessage = {
      role: 'user',
      content,
    };

    if (meta) {
      message.meta = meta;
    }

    await this.memory.pushMessage(threadKey, message);
  }

  /**
   * Loads the conversation window for the supplied thread.
   *
   * @param threadKey Deterministic identifier representing connector and chat.
   * @returns Ordered memory messages describing the window.
   */
  async loadWindow(threadKey: string): Promise<MemoryMessage[]> {
    return this.memory.getWindow(threadKey);
  }
}
