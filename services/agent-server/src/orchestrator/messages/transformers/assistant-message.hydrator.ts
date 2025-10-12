import { Injectable, Logger } from '@nestjs/common';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import {
  cloneValue,
  extractTrimmedString,
  isRecord,
} from '../utils/message-structure.utils';
import type { MemoryMessage } from '../../../memory/memory.service';

interface NormalizedAssistantMeta {
  readonly sanitizedMeta?: Record<string, unknown>;
  readonly toolCalls?: ToolCall[];
  readonly responseMetadata?: Record<string, unknown>;
}

/**
 * Restores and serialises assistant messages, normalising tool-call metadata across legacy shapes.
 */
@Injectable()
export class AssistantMessageHydrator {
  private readonly logger = new Logger(AssistantMessageHydrator.name);

  /**
   * Recreates an assistant LangChain message based on the stored memory entry.
   *
   * @param content Assistant text content retrieved from memory.
   * @param memoryMessage Source memory record containing tool-call metadata.
   * @returns Hydrated AI message ready for LangGraph replay.
   */
  rehydrate(content: string, memoryMessage: MemoryMessage): AIMessage {
    const assistantMeta = memoryMessage.meta;
    const fallbackToolCalls = memoryMessage.toolCalls;
    const { sanitizedMeta, toolCalls, responseMetadata } =
      this.splitAssistantMeta(assistantMeta, fallbackToolCalls);

    const fields: {
      content: string;
      additional_kwargs?: Record<string, unknown>;
      tool_calls?: ToolCall[];
      response_metadata?: Record<string, unknown>;
    } = {
      content,
    };

    if (sanitizedMeta) {
      fields.additional_kwargs = sanitizedMeta;
    }

    if (toolCalls) {
      fields.tool_calls = toolCalls;
    }

    if (responseMetadata) {
      fields.response_metadata = responseMetadata;
    }

    const aiMessage = new AIMessage(fields);

    if (toolCalls && toolCalls.length > 0) {
      this.logger.debug(
        `Rehydrated assistant tool-calling message (toolCalls=${toolCalls.length})`,
      );
    }

    return aiMessage;
  }

  /**
   * Builds the metadata payload to persist alongside an assistant response.
   *
   * @param message Freshly generated assistant message.
   * @param toolCalls Optional tool-call annotations associated with the response.
   * @returns Metadata ready for persistence when non-empty.
   */
  buildPersistenceMeta(
    message: AIMessage,
    toolCalls?: ToolCall[],
  ): Record<string, unknown> | undefined {
    const meta: Record<string, unknown> = {};

    if (
      message.additional_kwargs &&
      Object.keys(message.additional_kwargs).length > 0
    ) {
      const clonedAdditional = cloneValue(message.additional_kwargs);
      Object.assign(meta, clonedAdditional);
    }

    if (
      message.response_metadata &&
      Object.keys(message.response_metadata).length > 0
    ) {
      meta.response_metadata = cloneValue(message.response_metadata);
    }

    if (toolCalls && toolCalls.length > 0) {
      meta.tool_calls = toolCalls.map((toolCall) => cloneValue(toolCall));
    }

    return Object.keys(meta).length > 0 ? meta : undefined;
  }

  /**
   * Determines whether a memory message already carries persisted tool-call details.
   *
   * @param memoryMessage Memory record to evaluate.
   * @returns True when stored metadata or the message itself include tool calls.
   */
  hasToolCalls(memoryMessage: MemoryMessage): boolean {
    if (memoryMessage.toolCalls && memoryMessage.toolCalls.length > 0) {
      return true;
    }

    const meta = memoryMessage.meta;
    if (!meta || !isRecord(meta)) {
      return false;
    }

    if (
      this.normalizeToolCalls(meta.tool_calls) ||
      this.normalizeToolCalls(meta.toolCalls)
    ) {
      return true;
    }

    return false;
  }

  /**
   * Verifies whether the provided tool response references one of the assistant tool call IDs.
   *
   * @param assistant Assistant message that may contain tool call references.
   * @param tool Tool response to validate.
   * @returns True when the tool response references a known tool call.
   */
  toolCallMatches(assistant: AIMessage, tool: ToolMessage): boolean {
    if (!assistant.tool_calls || assistant.tool_calls.length === 0) {
      return false;
    }

    if (!tool.tool_call_id) {
      return false;
    }

    return assistant.tool_calls.some((call) => {
      if (!call) {
        return false;
      }

      const identifier = call.id;
      return typeof identifier === 'string' && identifier === tool.tool_call_id;
    });
  }

  /**
   * Normalizes arbitrary data into LangChain-compatible tool calls.
   *
   * @param value Possible tool-call array.
   * @returns Normalized tool call array or `undefined` when conversion fails.
   */
  normalizeToolCalls(value: unknown): ToolCall[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const normalized: ToolCall[] = [];

    for (const item of value) {
      const toolCall = this.coerceToolCall(item);
      if (toolCall) {
        normalized.push(toolCall);
      }
    }

    return normalized.length > 0 ? normalized : undefined;
  }

  private splitAssistantMeta(
    meta: Record<string, unknown> | undefined,
    fallbackToolCalls: ToolCall[] | undefined,
  ): NormalizedAssistantMeta {
    let toolCalls = this.normalizeToolCalls(fallbackToolCalls);

    if (!meta || !isRecord(meta)) {
      return {
        sanitizedMeta: undefined,
        toolCalls,
        responseMetadata: undefined,
      };
    }

    const working = cloneValue(meta);

    const directToolCalls = this.normalizeToolCalls(working.tool_calls);
    if (directToolCalls) {
      toolCalls = directToolCalls;
      delete working.tool_calls;
    }

    const camelToolCalls = this.normalizeToolCalls(working.toolCalls);
    if (camelToolCalls) {
      toolCalls = camelToolCalls;
      delete working.toolCalls;
    }

    const responseMetadata = this.normalizeResponseMetadata(
      working.response_metadata,
    );
    if (responseMetadata) {
      delete working.response_metadata;
    }

    const sanitizedMeta = Object.keys(working).length > 0 ? working : undefined;

    return {
      sanitizedMeta,
      toolCalls,
      responseMetadata,
    };
  }

  private normalizeResponseMetadata(
    value: unknown,
  ): Record<string, unknown> | undefined {
    if (!isRecord(value)) {
      return undefined;
    }

    return cloneValue(value);
  }

  private coerceToolCall(candidate: unknown): ToolCall | null {
    if (!isRecord(candidate)) {
      return null;
    }

    const args = this.coerceToolArgs(candidate.args);
    if (!args) {
      return null;
    }

    const name = extractTrimmedString(candidate, 'name') ?? 'tool_call';

    const toolCall: ToolCall = {
      name,
      args,
    };

    const identifier = extractTrimmedString(candidate, 'id');
    if (identifier) {
      toolCall.id = identifier;
    }

    const type = extractTrimmedString(candidate, 'type');
    if (type === 'tool_call') {
      toolCall.type = 'tool_call';
    }

    return toolCall;
  }

  private coerceToolArgs(value: unknown): ToolCall['args'] | null {
    if (value === null || value === undefined) {
      return {};
    }

    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (isRecord(parsed)) {
          return this.cloneIntoArgs(parsed);
        }

        const args: ToolCall['args'] = {};
        args.raw = parsed;
        return args;
      } catch {
        const args: ToolCall['args'] = {};
        args.raw = value;
        return args;
      }
    }

    if (isRecord(value)) {
      return this.cloneIntoArgs(value);
    }

    const args: ToolCall['args'] = {};
    args.raw = value;
    return args;
  }

  private cloneIntoArgs(source: Record<string, unknown>): ToolCall['args'] {
    const target: ToolCall['args'] = {};
    for (const [key, rawValue] of Object.entries(source)) {
      // ToolCall args allow arbitrary payloads; clone to avoid mutating shared references.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      target[key] = cloneValue(rawValue);
    }

    return target;
  }
}
