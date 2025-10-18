import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ToolCall } from '@langchain/core/messages/tool';
import { AppConfigService } from '../config/config.service';
import { handleKeyFor, windowKeyFor } from '../common/keys.util';
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

  private windowKey(threadKey: string): string {
    return windowKeyFor(threadKey);
  }

  private handleKey(threadKey: string, key: string): string {
    return handleKeyFor(threadKey, key);
  }

  /**
   * Retrieves the current conversation window for the provided thread key.
   *
   * @param threadKey Deterministic identifier representing the connector/chat combination.
   * @returns Ordered list of memory messages associated with the thread.
   */
  async getWindow(threadKey: string): Promise<MemoryMessage[]> {
    const key = this.windowKey(threadKey);
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
            `Failed to parse memory message for thread ${threadKey}: ${reason}`,
          );
          return null;
        }
      })
      .filter((item): item is MemoryMessage => item !== null);
  }

  /**
   * Appends a message to the thread window while enforcing configured size limits.
   *
   * @param threadKey Deterministic identifier for the thread.
   * @param message Memory message to persist.
   */
  async pushMessage(threadKey: string, message: MemoryMessage): Promise<void> {
    const key = this.windowKey(threadKey);
    const serialized = JSON.stringify(message);
    const windowSize = this.config.memory.windowSize;

    await this.redisClient
      .multi()
      .rPush(key, serialized)
      .lTrim(key, -windowSize, -1)
      .exec();
  }

  /**
   * Retrieves a handle entry scoped to the provided thread.
   *
   * @param threadKey Deterministic identifier for the thread.
   * @param key Logical handle name to resolve.
   * @returns Parsed handle payload or undefined when absent.
   */
  async getHandle(threadKey: string, key: string): Promise<unknown> {
    const handleKey = this.handleKey(threadKey, key);
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
        `Failed to parse handle ${key} for thread ${threadKey}: ${reason}`,
      );
      return undefined;
    }
  }

  async setHandle(
    threadKey: string,
    key: string,
    value: unknown,
    ttlSeconds?: number,
  ): Promise<void> {
    const handleKey = this.handleKey(threadKey, key);
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

  /**
   * Removes the thread window and associated handles from Redis.
   *
   * @param threadKey Deterministic identifier for the thread.
   */
  async clear(threadKey: string): Promise<void> {
    const windowKey = this.windowKey(threadKey);
    await this.redisClient.del(windowKey);

    const handleKeys: string[] = [];
    const iterator = this.redisClient.scanIterator({
      MATCH: `${this.handleKey(threadKey, '*')}`,
      COUNT: 50,
    });

    for await (const handleKey of iterator) {
      if (typeof handleKey === 'string') {
        handleKeys.push(handleKey);
        continue;
      }

      if (handleKey instanceof Buffer) {
        handleKeys.push(handleKey.toString());
        continue;
      }

      handleKeys.push(String(handleKey));
    }

    if (handleKeys.length > 0) {
      await this.redisClient.del(handleKeys);
    }
  }
}
