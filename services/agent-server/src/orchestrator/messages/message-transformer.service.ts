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
import type { ToolCall } from '@langchain/core/messages/tool';
import { MemoryMessage } from '../../memory/memory.service';

export interface ToolInvocationMeta {
  name: string;
  args: Record<string, unknown>;
}

@Injectable()
export class MessageTransformerService {
  private readonly logger = new Logger(MessageTransformerService.name);

  /**
   * Reconstructs a LangChain message from an item we previously stored in memory.
   *
   * @param memoryMessage Stored conversation entry pulled from Redis.
   * @returns The hydrated LangChain message that can be replayed to the model.
   */
  toBaseMessage(memoryMessage: MemoryMessage): BaseMessage {
    const content = memoryMessage.content ?? '';
    const meta = memoryMessage.meta ?? undefined;

    if (memoryMessage.role === 'tool') {
      const toolMessage = this.rehydrateToolMessage(content, meta);
      if (toolMessage) {
        return toolMessage;
      }

      this.logger.warn(
        'Tool memory message missing toolCallId; falling back to system role',
      );
      return this.createFallbackSystemMessageFromRaw(content, meta);
    }

    if (memoryMessage.role === 'assistant') {
      return this.rehydrateAssistantMessage(content, memoryMessage);
    }

    if (memoryMessage.role === 'system' && this.looksLikeLegacyToolMeta(meta)) {
      const toolContent = this.extractLegacyToolContent(content, meta);
      const legacyToolMessage = this.rehydrateToolMessage(toolContent, meta);
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
   * Converts a generated LangChain message back into our persistence format.
   *
   * @param message Message emitted by LangGraph during a run.
   * @returns A serialisable memory entry or `null` when the message should be skipped.
   */
  fromBaseMessage(message: BaseMessage): MemoryMessage | null {
    if (isAIMessage(message)) {
      const toolCalls = this.normalizeToolCalls(message.tool_calls);
      const meta = this.buildAssistantMeta(message, toolCalls);
      const memoryMessage: MemoryMessage = {
        role: 'assistant',
        content: this.extractMessageContent(message),
        meta,
      };

      if (toolCalls?.length) {
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
        meta.additional_kwargs = { ...message.additional_kwargs };
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

    return parts
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
      if (isToolMessage(candidate)) {
        return {
          name: candidate.name ?? 'tool_call',
          args:
            candidate.additional_kwargs ??
            (typeof candidate.content === 'string'
              ? { result: candidate.content }
              : { result: candidate.content }),
        };
      }
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
    const maybeTyped = message as BaseMessage & {
      _getType?: () => string;
    };

    const type =
      typeof maybeTyped._getType === 'function'
        ? maybeTyped._getType()
        : message.constructor.name;

    if (
      isAIMessage(message) &&
      Array.isArray(message.tool_calls) &&
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
    if (
      Array.isArray(memoryMessage.toolCalls) &&
      memoryMessage.toolCalls.length > 0
    ) {
      return true;
    }

    const meta = memoryMessage.meta as
      | (Record<string, unknown> & { [key: string]: unknown })
      | undefined;

    if (meta) {
      const direct = this.normalizeToolCalls(meta['tool_calls']);
      if (direct?.length) {
        return true;
      }

      const camel = this.normalizeToolCalls(meta['toolCalls']);
      if (camel?.length) {
        return true;
      }
    }

    return false;
  }

  /**
   * Determines whether a tool response corresponds to a preceding assistant tool call.
   *
   * @param assistant The assistant message that may contain tool calls.
   * @param tool Tool response to validate.
   * @returns True when the tool response references one of the assistant tool call IDs.
   */
  toolCallMatches(assistant: AIMessage, tool: ToolMessage): boolean {
    if (
      !Array.isArray(assistant.tool_calls) ||
      assistant.tool_calls.length === 0
    ) {
      return false;
    }

    if (!tool.tool_call_id) {
      return false;
    }

    return assistant.tool_calls.some((call) => {
      if (!call || typeof call !== 'object') {
        return false;
      }

      const callRecord = call as Record<string, unknown>;
      const callId = callRecord.id;
      return typeof callId === 'string' && callId === tool.tool_call_id;
    });
  }

  /**
   * Creates a fallback system message to preserve orphaned tool output in chat history.
   *
   * @param toolMessage Tool message that could not be matched to a tool call.
   * @returns System message containing the tool content.
   */
  createFallbackSystemMessage(toolMessage: ToolMessage): SystemMessage {
    const fallbackMeta = {
      ...(toolMessage.additional_kwargs ?? {}),
      tool: toolMessage.name,
      toolCallId: toolMessage.tool_call_id,
    };

    return new SystemMessage({
      content: this.extractMessageContent(toolMessage),
      additional_kwargs: fallbackMeta,
    });
  }

  /**
   * Recreates a LangChain `ToolMessage` from raw memory data.
   *
   * @param content String content we stored alongside the tool invocation.
   * @param meta Serialized metadata describing the tool execution.
   * @returns Hydrated tool message or `null` when required identifiers are missing.
   */
  private rehydrateToolMessage(
    content: string,
    meta?: Record<string, unknown>,
  ): ToolMessage | null {
    const toolCallId = this.extractToolCallId(meta);

    if (!toolCallId) {
      return null;
    }

    const toolName = this.extractToolName(meta);
    const additional = this.sanitizeToolAdditional(meta);

    const toolMessage = new ToolMessage({
      content,
      tool_call_id: toolCallId,
      name: toolName,
      additional_kwargs: additional,
    });

    this.logger.debug(
      `Rehydrated tool message for toolCallId=${toolCallId}${
        toolName ? ` (tool=${toolName})` : ''
      }`,
    );

    return toolMessage;
  }

  /**
   * Recreates an assistant response including any tool-call annotations.
   *
   * @param content Assistant text content retrieved from memory.
   * @param memoryMessage Source memory record containing tool-call metadata.
   * @returns Hydrated AI message ready to replay through LangGraph.
   */
  private rehydrateAssistantMessage(
    content: string,
    memoryMessage: MemoryMessage,
  ): AIMessage {
    const meta = memoryMessage.meta ?? undefined;
    const { sanitizedMeta, toolCalls, responseMetadata } =
      this.splitAssistantMeta(meta, memoryMessage.toolCalls);

    const fields: Record<string, any> = {
      content,
    };

    if (sanitizedMeta && Object.keys(sanitizedMeta).length > 0) {
      fields.additional_kwargs = sanitizedMeta;
    }

    if (toolCalls?.length) {
      fields.tool_calls = toolCalls;
    }

    if (responseMetadata && Object.keys(responseMetadata).length > 0) {
      fields.response_metadata = responseMetadata;
    }

    const aiMessage = new AIMessage(
      fields as ConstructorParameters<typeof AIMessage>[0],
    );

    if (toolCalls?.length) {
      this.logger.debug(
        `Rehydrated assistant tool-calling message (toolCalls=${toolCalls.length})`,
      );
    }

    return aiMessage;
  }

  /**
   * Separates assistant metadata into structured buckets for rehydration.
   *
   * @param meta Additional kwargs saved with the assistant message.
   * @param fallbackToolCalls Tool calls stored on the memory record for legacy support.
   * @returns Sanitized metadata, normalized tool calls, and optional response metadata.
   */
  private splitAssistantMeta(
    meta: Record<string, unknown> | undefined,
    fallbackToolCalls?: unknown[],
  ): {
    sanitizedMeta?: Record<string, unknown>;
    toolCalls?: ToolCall[];
    responseMetadata?: Record<string, unknown>;
  } {
    let toolCalls = this.normalizeToolCalls(fallbackToolCalls);

    if (!meta) {
      return {
        sanitizedMeta: undefined,
        toolCalls,
        responseMetadata: undefined,
      };
    }

    const working: Record<string, unknown> = this.deepClone(meta);
    const metaAny = working as Record<string, unknown> & {
      [key: string]: unknown;
    };

    const directToolCalls = this.normalizeToolCalls(metaAny['tool_calls']);
    if (directToolCalls?.length) {
      toolCalls = directToolCalls;
    }

    const camelToolCalls = this.normalizeToolCalls(metaAny['toolCalls']);
    if (camelToolCalls?.length) {
      toolCalls = camelToolCalls;
    }

    if ('tool_calls' in metaAny) {
      delete metaAny['tool_calls'];
    }

    if ('toolCalls' in metaAny) {
      delete metaAny['toolCalls'];
    }

    const responseMetadata = this.normalizeResponseMetadata(
      metaAny['response_metadata'],
    );
    if (responseMetadata) {
      delete metaAny['response_metadata'];
    }

    const sanitizedMeta = Object.keys(metaAny).length > 0 ? metaAny : undefined;

    return {
      sanitizedMeta,
      toolCalls,
      responseMetadata,
    };
  }

  /**
   * Normalizes arbitrary data into LangChain-compatible tool calls.
   *
   * @param value Unknown data source (could be legacy shapes or already typed arrays).
   * @returns Normalized tool call array or `undefined` when input cannot be coerced.
   */
  private normalizeToolCalls(value: unknown): ToolCall[] | undefined {
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

  /**
   * Normalizes response metadata to a simple object when possible.
   *
   * @param value Unknown metadata payload.
   * @returns Cloned metadata object or `undefined` when coercion is not possible.
   */
  private normalizeResponseMetadata(
    value: unknown,
  ): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    return this.deepClone(value as Record<string, unknown>);
  }

  /**
   * Serializes the useful portions of an assistant message for storage.
   *
   * @param message Freshly generated assistant message.
   * @param toolCalls Tool calls associated with the assistant response.
   * @returns Metadata object ready to persist or `undefined` when empty.
   */
  private buildAssistantMeta(
    message: AIMessage,
    toolCalls?: ToolCall[],
  ): Record<string, unknown> | undefined {
    const meta: Record<string, unknown> = {};

    if (
      message.additional_kwargs &&
      Object.keys(message.additional_kwargs).length > 0
    ) {
      Object.assign(meta, this.deepClone(message.additional_kwargs));
    }

    if (
      message.response_metadata &&
      Object.keys(message.response_metadata).length > 0
    ) {
      meta.response_metadata = this.deepClone(message.response_metadata);
    }

    if (toolCalls?.length) {
      meta.tool_calls = toolCalls.map((toolCall) => this.deepClone(toolCall));
    }

    return Object.keys(meta).length > 0 ? meta : undefined;
  }

  /**
   * Extracts non-reserved tool metadata for inclusion in the tool message.
   *
   * @param meta Serialized metadata saved for the tool invocation.
   * @returns Additional kwargs to pass to LangChain or `undefined` when none exist.
   */
  private sanitizeToolAdditional(
    meta?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    if (!meta) {
      return undefined;
    }

    const additionalFromMeta = this.extractToolAdditionalKwargs(meta);
    if (additionalFromMeta) {
      return additionalFromMeta;
    }

    const reservedKeys = new Set([
      'tool',
      'name',
      'toolCallId',
      'tool_call_id',
      'content',
      'additional_kwargs',
      'additionalKwargs',
    ]);

    const additional: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(meta)) {
      if (!reservedKeys.has(key)) {
        additional[key] = this.deepClone(value);
      }
    }

    return Object.keys(additional).length > 0 ? additional : undefined;
  }

  /**
   * Pulls additional kwargs from stored metadata honoring both snake and camel case.
   *
   * @param meta Metadata record to inspect.
   * @returns Additional kwargs object when present; otherwise `undefined`.
   */
  private extractToolAdditionalKwargs(
    meta: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    const metaAny = meta as Record<string, unknown> & {
      [key: string]: unknown;
    };

    const direct = metaAny['additional_kwargs'];
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
      return this.deepClone(direct as Record<string, unknown>);
    }

    const camel = metaAny['additionalKwargs'];
    if (camel && typeof camel === 'object' && !Array.isArray(camel)) {
      return this.deepClone(camel as Record<string, unknown>);
    }

    return undefined;
  }

  /**
   * Reads a tool call identifier from stored metadata.
   *
   * @param meta Metadata object possibly containing a tool call ID.
   * @returns Tool call identifier or `null` when it cannot be found.
   */
  private extractToolCallId(meta?: Record<string, unknown>): string | null {
    if (!meta) {
      return null;
    }

    const candidate =
      typeof meta.toolCallId === 'string'
        ? meta.toolCallId
        : typeof meta.tool_call_id === 'string'
          ? meta.tool_call_id
          : undefined;

    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }

    return null;
  }

  /**
   * Reads the tool name from stored metadata.
   *
   * @param meta Metadata object possibly containing a tool name.
   * @returns Tool name or `undefined` when not provided.
   */
  private extractToolName(meta?: Record<string, unknown>): string | undefined {
    if (!meta) {
      return undefined;
    }

    const nameCandidate =
      typeof meta.tool === 'string'
        ? meta.tool
        : typeof meta.name === 'string'
          ? meta.name
          : undefined;

    if (typeof nameCandidate === 'string' && nameCandidate.trim().length > 0) {
      return nameCandidate;
    }

    return undefined;
  }

  /**
   * Type guard that checks if a content block exposes a `text` field.
   *
   * @param part Content block emitted by LangChain.
   * @returns True when the block contains a `text` property.
   */
  private isTextPart(part: unknown): part is { text: string } {
    if (!part || typeof part !== 'object') {
      return false;
    }

    const candidate = part as { text?: unknown };
    return typeof candidate.text === 'string';
  }

  /**
   * Coerces arbitrary input into a LangChain `ToolCall`.
   *
   * @param candidate Unknown structure obtained from memory or legacy storage.
   * @returns A well-formed tool call or `null` when conversion fails.
   */
  private coerceToolCall(candidate: unknown): ToolCall | null {
    if (!candidate || typeof candidate !== 'object') {
      return null;
    }

    const record = candidate as Record<string, unknown>;
    const args = this.coerceToolArgs(record.args);

    if (!args) {
      return null;
    }

    const toolCall: ToolCall = {
      name: this.extractString(record, 'name') ?? 'tool_call',
      args,
    };

    const id = this.extractString(record, 'id');
    if (id) {
      toolCall.id = id;
    }

    const type = this.extractString(record, 'type');
    if (type) {
      toolCall.type = type as ToolCall['type'];
    }

    return toolCall;
  }

  /**
   * Attempts to coerce persisted tool arguments back into an object.
   *
   * @param value Value saved alongside the tool execution.
   * @returns Object with tool arguments or `null` when coercion is impossible.
   */
  private coerceToolArgs(value: unknown): Record<string, any> | null {
    if (value === null || value === undefined) {
      return {};
    }

    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, any>;
        }
        return { raw: parsed };
      } catch {
        return { raw: value };
      }
    }

    if (typeof value === 'object' && !Array.isArray(value)) {
      return this.deepClone(value as Record<string, any>);
    }

    return { raw: value };
  }

  /**
   * Pulls a trimmed string from a record when the value is present.
   *
   * @param record Object that may contain the desired property.
   * @param key Property name to extract.
   * @returns Trimmed string value or `undefined` when absent.
   */
  private extractString(
    record: Record<string, unknown>,
    key: string,
  ): string | undefined {
    const raw = record[key];
    if (typeof raw !== 'string') {
      return undefined;
    }

    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  /**
   * Determines whether stored metadata resembles the legacy tool format.
   *
   * @param meta Metadata record to inspect.
   * @returns True when the record exposes recognizable tool call identifiers.
   */
  private looksLikeLegacyToolMeta(meta?: Record<string, unknown>): boolean {
    if (!meta) {
      return false;
    }

    const hasToolCallId =
      typeof meta.toolCallId === 'string' ||
      typeof meta.tool_call_id === 'string';

    return hasToolCallId;
  }

  /**
   * Extracts legacy tool output content falling back to the supplied value.
   *
   * @param fallback Fallback string when metadata does not include content.
   * @param meta Metadata record to inspect.
   * @returns The most appropriate tool output content.
   */
  private extractLegacyToolContent(
    fallback: string,
    meta?: Record<string, unknown>,
  ): string {
    if (!meta) {
      return fallback;
    }

    const metaContent = meta.content;

    if (typeof metaContent === 'string' && metaContent.length > 0) {
      return metaContent;
    }

    return fallback;
  }

  /**
   * Builds a simple system message from raw content and metadata.
   *
   * @param content Text content to include in the system message.
   * @param meta Optional metadata that should accompany the message.
   * @returns System message suitable for injection into history.
   */
  private createFallbackSystemMessageFromRaw(
    content: string,
    meta?: Record<string, unknown>,
  ): SystemMessage {
    return new SystemMessage({
      content,
      additional_kwargs: meta ?? {},
    });
  }

  /**
   * Performs a defensive deep clone of the provided value.
   *
   * @param value Value to clone.
  * @returns A structurally equivalent value that can be safely mutated.
   */
  private deepClone<T>(value: T): T {
    try {
      const structured = (
        globalThis as {
          structuredClone?: (input: unknown) => unknown;
        }
      ).structuredClone;
      if (typeof structured === 'function') {
        return structured(value) as T;
      }
    } catch {
      // ignore and fall back
    }

    try {
      return JSON.parse(JSON.stringify(value)) as T;
    } catch {
      if (value && typeof value === 'object') {
        return { ...(value as Record<string, unknown>) } as T;
      }

      return value;
    }
  }
}
