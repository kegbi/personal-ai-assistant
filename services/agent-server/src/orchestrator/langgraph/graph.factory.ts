import { Injectable } from '@nestjs/common';
import { PlannerNode } from './nodes/planner.node';
import { ToolRouterNode } from './nodes/tool-router.node';

@Injectable()
export class GraphFactory {
  constructor(
    private readonly plannerNode: PlannerNode,
    private readonly toolRouterNode: ToolRouterNode,
  ) {}

  // TODO: build LangGraph flows once nodes are implemented
  build(): unknown {
    void this.plannerNode;
    void this.toolRouterNode;
    return null;
  }
}
