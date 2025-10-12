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
import { MessagesAnnotation } from '@langchain/langgraph';
import { MessageReceivedDto } from '../transport/dto/message-received.dto';
import { AgentResponseDto } from '../transport/dto/agent-response.dto';
import { MemoryMessage, MemoryService } from '../memory/memory.service';
import { GraphFactory, type CompiledGraph } from './langgraph/graph.factory';
import { DEFAULT_SYSTEM_PROMPT } from '../policies/prompt.policy';

type AgentState = typeof MessagesAnnotation.State;

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly graph: CompiledGraph;

  constructor(
    private readonly memoryService: MemoryService,
    private readonly graphFactory: GraphFactory,
  ) {
    this.graph = this.graphFactory.build();
  }

  async handleEvent(message: MessageReceivedDto): Promise<AgentResponseDto> {
    if (message.isCommand && message.command) {
      return this.handleCommand(message);
    }

    const userContent = this.resolveUserContent(message);

    await this.memoryService.pushMessage(message.chatId, {
      role: 'user',
      content: userContent,
      meta: this.buildUserMeta(message),
    });

    const window = await this.memoryService.getWindow(message.chatId);
    const history = this.composeHistory(window);
    const initialLength = history.length;

    this.logger.debug(
      `Invoking LangGraph for chat ${message.chatId} (history=${history.length}, window=${window.length})`,
    );

    const result = (await this.graph.invoke(
      {
        messages: history,
      },
      {
        configurable: {
          chatId: message.chatId,
        },
      },
    ));

    const messages = result.messages as BaseMessage[];
    const generated = messages.slice(initialLength);

    this.logger.debug(
      `LangGraph produced ${generated.length} message(s) for chat ${message.chatId}${
        generated.length
          ? `: ${generated.map((msg) => this.describeMessageForLog(msg)).join(', ')}`
          : ''
      }`,
    );

    await this.persistGeneratedMessages(message.chatId, generated);

    const finalMessage = this.pickFinalAssistantMessage(messages);

    if (!finalMessage) {
      this.logger.warn('LangGraph completed without an assistant response');
      return {
        chatId: message.chatId,
        text: 'I am not sure how to respond to that just yet.',
      };
    }

    const toolMeta = this.extractToolMeta(generated);

    return {
      chatId: message.chatId,
      text: this.extractMessageContent(finalMessage),
      meta: toolMeta ? { tool: toolMeta.name, args: toolMeta.args } : undefined,
    };
  }

  private async handleCommand(message: MessageReceivedDto): Promise<AgentResponseDto> {
    const command = message.command?.toLowerCase() ?? '';

    switch (command) {
      case '/start': {
        await this.memoryService.clear(message.chatId);
        return {
          chatId: message.chatId,
          text: 'Hello! I am your personal AI assistant. Ask me to remember contacts, update details, or just chat.',
        };
      }
      case '/clear': {
        await this.memoryService.clear(message.chatId);
        return {
          chatId: message.chatId,
          text: 'Cleared recent conversation memory for this chat.',
        };
      }
      case '/help': {
        return {
          chatId: message.chatId,
          text:
            'Try:\n' +
            '• “Remember that Alice is my designer friend.”\n' +
            '• “Set Alice’s birthday to 1991-05-14.”\n' +
            '• “Who is Alice?”',
        };
      }
      default:
        return {
          chatId: message.chatId,
          text: `Unknown command ${command}. Available: /start, /help, /clear.`,
        };
    }
  }

  private resolveUserContent(message: MessageReceivedDto): string {
    if (message.text && message.text.trim().length > 0) {
      return message.text.trim();
    }

    if (message.voiceUrl) {
      return `[voice message received: ${message.voiceUrl}]`;
    }

    return '[empty message]';
  }

  private buildUserMeta(message: MessageReceivedDto): Record<string, unknown> | undefined {
    const meta: Record<string, unknown> = {};

    if (message.voiceUrl) {
      meta.voiceUrl = message.voiceUrl;
    }

    if (message.payload) {
      meta.payload = message.payload;
    }

    return Object.keys(meta).length > 0 ? meta : undefined;
  }

  private composeHistory(window: MemoryMessage[]): BaseMessage[] {
    const history: BaseMessage[] = [
      new SystemMessage(DEFAULT_SYSTEM_PROMPT),
    ];

    for (const item of window) {
      const baseMessage = this.toBaseMessage(item);

      if (isToolMessage(baseMessage)) {
        const previous = history[history.length - 1];
        if (
          !previous ||
          !isAIMessage(previous) ||
          !this.toolCallMatches(previous, baseMessage)
        ) {
          // Downgrade orphaned tool responses so the LLM history stays valid.
          this.logger.warn(
            `Skipping tool message due to missing matching tool call (toolCallId=${
              baseMessage.tool_call_id ?? 'unknown'
            })`,
          );

          const fallbackMeta = {
            ...(baseMessage.additional_kwargs ?? {}),
            tool: baseMessage.name,
            toolCallId: baseMessage.tool_call_id,
          };

          history.push(
            new SystemMessage({
              content: this.extractMessageContent(baseMessage),
              additional_kwargs: fallbackMeta,
            }),
          );

          continue;
        }
      }

      history.push(baseMessage);
    }

    return history;
  }

  private toBaseMessage(memoryMessage: MemoryMessage): BaseMessage {
    const content = memoryMessage.content ?? '';
    const meta = memoryMessage.meta ?? undefined;

    if (memoryMessage.role === 'tool') {
      const toolMessage = this.rehydrateToolMessage(content, meta);
      if (toolMessage) {
        return toolMessage;
      }

      this.logger.warn('Tool memory message missing toolCallId; falling back to system role');
      return new SystemMessage({
        content,
        additional_kwargs: meta ?? {},
      });
    }

    if (
      memoryMessage.role === 'system' &&
      this.looksLikeLegacyToolMeta(meta)
    ) {
      const toolContent = this.extractLegacyToolContent(content, meta);
      const legacyToolMessage = this.rehydrateToolMessage(toolContent, meta);
      if (legacyToolMessage) {
        return legacyToolMessage;
      }

      this.logger.warn('Legacy tool memory message missing toolCallId; keeping as system message');
    }

    if (memoryMessage.role === 'assistant') {
      return this.rehydrateAssistantMessage(content, memoryMessage);
    }

    switch (memoryMessage.role) {
      case 'system':
        return new SystemMessage({
          content,
          additional_kwargs: meta ?? {},
        });
      default:
        return new HumanMessage({
          content,
          additional_kwargs: meta ?? {},
        });
    }
  }

  private async persistGeneratedMessages(
    chatId: string,
    messages: BaseMessage[],
  ): Promise<void> {
    for (const message of messages) {
      const memoryMessage = this.fromBaseMessage(message);
      if (!memoryMessage) {
        this.logger.debug(
          `Skipping persistence for generated ${this.describeMessageForLog(message)} message`,
        );
        continue;
      }

      this.logger.debug(
        `Persisting generated ${memoryMessage.role} message for chat ${chatId} (toolCalls=${
          this.memoryMessageHasToolCalls(memoryMessage) ? 'yes' : 'no'
        })`,
      );

      await this.memoryService.pushMessage(chatId, memoryMessage);
    }
  }

  private fromBaseMessage(message: BaseMessage): MemoryMessage | null {
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
      const meta: Record<string, unknown> = {
        tool: message.name,
        name: message.name,
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
      `Rehydrated tool message for toolCallId=${toolCallId}${toolName ? ` (tool=${toolName})` : ''}`,
    );

    return toolMessage;
  }

  private rehydrateAssistantMessage(
    content: string,
    memoryMessage: MemoryMessage,
  ): AIMessage {
    const meta = memoryMessage.meta ?? undefined;
    const { sanitizedMeta, toolCalls, responseMetadata } = this.splitAssistantMeta(
      meta,
      memoryMessage.toolCalls,
    );

    const fields: {
      content: string;
      additional_kwargs?: Record<string, unknown>;
      tool_calls?: Array<Record<string, unknown>>;
      response_metadata?: Record<string, unknown>;
    } = { content };

    if (sanitizedMeta && Object.keys(sanitizedMeta).length > 0) {
      fields.additional_kwargs = sanitizedMeta;
    }

    if (toolCalls?.length) {
      fields.tool_calls = toolCalls;
    }

    if (responseMetadata && Object.keys(responseMetadata).length > 0) {
      fields.response_metadata = responseMetadata;
    }

    const aiMessage = new AIMessage(fields);

    if (toolCalls?.length) {
      this.logger.debug(
        `Rehydrated assistant tool-calling message (toolCalls=${toolCalls.length})`,
      );
    }

    return aiMessage;
  }

  private splitAssistantMeta(
    meta: Record<string, unknown> | undefined,
    fallbackToolCalls?: unknown[],
  ): {
    sanitizedMeta?: Record<string, unknown>;
    toolCalls?: Array<Record<string, unknown>>;
    responseMetadata?: Record<string, unknown>;
  } {
    let toolCalls = this.normalizeToolCalls(fallbackToolCalls);
    let responseMetadata: Record<string, unknown> | undefined;

    if (!meta) {
      return {
        sanitizedMeta: undefined,
        toolCalls,
        responseMetadata: undefined,
      };
    }

    const working: Record<string, unknown> = this.deepClone(meta);
    const metaAny = working as Record<string, unknown> & { [key: string]: unknown };

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

    responseMetadata = this.normalizeResponseMetadata(metaAny['response_metadata']);
    if (responseMetadata) {
      delete metaAny['response_metadata'];
    }

    const sanitizedMeta =
      Object.keys(metaAny).length > 0 ? metaAny : undefined;

    return {
      sanitizedMeta,
      toolCalls,
      responseMetadata,
    };
  }

  private normalizeToolCalls(value: unknown): Array<Record<string, unknown>> | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const normalized = value
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .map((item) => this.deepClone(item));

    return normalized.length > 0 ? normalized : undefined;
  }

  private normalizeResponseMetadata(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    return this.deepClone(value as Record<string, unknown>);
  }

  private buildAssistantMeta(
    message: AIMessage,
    toolCalls?: Array<Record<string, unknown>>,
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

  private extractToolAdditionalKwargs(
    meta: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    const metaAny = meta as Record<string, unknown> & { [key: string]: unknown };

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

  private toolCallMatches(assistant: AIMessage, tool: ToolMessage): boolean {
    if (!Array.isArray(assistant.tool_calls) || assistant.tool_calls.length === 0) {
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

  private memoryMessageHasToolCalls(memoryMessage: MemoryMessage): boolean {
    if (Array.isArray(memoryMessage.toolCalls) && memoryMessage.toolCalls.length > 0) {
      return true;
    }

    const meta = memoryMessage.meta as
      | (Record<string, unknown> & { [key: string]: unknown })
      | undefined;

    if (meta) {
      const direct = meta['tool_calls'];
      if (Array.isArray(direct) && direct.length > 0) {
        return true;
      }

      const camel = meta['toolCalls'];
      if (Array.isArray(camel) && camel.length > 0) {
        return true;
      }
    }

    return false;
  }

  private describeMessageForLog(message: BaseMessage): string {
    const maybeTyped = message as BaseMessage & {
      _getType?: () => string;
    };

    const type =
      typeof maybeTyped._getType === 'function'
        ? maybeTyped._getType()
        : message.constructor.name;

    if (isAIMessage(message) && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      return `${type} (toolCalls=${message.tool_calls.length})`;
    }

    if (isToolMessage(message)) {
      return `${type} (toolCallId=${message.tool_call_id ?? 'unknown'})`;
    }

    return type;
  }

  private deepClone<T>(value: T): T {
    try {
      const structured = (globalThis as { structuredClone?: (input: unknown) => unknown }).structuredClone;
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

  private looksLikeLegacyToolMeta(meta?: Record<string, unknown>): boolean {
    if (!meta) {
      return false;
    }

    const hasToolCallId =
      typeof meta.toolCallId === 'string' || typeof meta.tool_call_id === 'string';

    return hasToolCallId;
  }

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

  private pickFinalAssistantMessage(messages: BaseMessage[]): AIMessage | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (isAIMessage(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private extractMessageContent(message: AIMessage | ToolMessage): string {
    if (typeof message.content === 'string') {
      return message.content;
    }

    return message.content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }

        if ('text' in part) {
          return part.text;
        }

        return JSON.stringify(part);
      })
      .join('\n')
      .trim();
  }

  private extractToolMeta(messages: BaseMessage[]) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (isToolMessage(candidate)) {
        return {
          name: candidate.name,
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
}
