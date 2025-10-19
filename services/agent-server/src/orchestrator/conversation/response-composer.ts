import { Injectable } from '@nestjs/common';
import type { BaseMessage } from '@langchain/core/messages';
import type { AgentResponseDto } from '../../transport/dto/agent-response.dto';
import { ResponseBuilder } from '../response-builder.service';

/**
 * Produces transport-ready responses from LangGraph transcripts.
 */
@Injectable()
export class ResponseComposer {
  constructor(private readonly builder: ResponseBuilder) {}

  /**
   * Creates a response for the specified chat identifier.
   *
   * @param chatId Transport-specific chat identifier.
   * @param transcript Full conversation transcript.
   * @param generatedFromIndex Index where assistant generations begin.
   * @param elapsedMs Optional elapsed execution time in milliseconds.
   * @returns Agent response DTO describing the output.
   */
  compose(
    chatId: string,
    transcript: BaseMessage[],
    generatedFromIndex: number,
    elapsedMs?: number,
  ): AgentResponseDto {
    return this.builder.build(
      chatId,
      transcript,
      generatedFromIndex,
      elapsedMs,
    );
  }
}
