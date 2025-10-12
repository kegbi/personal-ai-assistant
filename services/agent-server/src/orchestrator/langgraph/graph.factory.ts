import { Injectable } from '@nestjs/common';
import { MessagesAnnotation, START, END, StateGraph } from '@langchain/langgraph';
import { PlannerNode } from './nodes/planner.node';
import { ToolRouterNode } from './nodes/tool-router.node';

export type CompiledGraph = ReturnType<
  StateGraph<typeof MessagesAnnotation>['compile']
>;

@Injectable()
export class GraphFactory {
  private compiledGraph: CompiledGraph | null = null;

  constructor(
    private readonly plannerNode: PlannerNode,
    private readonly toolRouterNode: ToolRouterNode,
  ) {}

  build(): CompiledGraph {
    if (!this.compiledGraph) {
      const workflow = new StateGraph(MessagesAnnotation)
        .addNode('planner', (state, config) =>
          this.plannerNode.execute(state, config),
        )
        .addNode('tool-router', (state, config) =>
          this.toolRouterNode.execute(state, config),
        )
        .addEdge(START, 'planner')
        .addConditionalEdges(
          'planner',
          (state) => this.plannerNode.determineNext(state),
          {
            tool: 'tool-router',
            respond: END,
          },
        )
        .addEdge('tool-router', 'planner');

      this.compiledGraph = workflow.compile() as unknown as CompiledGraph;
    }

    return this.compiledGraph as CompiledGraph;
  }
}
