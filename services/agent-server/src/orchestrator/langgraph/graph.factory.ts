import { Inject, Injectable, Optional } from '@nestjs/common';
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
import {
  CHECKPOINTER_STRATEGY,
  type CheckpointerStrategy,
} from '../graph/checkpointer-strategy';

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
    @Optional()
    @Inject(CHECKPOINTER_STRATEGY)
    private readonly checkpointerStrategy?: CheckpointerStrategy,
  ) {}

  build(): CompiledGraph {
    const enableCheckpointer =
      this.checkpointerStrategy?.isEnabled() ??
      this.configService.features.enableCheckpointer;

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
