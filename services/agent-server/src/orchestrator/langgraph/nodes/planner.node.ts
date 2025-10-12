import { Injectable, Logger } from '@nestjs/common';
import { MessagesAnnotation } from '@langchain/langgraph';
import { AIMessage, BaseMessage, isAIMessage } from '@langchain/core/messages';
import type { Runnable, RunnableConfig } from '@langchain/core/runnables';
import { ChatOpenAI } from '@langchain/openai';
import { AppConfigService } from '../../../config/config.service';
import { ToolRouterNode } from './tool-router.node';

@Injectable()
export class PlannerNode {
  private readonly logger = new Logger(PlannerNode.name);
  private cachedModel?: Runnable<BaseMessage[], AIMessage>;

  constructor(
    private readonly config: AppConfigService,
    private readonly toolRouterNode: ToolRouterNode,
  ) {}

  private buildModel(): Runnable<BaseMessage[], AIMessage> | null {
    if (!this.config.ai.apiKey) {
      return null;
    }

    if (!this.cachedModel) {
      const model = new ChatOpenAI({
        apiKey: this.config.ai.apiKey,
        model: this.config.ai.model,
      });

      this.cachedModel = model.bindTools(this.toolRouterNode.tools);
    }

    return this.cachedModel;
  }

  async execute(
    state: typeof MessagesAnnotation.State,
    config?: RunnableConfig,
  ): Promise<Partial<typeof MessagesAnnotation.State>> {
    const model = this.buildModel();

    if (!model) {
      this.logger.warn('Planner invoked without an AI API key');
      return {
        messages: [
          new AIMessage(
            'LLM capabilities are not configured yet. Please set OPENAI_API_KEY to enable reasoning.',
          ),
        ],
      };
    }

    try {
      const response = await model.invoke(state.messages, config);
      return { messages: [response] };
    } catch (error) {
      this.logger.error(
        'Planner failed to invoke the language model',
        error instanceof Error ? error.stack : String(error),
      );
      return {
        messages: [
          new AIMessage(
            'I ran into an error while thinking about that. Please try again shortly.',
          ),
        ],
      };
    }
  }

  determineNext(
    state: typeof MessagesAnnotation.State,
  ): 'tool' | 'respond' {
    const lastMessage = state.messages[state.messages.length - 1];

    if (isAIMessage(lastMessage) && lastMessage.tool_calls?.length) {
      return 'tool';
    }

    return 'respond';
  }
}
