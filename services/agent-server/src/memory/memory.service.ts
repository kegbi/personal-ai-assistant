import { Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { REDIS_CLIENT } from './redis.provider';

interface MemoryMessage {
  role: 'user' | 'assistant' | 'system';
  content?: string;
  meta?: Record<string, unknown>;
}

interface HandleEntry {
  value: unknown;
  expiresAt?: number;
}

@Injectable()
export class MemoryService {
  private readonly windows = new Map<string, MemoryMessage[]>();
  private readonly handles = new Map<string, Map<string, HandleEntry>>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redisClient: unknown,
    private readonly config: AppConfigService,
  ) {
    // prevent unused injection while Redis implementation is pending
    void this.redisClient;
  }

  // TODO: replace in-memory store with Redis implementation
  async getWindow(chatId: string): Promise<MemoryMessage[]> {
    return this.windows.get(chatId) ?? [];
  }

  async pushMessage(chatId: string, message: MemoryMessage): Promise<void> {
    const window = this.windows.get(chatId) ?? [];
    window.push(message);

    const windowSize = this.config.memory.windowSize;

    if (window.length > windowSize) {
      window.shift();
    }

    this.windows.set(chatId, window);
  }

  async getHandle(chatId: string, key: string): Promise<unknown> {
    const byChat = this.handles.get(chatId);
    if (!byChat) {
      return undefined;
    }

    const entry = byChat.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      byChat.delete(key);
      return undefined;
    }

    return entry.value;
  }

  async setHandle(
    chatId: string,
    key: string,
    value: unknown,
    ttlSeconds?: number,
  ): Promise<void> {
    const byChat = this.handles.get(chatId) ?? new Map<string, HandleEntry>();
    const ttl =
      ttlSeconds !== undefined ? ttlSeconds : this.config.memory.handleTtlSeconds;
    const expiresAt = ttl ? Date.now() + ttl * 1000 : undefined;

    byChat.set(key, { value, expiresAt });
    this.handles.set(chatId, byChat);
  }

  async clear(chatId: string): Promise<void> {
    this.windows.delete(chatId);
    this.handles.delete(chatId);
  }
}
