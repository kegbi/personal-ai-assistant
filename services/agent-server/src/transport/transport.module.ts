import { Module } from '@nestjs/common';
import { TransportController } from './transport.controller';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';

@Module({
  imports: [OrchestratorModule],
  controllers: [TransportController],
})
export class TransportModule {}
