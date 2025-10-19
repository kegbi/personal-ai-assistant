import { Inject, Injectable } from '@nestjs/common';
import type { BaseMessage } from '@langchain/core/messages';
import { HumanMessage } from '@langchain/core/messages';
import type { MemoryMessage } from '../../memory/memory.service';
import { HistoryBuilderService } from '../messages/history-builder.service';

/**
 * Minimal contract required to transform memory windows into LangChain histories.
 */
export interface ConversationHistoryBuilder {
  /**
   * Builds a LangChain history from the provided memory window.
   *
   * @param window Memory messages to transform.
   * @returns LangChain messages suitable for graph execution.
   */
  buildHistory(window: MemoryMessage[]): BaseMessage[];
}

export interface TranscriptAssembly {
  readonly transcript: BaseMessage[];
  readonly generatedFromIndex: number;
}

/**
 * Produces conversation transcripts for LangGraph execution.
 */
@Injectable()
export class TranscriptAssembler {
  constructor(
    @Inject(HistoryBuilderService)
    private readonly historyBuilder: ConversationHistoryBuilder,
  ) {}

  /**
   * Builds a transcript from the persisted conversation window.
   *
   * @param window Memory window for the current thread.
   * @returns Transcript plus index where new generations should start.
   */
  buildFromWindow(window: MemoryMessage[]): TranscriptAssembly {
    const transcript = this.historyBuilder.buildHistory(window);
    return {
      transcript,
      generatedFromIndex: transcript.length,
    };
  }

  /**
   * Builds a transcript for checkpointer mode where only the latest user input is provided.
   *
   * @param userContent Canonical text representing the user input.
   * @returns Transcript containing the single user message.
   */
  buildForCheckpointer(userContent: string): TranscriptAssembly {
    const transcript: BaseMessage[] = [new HumanMessage(userContent)];
    return {
      transcript,
      generatedFromIndex: 0,
    };
  }
}
