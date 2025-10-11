import { Body, Controller, Post } from '@nestjs/common';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { MessageReceivedDto } from './dto/message-received.dto';
import { AgentResponseDto } from './dto/agent-response.dto';

@Controller('events')
export class TransportController {
  constructor(private readonly orchestratorService: OrchestratorService) {}

  @Post()
  async handleEvent(
    @Body() payload: MessageReceivedDto,
  ): Promise<AgentResponseDto> {
    return this.orchestratorService.handleEvent(payload);
  }
}
