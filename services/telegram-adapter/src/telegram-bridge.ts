import { Bot, GrammyError, HttpError } from 'grammy';
import type { Context, NextFunction } from 'grammy';
import type { Message } from 'grammy/types';
import type { AdapterConfig } from './config';
import { AgentClient } from './agent-client';
import type { AgentResponsePayload, BridgeStatus, MessageReceivedPayload } from './types';

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
  private readonly allowedChatIds: Set<string>;
  private readonly metrics: BridgeMetrics = {
    startedAt: new Date(),
    processedUpdates: 0,
  };
  private started = false;

  constructor(config: AdapterConfig, agentClient: AgentClient) {
    this.config = config;
    this.agentClient = agentClient;
    this.allowedChatIds = new Set(config.allowedChatIds);
    this.bot = new Bot(config.tgBotToken);

    this.registerMiddleware();
    this.registerHandlers();
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.bot.start({
      allowed_updates: ['message'],
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
      if (!this.isAllowedChat(ctx.chat?.id)) {
        if (ctx.chat?.id) {
          this.log(`Ignored update from disallowed chat ${ctx.chat.id}`);
        }
        return;
      }

      return next();
    });
  }

  private registerHandlers(): void {
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

  private buildBasePayload(ctx: Context): MessageReceivedPayload {
    const chatId = ctx.chat?.id ? String(ctx.chat.id) : 'unknown';
    const userId = ctx.from?.id ? String(ctx.from.id) : chatId;

    return {
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

  private describeUnsupportedMessage(message: Message): string {
    const type = message.chat?.type ?? 'unknown';
    const keys = Object.keys(message).filter(
      (key) => !['message_id', 'date', 'chat', 'from'].includes(key),
    );
    return `[${type}] unsupported message (${keys.join(', ')})`;
  }

  private isAllowedChat(chatId?: number | string | null): boolean {
    if (!chatId) {
      return false;
    }

    if (this.allowedChatIds.size === 0) {
      return true;
    }

    return this.allowedChatIds.has(String(chatId));
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
