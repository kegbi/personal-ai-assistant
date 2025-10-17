import { Inject, Injectable } from '@nestjs/common';
import { AIMessage, BaseMessage, isAIMessage } from '@langchain/core/messages';
import { AgentResponseDto } from '../transport/dto/agent-response.dto';
import type { MessageSerializer } from './messages/interfaces/message-serializer';
import type { ToolInvocationMeta } from './messages/types/tool-invocation-meta';
import { MESSAGE_SERIALIZER } from './messages/tokens';

/**
 * Builds transport responses from LangGraph transcripts while extracting tool metadata.
 */
@Injectable()
export class ResponseBuilder {
  constructor(
    @Inject(MESSAGE_SERIALIZER)
    private readonly serializer: MessageSerializer,
  ) {}

  /**
   * Translates the LangGraph transcript into the final agent response.
   *
   * @param chatId Chat identifier associated with the interaction.
   * @param transcript Combined transcript returned by LangGraph.
   * @param generatedFromIndex Index at which LangGraph-generated messages begin.
   * @returns Agent response ready for transport delivery.
   */
  build(
    chatId: string,
    transcript: BaseMessage[],
    generatedFromIndex: number,
  ): AgentResponseDto {
    const generated = transcript.slice(generatedFromIndex);
    const finalMessage = this.pickFinalAssistantMessage(transcript);

    if (!finalMessage) {
      return {
        chatId,
        text: 'I am not sure how to respond to that just yet.',
      };
    }

    const toolMeta: ToolInvocationMeta | null =
      this.serializer.extractToolMeta(generated);

    return {
      chatId,
      text: this.serializer.extractMessageContent(finalMessage),
      meta: toolMeta
        ? {
            tool: toolMeta.name,
            args: toolMeta.args,
          }
        : undefined,
    };
  }

  /**
   * Finds the last assistant message within the provided transcript.
   *
   * @param messages Transcript ordered chronologically.
   * @returns Last assistant message or null when none exists.
   */
  private pickFinalAssistantMessage(messages: BaseMessage[]): AIMessage | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (isAIMessage(candidate)) {
        return candidate;
      }
    }

    return null;
  }
}
