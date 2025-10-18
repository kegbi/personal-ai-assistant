import { Inject, Injectable } from '@nestjs/common';
import { REDIS_CLIENT, type RedisClient } from '../memory/redis.provider';

interface CachedEnvelope {
  payload: unknown;
  storedAt: number;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJson = (value: string): unknown => JSON.parse(value);

const isCachedEnvelope = (value: unknown): value is CachedEnvelope => {
  if (!isPlainRecord(value)) {
    return false;
  }

  const storedAt = value.storedAt;

  if (typeof storedAt !== 'number' || !Number.isFinite(storedAt)) {
    return false;
  }

  return 'payload' in value;
};

const DEFAULT_TTL_SECONDS = 600;

/**
 * Coordinates idempotent processing at the HTTP ingress using Redis as the backing store.
 */
@Injectable()
export class IdempotencyService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redisClient: RedisClient,
  ) {}

  private requestKey(threadKey: string, idempotencyKey: string): string {
    return `idemp:${threadKey}:${idempotencyKey}`;
  }

  private responseKey(threadKey: string, idempotencyKey: string): string {
    return `idempresp:${threadKey}:${idempotencyKey}`;
  }

  /**
   * Attempts to acquire processing rights for a given idempotency key.
   *
   * @param threadKey Key that scopes the idempotency domain (connector + chat).
   * @param idempotencyKey Unique identifier provided by the transport payload.
   * @param ttlSeconds Time-to-live for the acquired marker.
   * @returns True when processing should proceed; false when another worker already owns it.
   */
  async tryStart(
    threadKey: string,
    idempotencyKey: string,
    ttlSeconds = DEFAULT_TTL_SECONDS,
  ): Promise<boolean> {
    const status = await this.redisClient.set(
      this.requestKey(threadKey, idempotencyKey),
      '1',
      {
        NX: true,
        EX: ttlSeconds,
      },
    );

    return status === 'OK';
  }

  /**
   * Stores the serialized response associated with the idempotency key.
   *
   * @param threadKey Idempotency scope identifier.
   * @param idempotencyKey Unique identifier provided by the transport payload.
   * @param response Response payload to cache.
   * @param ttlSeconds Cache duration in seconds.
   */
  async storeResponse(
    threadKey: string,
    idempotencyKey: string,
    response: unknown,
    ttlSeconds = DEFAULT_TTL_SECONDS,
  ): Promise<void> {
    const envelope: CachedEnvelope = {
      payload: response,
      storedAt: Date.now(),
    };

    await this.redisClient.set(
      this.responseKey(threadKey, idempotencyKey),
      JSON.stringify(envelope),
      { EX: ttlSeconds },
    );
  }

  /**
   * Retrieves the cached response for the provided identifiers.
   *
   * @param threadKey Idempotency scope identifier.
   * @param idempotencyKey Unique identifier provided by the transport payload.
   * @returns Cached response payload or undefined when absent.
   */
  async getResponse(
    threadKey: string,
    idempotencyKey: string,
  ): Promise<unknown> {
    const raw = await this.redisClient.get(
      this.responseKey(threadKey, idempotencyKey),
    );

    if (raw === null) {
      return undefined;
    }

    try {
      const parsed = parseJson(raw);
      if (isCachedEnvelope(parsed)) {
        return parsed.payload;
      }
    } catch {
      return undefined;
    }

    return undefined;
  }
}
