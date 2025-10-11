import { Module } from '@nestjs/common';
import { GraphFactory } from './graph.factory';
import { PlannerNode } from './nodes/planner.node';
import { ToolRouterNode } from './nodes/tool-router.node';

@Module({
  providers: [GraphFactory, PlannerNode, ToolRouterNode],
  exports: [GraphFactory],
})
export class LanggraphModule {}
