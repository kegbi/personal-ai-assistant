import type {
  AIMessage,
  BaseMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { MemoryMessage } from '../../../memory/memory.service';
import type { ToolInvocationMeta } from '../types/tool-invocation-meta';

/**
 * Contract describing bidirectional conversion between stored memory records and LangChain messages.
 */
export interface MessageSerializer {
  toBaseMessage(memoryMessage: MemoryMessage): BaseMessage;
  fromBaseMessage(message: BaseMessage): MemoryMessage | null;
  extractMessageContent(message: AIMessage | ToolMessage): string;
  extractToolMeta(messages: BaseMessage[]): ToolInvocationMeta | null;
  describeMessageForLog(message: BaseMessage): string;
  hasToolCalls(memoryMessage: MemoryMessage): boolean;
  toolCallMatches(assistant: AIMessage, tool: ToolMessage): boolean;
  createFallbackSystemMessage(toolMessage: ToolMessage): SystemMessage;
}
