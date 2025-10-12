import { Module } from '@nestjs/common';
import { MemoryModule } from '../../memory/memory.module';
import { GeneratedMessagePersisterService } from './generated-message-persister.service';
import { HistoryBuilderService } from './history-builder.service';
import { AssistantMessageHydrator } from './transformers/assistant-message.hydrator';
import { ToolMessageHydrator } from './transformers/tool-message.hydrator';
import { MESSAGE_SERIALIZER } from './tokens';
import { MessageTransformerService } from './message-transformer.service';

/**
 * Aggregates message transformation providers and exposes a serialisation contract to the orchestrator.
 */
@Module({
  imports: [MemoryModule],
  providers: [
    AssistantMessageHydrator,
    ToolMessageHydrator,
    MessageTransformerService,
    HistoryBuilderService,
    GeneratedMessagePersisterService,
    {
      provide: MESSAGE_SERIALIZER,
      useExisting: MessageTransformerService,
    },
  ],
  exports: [
    HistoryBuilderService,
    GeneratedMessagePersisterService,
    MESSAGE_SERIALIZER,
  ],
})
export class MessagesModule {}
