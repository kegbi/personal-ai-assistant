import { Injectable } from '@nestjs/common';
import type { BaseMessage } from '@langchain/core/messages';
import { GeneratedMessagePersisterService } from '../messages/generated-message-persister.service';

/**
 * Handles persistence of generated assistant messages per conversation thread.
 */
@Injectable()
export class TranscriptPersister {
  constructor(private readonly persister: GeneratedMessagePersisterService) {}

  /**
   * Persists assistant messages emitted after the provided index.
   *
   * @param threadKey Deterministic identifier for the conversation.
   * @param transcript Full transcript returned by the graph.
   * @param generatedFromIndex Index where assistant generations begin.
   */
  async persist(
    threadKey: string,
    transcript: BaseMessage[],
    generatedFromIndex: number,
  ): Promise<void> {
    if (generatedFromIndex >= transcript.length) {
      return;
    }

    const generated = transcript.slice(generatedFromIndex);
    if (generated.length === 0) {
      return;
    }

    await this.persister.persistGeneratedMessages(threadKey, generated);
  }
}
