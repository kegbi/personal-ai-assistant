import { Module } from '@nestjs/common';
import { EventsController } from '../api/transport/events.controller';
import { EventsStreamController } from '../api/transport/events-stream.controller';
import { BearerGuard } from '../api/transport/guards/bearer.guard';
import { CommonModule } from '../common/common.module';
import { RateLimitGuard } from '../common/rate-limit.guard';
import { MemoryModule } from '../memory/memory.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';

@Module({
  imports: [OrchestratorModule, CommonModule, MemoryModule],
  controllers: [EventsController, EventsStreamController],
  providers: [BearerGuard, RateLimitGuard],
})
export class TransportModule {}
