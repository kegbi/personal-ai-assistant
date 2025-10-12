import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ToolCall } from '@langchain/core/messages/tool';
import { AppConfigService } from '../config/config.service';
import { REDIS_CLIENT, type RedisClient } from './redis.provider';

export interface MemoryMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string;
  meta?: Record<string, unknown>;
  toolCalls?: ToolCall[];
}

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redisClient: RedisClient,
    private readonly config: AppConfigService,
  ) {}

  private windowKey(chatId: string): string {
    return `memory:window:${chatId}`;
  }

  private handleKey(chatId: string, key: string): string {
    return `memory:handle:${chatId}:${key}`;
  }

  async getWindow(chatId: string): Promise<MemoryMessage[]> {
    const key = this.windowKey(chatId);
    const entries = await this.redisClient.lRange(key, 0, -1);

    if (!entries?.length) {
      return [];
    }

    return entries
      .map((item) => {
        try {
          return JSON.parse(item) as MemoryMessage;
        } catch (error) {
          const reason =
            error instanceof Error ? error.message : JSON.stringify(error);
          this.logger.warn(
            `Failed to parse memory message for chat ${chatId}: ${reason}`,
          );
          return null;
        }
      })
      .filter((item): item is MemoryMessage => item !== null);
  }

  async pushMessage(chatId: string, message: MemoryMessage): Promise<void> {
    const key = this.windowKey(chatId);
    const serialized = JSON.stringify(message);
    const windowSize = this.config.memory.windowSize;

    await this.redisClient
      .multi()
      .rPush(key, serialized)
      .lTrim(key, -windowSize, -1)
      .exec();
  }

  async getHandle(chatId: string, key: string): Promise<unknown> {
    const handleKey = this.handleKey(chatId, key);
    const raw = await this.redisClient.get(handleKey);

    if (raw === null) {
      return undefined;
    }

    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : JSON.stringify(error);
      this.logger.warn(
        `Failed to parse handle ${key} for chat ${chatId}: ${reason}`,
      );
      return undefined;
    }
  }

  async setHandle(
    chatId: string,
    key: string,
    value: unknown,
    ttlSeconds?: number,
  ): Promise<void> {
    const handleKey = this.handleKey(chatId, key);
    const payload = JSON.stringify(value);
    const ttl =
      ttlSeconds !== undefined
        ? ttlSeconds
        : this.config.memory.handleTtlSeconds;

    if (ttl && ttl > 0) {
      await this.redisClient.set(handleKey, payload, {
        EX: ttl,
      });
    } else {
      await this.redisClient.set(handleKey, payload);
    }
  }

  async clear(chatId: string): Promise<void> {
    const windowKey = this.windowKey(chatId);
    await this.redisClient.del(windowKey);

    const handleKeys: string[] = [];
    const iterator = this.redisClient.scanIterator({
      MATCH: `${this.handleKey(chatId, '*')}`,
      COUNT: 50,
    });

    for await (const handleKey of iterator) {
      let keyValue: string;
      if (typeof handleKey === 'string') {
        keyValue = handleKey;
      } else if (handleKey instanceof Buffer) {
        keyValue = handleKey.toString();
      } else {
        keyValue = String(handleKey);
      }

      handleKeys.push(keyValue);
    }

    if (handleKeys.length > 0) {
      await this.redisClient.del(handleKeys);
    }
  }
}
