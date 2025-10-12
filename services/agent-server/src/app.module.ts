import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { TransportModule } from './transport/transport.module';
import { OrchestratorModule } from './orchestrator/orchestrator.module';
import { MemoryModule } from './memory/memory.module';
import { ToolsModule } from './tools/tools.module';
import { RemindersModule } from './api/reminders/reminders.module';
import { CommonModule } from './common/common.module';

@Module({
  imports: [
    ConfigModule,
    CommonModule,
    HealthModule,
    TransportModule,
    OrchestratorModule,
    MemoryModule,
    ToolsModule,
    RemindersModule,
  ],
})
export class AppModule {}
