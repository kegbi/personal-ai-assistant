import { Injectable, Logger } from '@nestjs/common';
import { AIMessage, BaseMessage, isAIMessage } from '@langchain/core/messages';
import { MessageReceivedDto } from '../transport/dto/message-received.dto';
import { AgentResponseDto } from '../transport/dto/agent-response.dto';
import { MemoryService } from '../memory/memory.service';
import { GraphFactory, type CompiledGraph } from './langgraph/graph.factory';
import { HistoryBuilderService } from './messages/history-builder.service';
import { GeneratedMessagePersisterService } from './messages/generated-message-persister.service';
import {
  MessageTransformerService,
  type ToolInvocationMeta,
} from './messages/message-transformer.service';

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly graph: CompiledGraph;

  constructor(
    private readonly memoryService: MemoryService,
    private readonly graphFactory: GraphFactory,
    private readonly historyBuilder: HistoryBuilderService,
    private readonly generatedMessagePersister: GeneratedMessagePersisterService,
    private readonly messageTransformer: MessageTransformerService,
  ) {
    this.graph = this.graphFactory.build();
  }

  /**
   * Routes inbound user messages through LangGraph and returns the assistant reply.
   */
  async handleEvent(message: MessageReceivedDto): Promise<AgentResponseDto> {
    if (message.isCommand && message.command) {
      return this.handleCommand(message);
    }

    const userContent = this.resolveUserContent(message);

    await this.memoryService.pushMessage(message.chatId, {
      role: 'user',
      content: userContent,
      meta: this.buildUserMeta(message),
    });

    const window = await this.memoryService.getWindow(message.chatId);
    const history = this.historyBuilder.buildHistory(window);
    const initialLength = history.length;

    this.logger.debug(
      `Invoking LangGraph for chat ${message.chatId} (history=${history.length}, window=${window.length})`,
    );

    const result = await this.graph.invoke(
      {
        messages: history,
      },
      {
        configurable: {
          chatId: message.chatId,
        },
      },
    );

    const messages = result.messages as BaseMessage[];
    const generated = messages.slice(initialLength);

    this.logger.debug(
      `LangGraph produced ${generated.length} message(s) for chat ${message.chatId}${
        generated.length
          ? `: ${generated
              .map((msg) => this.messageTransformer.describeMessageForLog(msg))
              .join(', ')}`
          : ''
      }`,
    );

    await this.generatedMessagePersister.persistGeneratedMessages(
      message.chatId,
      generated,
    );

    const finalMessage = this.pickFinalAssistantMessage(messages);

    if (!finalMessage) {
      this.logger.warn('LangGraph completed without an assistant response');
      return {
        chatId: message.chatId,
        text: 'I am not sure how to respond to that just yet.',
      };
    }

    const toolMeta: ToolInvocationMeta | null =
      this.messageTransformer.extractToolMeta(generated);

    return {
      chatId: message.chatId,
      text: this.messageTransformer.extractMessageContent(finalMessage),
      meta: toolMeta ? { tool: toolMeta.name, args: toolMeta.args } : undefined,
    };
  }

  /**
   * Handles simple slash commands issued by the user.
   */
  private async handleCommand(
    message: MessageReceivedDto,
  ): Promise<AgentResponseDto> {
    const command = message.command?.toLowerCase() ?? '';

    switch (command) {
      case '/start': {
        await this.memoryService.clear(message.chatId);
        return {
          chatId: message.chatId,
          text: 'Hello! I am your personal AI assistant. Ask me to remember contacts, update details, or just chat.',
        };
      }
      case '/clear': {
        await this.memoryService.clear(message.chatId);
        return {
          chatId: message.chatId,
          text: 'Cleared recent conversation memory for this chat.',
        };
      }
      case '/help': {
        return {
          chatId: message.chatId,
          text:
            'Try:\n' +
            '• “Remember that Alice is my designer friend.”\n' +
            '• “Set Alice’s birthday to 1991-05-14.”\n' +
            '• “Who is Alice?”',
        };
      }
      default:
        return {
          chatId: message.chatId,
          text: `Unknown command ${command}. Available: /start, /help, /clear.`,
        };
    }
  }

  /**
   * Normalises the various input shapes we accept into a plain-text user message.
   */
  private resolveUserContent(message: MessageReceivedDto): string {
    if (message.text && message.text.trim().length > 0) {
      return message.text.trim();
    }

    if (message.voiceUrl) {
      return `[voice message received: ${message.voiceUrl}]`;
    }

    return '[empty message]';
  }

  /**
   * Builds optional metadata for user messages before they are persisted.
   */
  private buildUserMeta(
    message: MessageReceivedDto,
  ): Record<string, unknown> | undefined {
    const meta: Record<string, unknown> = {};

    if (message.voiceUrl) {
      meta.voiceUrl = message.voiceUrl;
    }

    if (message.payload) {
      meta.payload = message.payload;
    }

    return Object.keys(meta).length > 0 ? meta : undefined;
  }

  /**
   * Walks the LangGraph transcript and returns the latest assistant reply.
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
