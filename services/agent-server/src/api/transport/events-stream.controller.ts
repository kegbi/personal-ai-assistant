import { Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AppConfigService } from '../../config/config.service';
import { OrchestratorService } from '../../orchestrator/orchestrator.service';
import { NormalizedEventDto } from './dto/normalized-event.dto';
import { BearerGuard } from './guards/bearer.guard';
import type { AgentStreamEvent } from '../../transport/dto/agent-stream-event.dto';

const NDJSON_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8';

@UseGuards(BearerGuard)
@Controller('events')
export class EventsStreamController {
  constructor(
    private readonly configService: AppConfigService,
    private readonly orchestratorService: OrchestratorService,
  ) {}

  /**
   * Streams LangGraph output as NDJSON lines for improved UX in adapters.
   *
   * @param event Normalized inbound transport event.
   * @param response Express response used to flush NDJSON chunks.
   */
  @Post('stream')
  async stream(
    @Body() event: NormalizedEventDto,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Content-Type', NDJSON_CONTENT_TYPE);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Transfer-Encoding', 'chunked');

    const write = (payload: AgentStreamEvent): void => {
      response.write(`${JSON.stringify(payload)}\n`);
    };

    write({ type: 'start' });

    try {
      if (!this.configService.features.enableStreaming) {
        const result = await this.orchestratorService.handleEvent(event);
        write({
          type: 'final',
          text: result.text,
          meta: result.meta,
        });
        response.end();
        return;
      }

      for await (const chunk of this.orchestratorService.streamEvent(event)) {
        write(chunk);
      }

      response.end();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error ?? 'Unknown error');
      write({
        type: 'error',
        message,
      });
      response.end();
    }
  }
}
