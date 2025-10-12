import { Injectable, Logger } from '@nestjs/common';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  isAIMessage,
  isToolMessage,
} from '@langchain/core/messages';
import { MessagesAnnotation } from '@langchain/langgraph';
import { MessageReceivedDto } from '../transport/dto/message-received.dto';
import { AgentResponseDto } from '../transport/dto/agent-response.dto';
import { MemoryMessage, MemoryService } from '../memory/memory.service';
import { GraphFactory, type CompiledGraph } from './langgraph/graph.factory';
import { DEFAULT_SYSTEM_PROMPT } from '../policies/prompt.policy';

type AgentState = typeof MessagesAnnotation.State;

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly graph: CompiledGraph;

  constructor(
    private readonly memoryService: MemoryService,
    private readonly graphFactory: GraphFactory,
  ) {
    this.graph = this.graphFactory.build();
  }

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
    const history = this.composeHistory(window);
    const initialLength = history.length;

    const result = (await this.graph.invoke(
      {
        messages: history,
      },
      {
        configurable: {
          chatId: message.chatId,
        },
      },
    ));

    const messages = result.messages as BaseMessage[];
    const generated = messages.slice(initialLength);
    await this.persistGeneratedMessages(message.chatId, generated);

    const finalMessage = this.pickFinalAssistantMessage(messages);

    if (!finalMessage) {
      this.logger.warn('LangGraph completed without an assistant response');
      return {
        chatId: message.chatId,
        text: 'I am not sure how to respond to that just yet.',
      };
    }

    const toolMeta = this.extractToolMeta(generated);

    return {
      chatId: message.chatId,
      text: this.extractMessageContent(finalMessage),
      meta: toolMeta ? { tool: toolMeta.name, args: toolMeta.args } : undefined,
    };
  }

  private async handleCommand(message: MessageReceivedDto): Promise<AgentResponseDto> {
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

  private resolveUserContent(message: MessageReceivedDto): string {
    if (message.text && message.text.trim().length > 0) {
      return message.text.trim();
    }

    if (message.voiceUrl) {
      return `[voice message received: ${message.voiceUrl}]`;
    }

    return '[empty message]';
  }

  private buildUserMeta(message: MessageReceivedDto): Record<string, unknown> | undefined {
    const meta: Record<string, unknown> = {};

    if (message.voiceUrl) {
      meta.voiceUrl = message.voiceUrl;
    }

    if (message.payload) {
      meta.payload = message.payload;
    }

    return Object.keys(meta).length > 0 ? meta : undefined;
  }

  private composeHistory(window: MemoryMessage[]): BaseMessage[] {
    const history: BaseMessage[] = [
      new SystemMessage(DEFAULT_SYSTEM_PROMPT),
    ];

    for (const item of window) {
      history.push(this.toBaseMessage(item));
    }

    return history;
  }

  private toBaseMessage(memoryMessage: MemoryMessage): BaseMessage {
    const content = memoryMessage.content ?? '';

    switch (memoryMessage.role) {
      case 'assistant':
        return new AIMessage({
          content,
          additional_kwargs: memoryMessage.meta ?? {},
        });
      case 'system':
        return new SystemMessage({
          content,
          additional_kwargs: memoryMessage.meta ?? {},
        });
      default:
        return new HumanMessage({
          content,
          additional_kwargs: memoryMessage.meta ?? {},
        });
    }
  }

  private async persistGeneratedMessages(
    chatId: string,
    messages: BaseMessage[],
  ): Promise<void> {
    for (const message of messages) {
      const memoryMessage = this.fromBaseMessage(message);
      if (!memoryMessage) {
        continue;
      }

      await this.memoryService.pushMessage(chatId, memoryMessage);
    }
  }

  private fromBaseMessage(message: BaseMessage): MemoryMessage | null {
    if (isAIMessage(message)) {
      return {
        role: 'assistant',
        content: this.extractMessageContent(message),
        meta: message.additional_kwargs,
      };
    }

    if (isToolMessage(message)) {
      return {
        role: 'system',
        content: `Tool ${message.name} result`,
        meta: {
          tool: message.name,
          toolCallId: message.tool_call_id,
          content: message.content,
        },
      };
    }

    return null;
  }

  private pickFinalAssistantMessage(messages: BaseMessage[]): AIMessage | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (isAIMessage(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private extractMessageContent(message: AIMessage | ToolMessage): string {
    if (typeof message.content === 'string') {
      return message.content;
    }

    return message.content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }

        if ('text' in part) {
          return part.text;
        }

        return JSON.stringify(part);
      })
      .join('\n')
      .trim();
  }

  private extractToolMeta(messages: BaseMessage[]) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (isToolMessage(candidate)) {
        return {
          name: candidate.name,
          args:
            candidate.additional_kwargs ??
            (typeof candidate.content === 'string'
              ? { result: candidate.content }
              : { result: candidate.content }),
        };
      }
    }

    return null;
  }
}
