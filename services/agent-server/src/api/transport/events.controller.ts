import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AppConfigService } from '../../config/config.service';
import { IdempotencyService } from '../../common/idempotency.service';
import { buildThreadKey } from '../../common/keys.util';
import { OrchestratorService } from '../../orchestrator/orchestrator.service';
import { AgentResponseDto } from '../../transport/dto/agent-response.dto';
import { MessageReceivedDto } from '../../transport/dto/message-received.dto';
import { NormalizedEventDto } from './dto/normalized-event.dto';
import { BearerGuard } from './guards/bearer.guard';

const DUPLICATE_IN_PROGRESS_MESSAGE = 'Processing duplicate, please wait…';

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isAgentResponseMeta = (value: unknown): boolean => {
  if (!isPlainRecord(value)) {
    return false;
  }

  const tool = value.tool;
  if (tool !== undefined && typeof tool !== 'string') {
    return false;
  }

  const args = value.args;
  if (args !== undefined && !isPlainRecord(args)) {
    return false;
  }

  const elapsed = value.elapsedMs;
  if (
    elapsed !== undefined &&
    (typeof elapsed !== 'number' || !Number.isFinite(elapsed))
  ) {
    return false;
  }

  return true;
};

const isAgentResponseDto = (value: unknown): value is AgentResponseDto => {
  if (!isPlainRecord(value)) {
    return false;
  }

  if (typeof value.chatId !== 'string' || typeof value.text !== 'string') {
    return false;
  }

  if (
    'meta' in value &&
    value.meta !== undefined &&
    !isAgentResponseMeta(value.meta)
  ) {
    return false;
  }

  return true;
};

/**
 * Handles transport-facing webhook events and forwards them to the orchestrator.
 */
@UseGuards(BearerGuard)
@Controller('events')
export class EventsController {
  constructor(
    private readonly orchestratorService: OrchestratorService,
    private readonly configService: AppConfigService,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  /**
   * Receives a normalized transport event and adapts it to the orchestrator contract.
   *
   * @param event Normalized event payload supplied by a transport adapter.
   * @returns Response produced by the orchestrator.
   */
  @Post()
  async post(@Body() event: NormalizedEventDto): Promise<AgentResponseDto> {
    const idempotencyKey = this.resolveIdempotencyKey(event);
    const idempotencyEnabled =
      this.configService.features.enableIdempotency &&
      idempotencyKey !== undefined;

    if (idempotencyEnabled && idempotencyKey !== undefined) {
      const threadKey = buildThreadKey(event.connectorId, event.chatId);

      const cachedResponse = await this.idempotencyService.getResponse(
        threadKey,
        idempotencyKey,
      );

      if (isAgentResponseDto(cachedResponse)) {
        return cachedResponse;
      }

      const acquired = await this.idempotencyService.tryStart(
        threadKey,
        idempotencyKey,
      );

      if (!acquired) {
        const retryResponse = await this.idempotencyService.getResponse(
          threadKey,
          idempotencyKey,
        );

        if (isAgentResponseDto(retryResponse)) {
          return retryResponse;
        }

        return this.buildDuplicateInProgressResponse(event.chatId);
      }

      const response = await this.orchestratorService.handleEvent(
        this.toLegacyPayload(event),
      );

      await this.idempotencyService.storeResponse(
        threadKey,
        idempotencyKey,
        response,
      );

      return response;
    }

    return this.orchestratorService.handleEvent(this.toLegacyPayload(event));
  }

  /**
   * Builds the legacy transport DTO expected by the orchestrator.
   *
   * @param event Normalized transport event supplied to the controller.
   * @returns MessageReceivedDto representing the legacy payload.
   */
  private toLegacyPayload(event: NormalizedEventDto): MessageReceivedDto {
    const commandCandidate = (event.text ?? '').trim().split(' ')[0] ?? '';
    const isCommand = event.type === 'command';
    const command =
      isCommand && commandCandidate.length > 0 ? commandCandidate : undefined;

    return {
      chatId: event.chatId,
      userId: event.userId ?? event.chatId,
      text: event.text,
      voiceUrl: event.voiceUrl,
      isCommand,
      command,
      payload: {
        ...(event.payload ?? {}),
        connectorId: event.connectorId,
        eventType: event.type,
        idempotencyKey: event.idempotencyKey,
      },
    };
  }

  /**
   * Determines whether an idempotency key is present and valid.
   *
   * @param event Incoming normalized event.
   * @returns Idempotency key when provided; otherwise undefined.
   */
  private resolveIdempotencyKey(event: NormalizedEventDto): string | undefined {
    if (
      typeof event.idempotencyKey === 'string' &&
      event.idempotencyKey.length > 0
    ) {
      return event.idempotencyKey;
    }

    return undefined;
  }

  /**
   * Builds a default response informing the caller that duplicate processing is ongoing.
   *
   * @param chatId Chat identifier associated with the event.
   * @returns Minimal response delivered while the original request finishes.
   */
  private buildDuplicateInProgressResponse(chatId: string): AgentResponseDto {
    return {
      chatId,
      text: DUPLICATE_IN_PROGRESS_MESSAGE,
    };
  }
}
