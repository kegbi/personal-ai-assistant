import { Module } from '@nestjs/common';
import { EventsController } from '../api/transport/events.controller';
import { EventsStreamController } from '../api/transport/events-stream.controller';
import { BearerGuard } from '../api/transport/guards/bearer.guard';
import { CommonModule } from '../common/common.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';

@Module({
  imports: [OrchestratorModule, CommonModule],
  controllers: [EventsController, EventsStreamController],
  providers: [BearerGuard],
})
export class TransportModule {}
