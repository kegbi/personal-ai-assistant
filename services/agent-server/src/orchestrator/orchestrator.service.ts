import { Injectable } from '@nestjs/common';
import { MessageReceivedDto } from '../transport/dto/message-received.dto';
import { AgentResponseDto } from '../transport/dto/agent-response.dto';
import { MemoryService } from '../memory/memory.service';
import { GraphFactory } from './langgraph/graph.factory';

@Injectable()
export class OrchestratorService {
  constructor(
    private readonly memoryService: MemoryService,
    private readonly graphFactory: GraphFactory,
  ) {}

  // TODO: orchestrate conversation using LangGraph and memory
  async handleEvent(message: MessageReceivedDto): Promise<AgentResponseDto> {
    await this.memoryService.pushMessage(message.chatId, {
      role: 'user',
      content: message.text,
    });

    const graph = this.graphFactory.build();
    void graph; // placeholder until graph is used

    return {
      chatId: message.chatId,
      text: 'Orchestrator not implemented yet',
    };
  }
}
