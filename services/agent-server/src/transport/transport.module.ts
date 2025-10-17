import { Module } from '@nestjs/common';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { EventsController } from '../api/transport/events.controller';
import { BearerGuard } from '../api/transport/guards/bearer.guard';

@Module({
  imports: [OrchestratorModule],
  controllers: [EventsController],
  providers: [BearerGuard],
})
export class TransportModule {}
