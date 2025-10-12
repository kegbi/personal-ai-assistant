import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { MemoryModule } from '../../memory/memory.module';
import { ToolsModule } from '../../tools/tools.module';
import { GraphFactory } from './graph.factory';
import { PlannerNode } from './nodes/planner.node';
import { ToolRouterNode } from './nodes/tool-router.node';

@Module({
  imports: [ConfigModule, MemoryModule, ToolsModule],
  providers: [GraphFactory, PlannerNode, ToolRouterNode],
  exports: [GraphFactory],
})
export class LanggraphModule {}
