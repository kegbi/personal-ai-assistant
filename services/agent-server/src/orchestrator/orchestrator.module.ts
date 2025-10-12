import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { ToolsModule } from '../tools/tools.module';
import { LanggraphModule } from './langgraph/langgraph.module';
import { MessagesModule } from './messages/messages.module';
import { OrchestratorService } from './orchestrator.service';

@Module({
  imports: [LanggraphModule, MemoryModule, ToolsModule, MessagesModule],
  providers: [OrchestratorService],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}
