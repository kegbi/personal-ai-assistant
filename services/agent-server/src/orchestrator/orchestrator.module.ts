import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { ToolsModule } from '../tools/tools.module';
import { CommandRouter } from './command-router.service';
import { InputNormalizer } from './input-normalizer.service';
import { LanggraphModule } from './langgraph/langgraph.module';
import { MessagesModule } from './messages/messages.module';
import { OrchestratorService } from './orchestrator.service';
import { ResponseBuilder } from './response-builder.service';

@Module({
  imports: [LanggraphModule, MemoryModule, ToolsModule, MessagesModule],
  providers: [
    OrchestratorService,
    CommandRouter,
    InputNormalizer,
    ResponseBuilder,
  ],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}
