import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { ToolsModule } from '../tools/tools.module';
import { CommonModule } from '../common/common.module';
import { CommandRouter } from './command-router.service';
import { InputNormalizer } from './input-normalizer.service';
import { LanggraphModule } from './langgraph/langgraph.module';
import { MessagesModule } from './messages/messages.module';
import { OrchestratorService } from './orchestrator.service';
import { ResponseBuilder } from './response-builder.service';
import { ConversationStore } from './conversation/conversation-store';
import { TranscriptAssembler } from './conversation/transcript-assembler';
import { TranscriptPersister } from './conversation/transcript-persister';
import { ResponseComposer } from './conversation/response-composer';

@Module({
  imports: [
    CommonModule,
    LanggraphModule,
    MemoryModule,
    ToolsModule,
    MessagesModule,
  ],
  providers: [
    OrchestratorService,
    CommandRouter,
    InputNormalizer,
    ResponseBuilder,
    ConversationStore,
    TranscriptAssembler,
    TranscriptPersister,
    ResponseComposer,
  ],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}
