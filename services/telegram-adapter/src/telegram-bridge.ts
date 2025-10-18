import { Bot, GrammyError, HttpError } from 'grammy';
import type { Context, NextFunction } from 'grammy';
import type { Message } from 'grammy/types';
import type { AdapterConfig } from './config';
import { AgentClient } from './agent-client';
import type {
  AgentResponseMeta,
  AgentResponsePayload,
  BridgeStatus,
  MessageReceivedPayload,
} from './types';

interface BridgeMetrics {
  startedAt: Date;
  lastUpdateAt?: Date;
  lastAgentInteractionAt?: Date;
  lastAgentError?: string;
  processedUpdates: number;
}

export class TelegramBridge {
  private readonly bot: Bot;
  private readonly agentClient: AgentClient;
  private readonly config: AdapterConfig;
  private readonly allowedParticipantIds: Set<string>;
  private readonly metrics: BridgeMetrics = {
    startedAt: new Date(),
    processedUpdates: 0,
  };
  private started = false;

  constructor(config: AdapterConfig, agentClient: AgentClient) {
    this.config = config;
    this.agentClient = agentClient;
    this.allowedParticipantIds = new Set(config.allowedChatIds);
    this.bot = new Bot(config.tgBotToken);

    this.registerMiddleware();
    this.registerHandlers();
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.bot.start({
      allowed_updates: ['message', 'my_chat_member'],
      drop_pending_updates: this.config.dropPendingUpdates,
      timeout: Math.max(1, Math.floor(this.config.longPollingTimeoutMs / 1000)),
      onStart: (botInfo) => {
        this.log(`Polling started as @${botInfo.username}`);
      },
    });

    this.started = true;
    this.metrics.startedAt = new Date();
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    await this.bot.stop();
    this.started = false;
    this.log('Polling stopped');
  }

  getStatus(): BridgeStatus {
    return {
      ok: !this.metrics.lastAgentError,
      startedAt: this.metrics.startedAt.toISOString(),
      lastUpdateAt: this.metrics.lastUpdateAt?.toISOString(),
      lastAgentInteractionAt: this.metrics.lastAgentInteractionAt?.toISOString(),
      lastAgentError: this.metrics.lastAgentError,
      processedUpdates: this.metrics.processedUpdates,
    };
  }

  private registerMiddleware(): void {
    this.bot.catch((errorContext) => {
      const { error, ctx } = errorContext;
      if (error instanceof GrammyError) {
        this.log(
          `Telegram API error on update ${ctx.update.update_id}: ${error.description}`,
          'error',
        );
      } else if (error instanceof HttpError) {
        this.log(
          `Telegram HTTP error on update ${ctx.update.update_id}: ${error.message}`,
          'error',
        );
      } else {
        this.log(`Unexpected error on update ${ctx.update.update_id}: ${error}`, 'error');
      }
    });

    this.bot.use(async (ctx: Context, next: NextFunction) => {
      const chat = ctx.chat;
      if (chat?.type && chat.type !== 'private') {
        if (chat.id) {
          await this.leaveChatIfPossible(ctx, chat.id, chat.type, 'non-private update');
        }
        return;
      }

      if (!this.isAllowedParticipant(ctx.chat?.id, ctx.from?.id)) {
        const identifier = ctx.chat?.id ?? ctx.from?.id;
        if (identifier) {
          this.log(
            `Ignored update from disallowed participant chat=${ctx.chat?.id ?? 'n/a'} user=${ctx.from?.id ?? 'n/a'}`,
          );
        }
        return;
      }

      return next();
    });
  }

  private registerHandlers(): void {
    this.bot.on('my_chat_member', async (ctx) => {
      const chat = ctx.chat;
      const newStatus = ctx.myChatMember?.new_chat_member?.status;
      if (!chat?.id || chat.type === 'private') {
        return;
      }

      if (!newStatus || ['left', 'kicked'].includes(newStatus)) {
        return;
      }

      await this.leaveChatIfPossible(ctx, chat.id, chat.type, `my_chat_member:${newStatus}`);
    });

    this.bot.command(['start', 'help', 'clear'], async (ctx) => {
      const text = ctx.message?.text;
      if (!text) {
        return;
      }

      const command = text.split(' ')[0]?.toLowerCase() ?? '';
      const basePayload = this.buildBasePayload(ctx);
      await this.forwardToAgent(ctx, {
        ...basePayload,
        isCommand: true,
        command,
        text: text,
      });
    });

    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message?.text;
      if (!text) {
        return;
      }

      const basePayload = this.buildBasePayload(ctx);
      await this.forwardToAgent(ctx, {
        ...basePayload,
        text,
      });
    });

    this.bot.on('message:voice', async (ctx) => {
      const voice = ctx.message?.voice;
      if (!voice) {
        return;
      }

      const basePayload = this.buildBasePayload(ctx);
      const caption = ctx.message?.caption?.trim();
      const file = await ctx.api.getFile(voice.file_id);
      const voiceUrl = file.file_path
        ? `https://api.telegram.org/file/bot${this.config.tgBotToken}/${file.file_path}`
        : undefined;

      await this.forwardToAgent(ctx, {
        ...basePayload,
        text: caption,
        voiceUrl,
        payload: {
          ...(basePayload.payload ?? {}),
          duration: voice.duration,
          mimeType: voice.mime_type,
          fileSize: voice.file_size,
        },
      });
    });

    this.bot.on('message', async (ctx) => {
      const message = ctx.message;
      if (!message) {
        return;
      }

      await this.forwardToAgent(ctx, {
        ...this.buildBasePayload(ctx),
        text: this.describeUnsupportedMessage(message),
      });
    });
  }

  /**
   * Builds the shared transport payload attributes derived from the Telegram update.
   *
   * @param ctx Grammy context that carries the inbound update.
   * @returns Base payload forwarded to the agent service.
   */
  private buildBasePayload(ctx: Context): MessageReceivedPayload {
    const chatId = ctx.chat?.id ? String(ctx.chat.id) : 'unknown';
    const userId = ctx.from?.id ? String(ctx.from.id) : chatId;
    const idempotencyKey = String(ctx.update.update_id);

    return {
      connectorId: 'telegram',
      idempotencyKey,
      chatId,
      userId,
      payload: {
        messageId: ctx.message?.message_id ?? ctx.update.update_id,
        chatType: ctx.chat?.type,
        updateId: ctx.update.update_id,
      },
    };
  }

  private async forwardToAgent(
    ctx: Context,
    payload: MessageReceivedPayload,
  ): Promise<void> {
    this.metrics.processedUpdates += 1;
    this.metrics.lastUpdateAt = new Date();

    this.log(
      `Inbound message chatId=${payload.chatId} userId=${payload.userId} text=${payload.text ?? '[non-text payload]'}`,
    );

    if (this.config.streamingMode === 'edit') {
      await this.forwardToAgentStreaming(ctx, payload);
      return;
    }

    let response: AgentResponsePayload;
    try {
      response = await this.agentClient.sendMessage(payload);
      this.metrics.lastAgentInteractionAt = new Date();
      this.metrics.lastAgentError = undefined;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Unknown error: ${String(error)}`;
      this.metrics.lastAgentError = message;
      this.log(`Failed to forward message to agent: ${message}`, 'error');

      await this.safeReply(
        ctx,
        'Sorry, something went wrong while talking to the assistant. Please try again in a moment.',
      );
      return;
    }

    await this.deliverAgentResponse(ctx, response);
  }

  private async forwardToAgentStreaming(
    ctx: Context,
    payload: MessageReceivedPayload,
  ): Promise<void> {
    let placeholderMessageId: number | undefined;
    let aggregatedText = '';
    let finalMeta: AgentResponseMeta | undefined;
    let encounteredError = false;
    let lastEditAt = 0;
    let lastTypingAt = 0;
    let receivedFinal = false;

    const ensureTypingIndicator = async (force = false): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastTypingAt < 4_000) {
        return;
      }
      try {
        await ctx.api.sendChatAction(payload.chatId, 'typing');
        lastTypingAt = now;
      } catch (error) {
        this.log(
          `Failed to send typing indicator: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'error',
        );
      }
    };

    try {
      await ensureTypingIndicator(true);
      const stream = this.agentClient.sendMessageStream(payload);

      for await (const event of stream) {
        if (event.type === 'start') {
          if (placeholderMessageId === undefined) {
            placeholderMessageId = await this.sendStreamingPlaceholder(
              ctx,
              payload.chatId,
              ctx.message?.message_id,
            );
          }
          continue;
        }

        if (event.type === 'delta') {
          aggregatedText += event.text;
          await ensureTypingIndicator();
          if (
            placeholderMessageId !== undefined &&
            Date.now() - lastEditAt >= this.config.streamingMinEditIntervalMs
          ) {
            await this.editStreamingMessage(
              ctx,
              payload.chatId,
              placeholderMessageId,
              aggregatedText,
            );
            lastEditAt = Date.now();
          }
          continue;
        }

        if (event.type === 'tool') {
          this.log(
            `Streaming tool hint name=${event.name}`,
          );
          continue;
        }

        if (event.type === 'error') {
          encounteredError = true;
          this.metrics.lastAgentError = event.message;
          if (placeholderMessageId !== undefined) {
            await this.editStreamingMessage(
              ctx,
              payload.chatId,
              placeholderMessageId,
              'Sorry, something went wrong while talking to the assistant.',
            );
          } else {
            await this.safeReply(
              ctx,
              'Sorry, something went wrong while talking to the assistant. Please try again in a moment.',
            );
          }
          break;
        }

        if (event.type === 'final') {
          receivedFinal = true;
          finalMeta = event.meta;
          if (event.text.length > 0) {
            aggregatedText = event.text;
          }
          const finalText = this.normalizeStreamingText(aggregatedText);
          if (placeholderMessageId !== undefined) {
            await this.editStreamingMessage(
              ctx,
              payload.chatId,
              placeholderMessageId,
              finalText,
            );
          } else {
            await ctx.api.sendMessage(payload.chatId, finalText, {
              reply_to_message_id: ctx.message?.message_id,
            });
          }
          break;
        }
      }

      if (!encounteredError && !receivedFinal) {
        const finalText = this.normalizeStreamingText(aggregatedText);
        if (placeholderMessageId !== undefined) {
          await this.editStreamingMessage(
            ctx,
            payload.chatId,
            placeholderMessageId,
            finalText,
          );
        } else if (finalText.length > 0) {
          await ctx.api.sendMessage(payload.chatId, finalText, {
            reply_to_message_id: ctx.message?.message_id,
          });
        }
      }

      if (!encounteredError) {
        this.metrics.lastAgentInteractionAt = new Date();
        this.metrics.lastAgentError = undefined;
        if (finalMeta?.tool) {
          this.log(
            `Delivered streaming response with tool=${finalMeta.tool} elapsed=${finalMeta.elapsedMs ?? 'n/a'}ms`,
          );
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Unknown error: ${String(error)}`;
      this.metrics.lastAgentError = `Streaming failed: ${message}`;
      this.log(`Streaming failed: ${message}`, 'error');
      await this.safeReply(
        ctx,
        'Sorry, something went wrong while streaming the response. Please try again in a moment.',
      );
    }
  }

  private async sendStreamingPlaceholder(
    ctx: Context,
    chatId: string,
    replyTo?: number,
  ): Promise<number | undefined> {
    try {
      const placeholder = await ctx.api.sendMessage(chatId, 'Thinking...', {
        reply_to_message_id: replyTo,
      });
      return placeholder.message_id;
    } catch (error) {
      this.log(
        `Failed to send streaming placeholder: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'error',
      );
      return undefined;
    }
  }

  private async editStreamingMessage(
    ctx: Context,
    chatId: string,
    messageId: number,
    text: string,
  ): Promise<void> {
    const nextText = this.normalizeStreamingText(text);
    try {
      await ctx.api.editMessageText(chatId, messageId, nextText);
    } catch (error) {
      this.log(
        `Failed to edit streaming message: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'error',
      );
    }
  }

  private normalizeStreamingText(text: string): string {
    const trimmed = text.replace(/\s+/g, ' ').trim();
    return trimmed.length > 0 ? trimmed : '...';
  }

  private async deliverAgentResponse(
    ctx: Context,
    response: AgentResponsePayload,
  ): Promise<void> {
    try {
      await ctx.api.sendMessage(response.chatId, response.text, {
        reply_to_message_id: ctx.message?.message_id,
      });
      if (response.meta?.tool) {
        this.log(
          `Delivered response with tool=${response.meta.tool} elapsed=${response.meta.elapsedMs ?? 'n/a'}ms`,
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Unknown error: ${String(error)}`;
      this.metrics.lastAgentError = `Failed to deliver response: ${message}`;
      this.log(`Failed to send response to Telegram: ${message}`, 'error');
    }
  }

  private async safeReply(ctx: Context, text: string): Promise<void> {
    try {
      const chatId = ctx.chat?.id ? String(ctx.chat.id) : undefined;
      if (!chatId) {
        return;
      }
      await ctx.api.sendMessage(chatId, text);
    } catch (error) {
      this.log(`Failed to send error reply: ${error}`, 'error');
    }
  }

  private async leaveChatIfPossible(
    ctx: Context,
    chatId: number | string,
    chatType?: string,
    reason?: string,
  ): Promise<void> {
    const id = String(chatId);
    const type = chatType ?? 'unknown';
    const via = reason ?? 'unspecified';

    try {
      await ctx.api.leaveChat(chatId);
      this.log(`Left chat ${id} type=${type} reason=${via}`);
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : `Unknown error: ${String(error)}`;

      if (
        /bot (was kicked|is not a member)/i.test(messageText) ||
        messageText.toLowerCase().includes('chat not found')
      ) {
        this.log(`Already absent from chat ${id} type=${type}: ${messageText}`);
        return;
      }

      this.log(`Failed to leave chat ${id} type=${type}: ${messageText}`, 'error');
    }
  }

  private describeUnsupportedMessage(message: Message): string {
    const type = message.chat?.type ?? 'unknown';
    const keys = Object.keys(message).filter(
      (key) => !['message_id', 'date', 'chat', 'from'].includes(key),
    );
    return `[${type}] unsupported message (${keys.join(', ')})`;
  }

  private isAllowedParticipant(
    chatId?: number | string | null,
    userId?: number | string | null,
  ): boolean {
    if (this.allowedParticipantIds.size === 0) {
      return true;
    }

    const identifiers = [chatId, userId]
      .filter((value): value is number | string => value !== undefined && value !== null)
      .map((value) => String(value));

    if (identifiers.length === 0) {
      return false;
    }

    return identifiers.some((identifier) => this.allowedParticipantIds.has(identifier));
  }

  private log(message: string, level: 'info' | 'error' = 'info'): void {
    const prefix = '[telegram-bridge]';
    if (level === 'error') {
      console.error(prefix, message);
    } else {
      console.log(prefix, message);
    }
  }
}
