import { Module } from '@nestjs/common';
import { LanggraphModule } from './langgraph/langgraph.module';
import { MemoryModule } from '../memory/memory.module';
import { ToolsModule } from '../tools/tools.module';
import { OrchestratorService } from './orchestrator.service';
import { HistoryBuilderService } from './messages/history-builder.service';
import { GeneratedMessagePersisterService } from './messages/generated-message-persister.service';
import { MessageTransformerService } from './messages/message-transformer.service';

@Module({
  imports: [LanggraphModule, MemoryModule, ToolsModule],
  providers: [
    OrchestratorService,
    HistoryBuilderService,
    GeneratedMessagePersisterService,
    MessageTransformerService,
  ],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}
