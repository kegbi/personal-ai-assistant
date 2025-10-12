import { Injectable, Logger } from '@nestjs/common';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  isAIMessage,
  isToolMessage,
} from '@langchain/core/messages';
import type { MemoryMessage } from '../../memory/memory.service';
import type { MessageSerializer } from './interfaces/message-serializer';
import type { ToolInvocationMeta } from './types/tool-invocation-meta';
import { AssistantMessageHydrator } from './transformers/assistant-message.hydrator';
import { ToolMessageHydrator } from './transformers/tool-message.hydrator';
import { cloneValue, isRecord } from './utils/message-structure.utils';

/**
 * Bridges between stored memory messages and LangChain message primitives.
 * Delegates most hydration logic to specialized transformers while offering
 * a concise serialization surface for the orchestrator layer.
 */
@Injectable()
export class MessageTransformerService implements MessageSerializer {
  private readonly logger = new Logger(MessageTransformerService.name);

  constructor(
    private readonly assistantHydrator: AssistantMessageHydrator,
    private readonly toolHydrator: ToolMessageHydrator,
  ) {}

  /**
   * Reconstructs a LangChain message based on stored memory state.
   *
   * @param memoryMessage Stored conversation entry pulled from Redis.
   * @returns The hydrated LangChain message that can be replayed to the model.
   */
  toBaseMessage(memoryMessage: MemoryMessage): BaseMessage {
    const content = memoryMessage.content ?? '';
    const meta = memoryMessage.meta;

    if (memoryMessage.role === 'tool') {
      const toolMessage = this.toolHydrator.rehydrate(content, meta);
      if (toolMessage) {
        return toolMessage;
      }

      this.logger.warn(
        'Tool memory message missing toolCallId; falling back to system role',
      );
      return this.toolHydrator.createSystemMessageFromRaw(content, meta);
    }

    if (memoryMessage.role === 'assistant') {
      return this.assistantHydrator.rehydrate(content, memoryMessage);
    }

    if (
      memoryMessage.role === 'system' &&
      this.toolHydrator.looksLikeLegacyToolMeta(meta)
    ) {
      const toolContent = this.toolHydrator.extractLegacyToolContent(
        content,
        meta,
      );
      const legacyToolMessage = this.toolHydrator.rehydrate(toolContent, meta);
      if (legacyToolMessage) {
        return legacyToolMessage;
      }

      this.logger.warn(
        'Legacy tool memory message missing toolCallId; keeping as system message',
      );
    }

    if (memoryMessage.role === 'system') {
      return new SystemMessage({
        content,
        additional_kwargs: meta ?? {},
      });
    }

    return new HumanMessage({
      content,
      additional_kwargs: meta ?? {},
    });
  }

  /**
   * Converts a generated LangChain message back into the memory persistence shape.
   *
   * @param message Message emitted by LangGraph during a run.
   * @returns A serialisable memory entry or `null` when the message should be skipped.
   */
  fromBaseMessage(message: BaseMessage): MemoryMessage | null {
    if (isAIMessage(message)) {
      const toolCalls = this.assistantHydrator.normalizeToolCalls(
        message.tool_calls,
      );
      const meta = this.assistantHydrator.buildPersistenceMeta(
        message,
        toolCalls,
      );
      const memoryMessage: MemoryMessage = {
        role: 'assistant',
        content: this.extractMessageContent(message),
        meta,
      };

      if (toolCalls && toolCalls.length > 0) {
        memoryMessage.toolCalls = toolCalls;
      }

      return memoryMessage;
    }

    if (isToolMessage(message)) {
      const toolName = message.name ?? 'tool_call';
      const meta: Record<string, unknown> = {
        tool: toolName,
        name: toolName,
        toolCallId: message.tool_call_id,
        tool_call_id: message.tool_call_id,
        content: message.content,
      };

      if (
        message.additional_kwargs &&
        Object.keys(message.additional_kwargs).length > 0
      ) {
        meta.additional_kwargs = cloneValue(message.additional_kwargs);
      }

      return {
        role: 'tool',
        content: this.extractMessageContent(message),
        meta,
      };
    }

    return null;
  }

  /**
   * Extracts a plain-text representation for mixed content AI or tool messages.
   *
   * @param message LangChain AI or tool message that may contain structured parts.
   * @returns Plain text suitable for logging, storage, or prompt replay.
   */
  extractMessageContent(message: AIMessage | ToolMessage): string {
    if (typeof message.content === 'string') {
      return message.content;
    }

    const parts = Array.isArray(message.content)
      ? message.content
      : [message.content];

    const rendered = parts
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }

        if (this.isTextPart(part)) {
          return part.text;
        }

        return JSON.stringify(part);
      })
      .join('\n')
      .trim();

    return rendered;
  }

  /**
   * Finds metadata about the last tool call in a batch of messages.
   *
   * @param messages Ordered LangGraph transcript to scan.
   * @returns Tool invocation info if a tool message is present; otherwise `null`.
   */
  extractToolMeta(messages: BaseMessage[]): ToolInvocationMeta | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (!isToolMessage(candidate)) {
        continue;
      }

      return this.buildToolMeta(candidate);
    }

    return null;
  }

  /**
   * Provides a concise description of a message for structured logging.
   *
   * @param message Message to describe.
   * @returns Short string describing the message type and tool-call counts.
   */
  describeMessageForLog(message: BaseMessage): string {
    const type = message._getType();

    if (
      isAIMessage(message) &&
      message.tool_calls &&
      message.tool_calls.length > 0
    ) {
      return `${type} (toolCalls=${message.tool_calls.length})`;
    }

    if (isToolMessage(message)) {
      return `${type} (toolCallId=${message.tool_call_id ?? 'unknown'})`;
    }

    return type;
  }

  /**
   * Indicates whether a memory message already contains cached tool call data.
   *
   * @param memoryMessage Memory record to inspect.
   * @returns True when tool call details are already available.
   */
  hasToolCalls(memoryMessage: MemoryMessage): boolean {
    return this.assistantHydrator.hasToolCalls(memoryMessage);
  }

  /**
   * Determines whether a tool response corresponds to a preceding assistant tool call.
   *
   * @param assistant The assistant message that may contain tool calls.
   * @param tool Tool response to validate.
   * @returns True when the tool response references one of the assistant tool call IDs.
   */
  toolCallMatches(assistant: AIMessage, tool: ToolMessage): boolean {
    return this.assistantHydrator.toolCallMatches(assistant, tool);
  }

  /**
   * Creates a fallback system message to preserve orphaned tool output in chat history.
   *
   * @param toolMessage Tool message that could not be matched to a tool call.
   * @returns System message containing the tool content.
   */
  createFallbackSystemMessage(toolMessage: ToolMessage): SystemMessage {
    const fallbackMeta = this.toolHydrator.buildFallbackMeta(toolMessage);
    return new SystemMessage({
      content: this.extractMessageContent(toolMessage),
      additional_kwargs: fallbackMeta,
    });
  }

  private buildToolMeta(toolMessage: ToolMessage): ToolInvocationMeta {
    if (
      toolMessage.additional_kwargs &&
      Object.keys(toolMessage.additional_kwargs).length > 0
    ) {
      return {
        name: toolMessage.name ?? 'tool_call',
        args: cloneValue(toolMessage.additional_kwargs),
      };
    }

    if (typeof toolMessage.content === 'string') {
      return {
        name: toolMessage.name ?? 'tool_call',
        args: {
          result: toolMessage.content,
        },
      };
    }

    return {
      name: toolMessage.name ?? 'tool_call',
      args: {
        result: cloneValue(toolMessage.content),
      },
    };
  }

  private isTextPart(part: unknown): part is { text: string } {
    return isRecord(part) && typeof part.text === 'string';
  }
}
