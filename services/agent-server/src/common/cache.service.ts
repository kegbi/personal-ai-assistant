import { Inject, Injectable, Logger } from '@nestjs/common';
import { REDIS_CLIENT, type RedisClient } from '../memory/redis.provider';

/**
 * Provides a minimal caching abstraction backed by Redis with JSON serialization.
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redisClient: RedisClient,
  ) {}

  /**
   * Retrieves a cached value when present, returning undefined on cache misses or parse failures.
   *
   * @param key Cache key to resolve.
   * @returns Parsed cache payload or undefined when absent.
   */
  async get<T>(
    key: string,
    validate?: (value: unknown) => value is T,
  ): Promise<T | undefined> {
    const raw = await this.redisClient.get(key);
    if (raw === null) {
      return undefined;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      const guard =
        validate ??
        ((value: unknown): value is T => {
          return value !== undefined || true;
        });

      if (guard(parsed)) {
        return parsed;
      }

      this.logger.warn(
        `Cached value for key ${key} failed validation. Ignoring entry.`,
      );
      return undefined;
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : JSON.stringify(error);
      this.logger.warn(`Failed to parse cache entry for key ${key}: ${reason}`);
      return undefined;
    }
  }

  /**
   * Stores a value under the provided cache key using optional TTL semantics.
   *
   * @param key Cache key to set.
   * @param value Serializable value to cache.
   * @param ttlSeconds Optional TTL in seconds; when omitted or non-positive, the entry persists.
   */
  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const payload = JSON.stringify(value);
    if (ttlSeconds && ttlSeconds > 0) {
      await this.redisClient.set(key, payload, { EX: ttlSeconds });
      return;
    }

    await this.redisClient.set(key, payload);
  }

  /**
   * Removes a cached entry without throwing on errors.
   *
   * @param key Cache key to remove.
   */
  async delete(key: string): Promise<void> {
    try {
      await this.redisClient.del(key);
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : JSON.stringify(error);
      this.logger.warn(`Failed to delete cache entry ${key}: ${reason}`);
    }
  }
}
