import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { OrchestratorService } from '../../orchestrator/orchestrator.service';
import { AgentResponseDto } from '../../transport/dto/agent-response.dto';
import { MessageReceivedDto } from '../../transport/dto/message-received.dto';
import { NormalizedEventDto } from './dto/normalized-event.dto';
import { BearerGuard } from './guards/bearer.guard';

/**
 * Handles transport-facing webhook events and forwards them to the orchestrator.
 */
@UseGuards(BearerGuard)
@Controller('events')
export class EventsController {
  constructor(private readonly orchestratorService: OrchestratorService) {}

  /**
   * Receives a normalized transport event and adapts it to the orchestrator contract.
   *
   * @param event Normalized event payload supplied by a transport adapter.
   * @returns Response produced by the orchestrator.
   */
  @Post()
  async post(@Body() event: NormalizedEventDto): Promise<AgentResponseDto> {
    const commandCandidate = (event.text ?? '').trim().split(' ')[0] ?? '';
    const legacyPayload: MessageReceivedDto = {
      chatId: event.chatId,
      userId: event.userId ?? event.chatId,
      text: event.text,
      voiceUrl: event.voiceUrl,
      isCommand: event.type === 'command',
      command:
        event.type === 'command' && commandCandidate.length > 0
          ? commandCandidate
          : undefined,
      payload: {
        ...(event.payload ?? {}),
        connectorId: event.connectorId,
        eventType: event.type,
        idempotencyKey: event.idempotencyKey,
      },
    };

    return this.orchestratorService.handleEvent(legacyPayload);
  }
}
