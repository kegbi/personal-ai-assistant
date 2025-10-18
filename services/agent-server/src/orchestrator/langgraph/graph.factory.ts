import { Injectable } from '@nestjs/common';
import {
  MessagesAnnotation,
  START,
  END,
  StateGraph,
  MemorySaver,
} from '@langchain/langgraph';
import { PlannerNode } from './nodes/planner.node';
import { ToolRouterNode } from './nodes/tool-router.node';
import { AppConfigService } from '../../config/config.service';

export type CompiledGraph = ReturnType<
  StateGraph<typeof MessagesAnnotation>['compile']
>;

@Injectable()
export class GraphFactory {
  private compiledGraph: CompiledGraph | null = null;
  private compiledWithCheckpointer: boolean | null = null;

  constructor(
    private readonly plannerNode: PlannerNode,
    private readonly toolRouterNode: ToolRouterNode,
    private readonly configService: AppConfigService,
  ) {}

  build(): CompiledGraph {
    const enableCheckpointer = this.configService.features.enableCheckpointer;

    if (
      !this.compiledGraph ||
      this.compiledWithCheckpointer !== enableCheckpointer
    ) {
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

      this.compiledGraph = enableCheckpointer
        ? (workflow.compile({
            checkpointer: new MemorySaver(),
          }) as unknown as CompiledGraph)
        : (workflow.compile() as unknown as CompiledGraph);
      this.compiledWithCheckpointer = enableCheckpointer;
    }

    return this.compiledGraph;
  }
}
