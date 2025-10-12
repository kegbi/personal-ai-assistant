import { Injectable, Logger } from '@nestjs/common';
import { SystemMessage, ToolMessage } from '@langchain/core/messages';
import {
  cloneValue,
  extractTrimmedString,
  isRecord,
} from '../utils/message-structure.utils';

/**
 * Rehydrates stored tool responses and prepares fallback metadata for transcripts.
 */
@Injectable()
export class ToolMessageHydrator {
  private readonly logger = new Logger(ToolMessageHydrator.name);

  /**
   * Recreates a LangChain ToolMessage from persisted metadata.
   *
   * @param content Stored tool output content.
   * @param meta Metadata captured during tool execution.
   * @returns Hydrated tool message or `null` when identifiers are missing.
   */
  rehydrate(
    content: string,
    meta: Record<string, unknown> | undefined,
  ): ToolMessage | null {
    const toolCallId = this.extractToolCallId(meta);
    if (!toolCallId) {
      return null;
    }

    const toolName = this.extractToolName(meta);
    const additional = this.sanitizeAdditional(meta);

    const toolMessage = new ToolMessage({
      content,
      tool_call_id: toolCallId,
      name: toolName,
      additional_kwargs: additional,
    });

    this.logger.debug(
      `Rehydrated tool message for toolCallId=${toolCallId}${toolName ? ` (tool=${toolName})` : ''}`,
    );

    return toolMessage;
  }

  /**
   * Creates a metadata snapshot that preserves tool execution context.
   *
   * @param toolMessage Tool message that requires safe storage.
   * @returns Metadata suitable for attaching to a fallback system message.
   */
  buildFallbackMeta(toolMessage: ToolMessage): Record<string, unknown> {
    const fallbackMeta: Record<string, unknown> = {};

    const additionalEntries = toolMessage.additional_kwargs;
    if (additionalEntries && Object.keys(additionalEntries).length > 0) {
      for (const [key, value] of Object.entries(additionalEntries)) {
        fallbackMeta[key] = cloneValue(value);
      }
    }

    if (toolMessage.name) {
      fallbackMeta.tool = toolMessage.name;
    }

    if (toolMessage.tool_call_id) {
      fallbackMeta.toolCallId = toolMessage.tool_call_id;
    }

    return fallbackMeta;
  }

  /**
   * Determines whether persisted metadata follows the legacy tool message format.
   *
   * @param meta Metadata to examine.
   * @returns True when the metadata presents recognizable tool call identifiers.
   */
  looksLikeLegacyToolMeta(meta?: Record<string, unknown>): boolean {
    if (!meta || !isRecord(meta)) {
      return false;
    }

    const callId = this.extractToolCallId(meta);
    return typeof callId === 'string';
  }

  /**
   * Restores legacy tool output content, falling back to the provided value when necessary.
   *
   * @param fallback Default value to use when metadata does not carry content.
   * @param meta Legacy metadata payload.
   * @returns Preferred content string.
   */
  extractLegacyToolContent(
    fallback: string,
    meta?: Record<string, unknown>,
  ): string {
    if (!meta || !isRecord(meta)) {
      return fallback;
    }

    const rawContent = meta.content;
    if (typeof rawContent === 'string' && rawContent.length > 0) {
      return rawContent;
    }

    return fallback;
  }

  /**
   * Constructs a simple system message from raw content and metadata.
   *
   * @param content Text content to include.
   * @param meta Optional metadata to retain.
   * @returns Newly created system message.
   */
  createSystemMessageFromRaw(
    content: string,
    meta?: Record<string, unknown>,
  ): SystemMessage {
    return new SystemMessage({
      content,
      additional_kwargs: meta ?? {},
    });
  }

  private sanitizeAdditional(
    meta: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (!meta || !isRecord(meta)) {
      return undefined;
    }

    const explicit = this.extractAdditional(meta);
    if (explicit) {
      return explicit;
    }

    const reserved = new Set([
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
      if (!reserved.has(key)) {
        additional[key] = cloneValue(value);
      }
    }

    return Object.keys(additional).length > 0 ? additional : undefined;
  }

  private extractAdditional(
    meta: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    const direct = meta.additional_kwargs;
    if (isRecord(direct)) {
      return cloneValue(direct);
    }

    const camelCandidate = meta['additionalKwargs'];
    if (isRecord(camelCandidate)) {
      return cloneValue(camelCandidate);
    }

    return undefined;
  }

  private extractToolCallId(meta?: Record<string, unknown>): string | null {
    if (!meta || !isRecord(meta)) {
      return null;
    }

    const direct = extractTrimmedString(meta, 'toolCallId');
    if (direct) {
      return direct;
    }

    const snake = extractTrimmedString(meta, 'tool_call_id');
    if (snake) {
      return snake;
    }

    return null;
  }

  private extractToolName(meta?: Record<string, unknown>): string | undefined {
    if (!meta || !isRecord(meta)) {
      return undefined;
    }

    const direct = extractTrimmedString(meta, 'tool');
    if (direct) {
      return direct;
    }

    return extractTrimmedString(meta, 'name');
  }
}
