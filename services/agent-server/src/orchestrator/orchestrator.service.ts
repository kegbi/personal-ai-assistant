import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BaseMessage,
  isAIMessage,
  isBaseMessage,
} from '@langchain/core/messages';
import { NormalizedEventDto } from '../api/transport/dto/normalized-event.dto';
import { MemoryService } from '../memory/memory.service';
import { AgentResponseDto } from '../transport/dto/agent-response.dto';
import { CommandRouter } from './command-router.service';
import { GraphFactory, type CompiledGraph } from './langgraph/graph.factory';
import { GeneratedMessagePersisterService } from './messages/generated-message-persister.service';
import type { MessageSerializer } from './messages/interfaces/message-serializer';
import { HistoryBuilderService } from './messages/history-builder.service';
import { MESSAGE_SERIALIZER } from './messages/tokens';
import { InputNormalizer } from './input-normalizer.service';
import { ResponseBuilder } from './response-builder.service';

/**
 * Coordinates the orchestration pipeline, connecting memory, LangGraph, and response shaping.
 */
@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly graph: CompiledGraph;

  constructor(
    private readonly memoryService: MemoryService,
    private readonly graphFactory: GraphFactory,
    private readonly historyBuilder: HistoryBuilderService,
    private readonly generatedMessagePersister: GeneratedMessagePersisterService,
    private readonly commandRouter: CommandRouter,
    private readonly inputNormalizer: InputNormalizer,
    private readonly responseBuilder: ResponseBuilder,
    @Inject(MESSAGE_SERIALIZER)
    private readonly messageSerializer: MessageSerializer,
  ) {
    this.graph = this.graphFactory.build();
  }

  /**
   * Routes inbound events through the orchestration stack to produce an assistant reply.
   *
   * @param event Normalized transport event emitted by the ingress controller.
   * @returns Response ready to be delivered back to the transport adapter.
   */
  async handleEvent(event: NormalizedEventDto): Promise<AgentResponseDto> {
    if (event.type === 'command' && event.text) {
      return this.commandRouter.handle(event);
    }

    const userContent = this.inputNormalizer.toText(event);

    await this.memoryService.pushMessage(event.chatId, {
      role: 'user',
      content: userContent,
      meta: this.inputNormalizer.userMeta(event),
    });

    const window = await this.memoryService.getWindow(event.chatId);
    const history = this.historyBuilder.buildHistory(window);
    const initialLength = history.length;

    this.logger.debug(
      `Invoking LangGraph for chat ${event.chatId} (history=${history.length}, window=${window.length})`,
    );

    const result = await this.graph.invoke(
      { messages: history },
      { configurable: { chatId: event.chatId } },
    );

    const rawMessages = Array.isArray(result.messages) ? result.messages : [];
    const messages = rawMessages.filter((message): message is BaseMessage =>
      isBaseMessage(message),
    );
    const generatedIndex = initialLength;
    const generatedMessages = messages.slice(generatedIndex);

    this.logger.debug(
      `LangGraph produced ${generatedMessages.length} message(s) for chat ${event.chatId}${
        generatedMessages.length
          ? `: ${generatedMessages
              .map((msg) => this.messageSerializer.describeMessageForLog(msg))
              .join(', ')}`
          : ''
      }`,
    );

    await this.generatedMessagePersister.persistGeneratedMessages(
      event.chatId,
      generatedMessages,
    );

    if (!messages.some((message) => isAIMessage(message))) {
      this.logger.warn('LangGraph completed without an assistant response');
    }

    return this.responseBuilder.build(event.chatId, messages, generatedIndex);
  }
}
