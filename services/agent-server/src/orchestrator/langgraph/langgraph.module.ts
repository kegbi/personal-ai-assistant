import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { MemoryModule } from '../../memory/memory.module';
import { ToolsModule } from '../../tools/tools.module';
import { GraphFactory } from './graph.factory';
import { PlannerNode } from './nodes/planner.node';
import { ToolRouterNode } from './nodes/tool-router.node';
import { AppConfigService } from '../../config/config.service';
import {
  CHECKPOINTER_STRATEGY,
  type CheckpointerStrategy,
} from '../graph/checkpointer-strategy';

@Module({
  imports: [ConfigModule, MemoryModule, ToolsModule],
  providers: [
    GraphFactory,
    PlannerNode,
    ToolRouterNode,
    {
      provide: CHECKPOINTER_STRATEGY,
      useFactory: (config: AppConfigService): CheckpointerStrategy => ({
        isEnabled: () => config.features.enableCheckpointer === true,
      }),
      inject: [AppConfigService],
    },
  ],
  exports: [GraphFactory, CHECKPOINTER_STRATEGY],
})
export class LanggraphModule {}
