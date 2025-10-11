import { Module } from '@nestjs/common';
import { LanggraphModule } from './langgraph/langgraph.module';
import { OrchestratorService } from './orchestrator.service';
import { MemoryModule } from '../memory/memory.module';
import { ToolsModule } from '../tools/tools.module';

@Module({
  imports: [LanggraphModule, MemoryModule, ToolsModule],
  providers: [OrchestratorService],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}
