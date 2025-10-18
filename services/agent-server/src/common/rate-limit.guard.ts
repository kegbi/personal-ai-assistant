import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { buildThreadKey } from './keys.util';
import { REDIS_CLIENT, type RedisClient } from '../memory/redis.provider';

const WINDOW_TTL_SECONDS = 65;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Applies a fixed-window rate limit per thread to protect the orchestrator endpoints.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly perMinuteLimit: number;
  private readonly burstAllowance: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redisClient: RedisClient,
    private readonly configService: AppConfigService,
  ) {
    this.perMinuteLimit = Math.max(0, configService.rateLimit.perMinute);
    this.burstAllowance = Math.max(0, configService.rateLimit.burst);
  }

  /**
   * Builds a Redis key combining the thread identifier with the current minute bucket.
   *
   * @param threadKey Thread identifier derived from connector and chat ids.
   * @returns Redis key used to store the request counter.
   */
  private buildWindowKey(threadKey: string): string {
    const minuteBucket = Math.floor(Date.now() / 60_000);
    return `rl:${threadKey}:${minuteBucket}`;
  }

  /**
   * Enforces the configured rate limit for the incoming request.
   *
   * @param context Nest execution context containing the HTTP request.
   * @returns True when the request is allowed to proceed.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ body?: unknown }>();
    const payload = request.body;

    if (!isRecord(payload)) {
      return true;
    }

    const connectorId =
      typeof payload.connectorId === 'string' ? payload.connectorId : undefined;
    const chatId =
      typeof payload.chatId === 'string' ? payload.chatId : undefined;

    if (!connectorId || !chatId) {
      return true;
    }

    const allowedRequests = this.perMinuteLimit + this.burstAllowance;

    if (allowedRequests <= 0) {
      return true;
    }

    const threadKey = buildThreadKey(connectorId, chatId);
    const windowKey = this.buildWindowKey(threadKey);

    const currentCount = await this.redisClient.incr(windowKey);

    if (currentCount === 1) {
      await this.redisClient.expire(windowKey, WINDOW_TTL_SECONDS);
    }

    if (currentCount > allowedRequests) {
      throw new HttpException(
        'Rate limit exceeded for this chat. Please slow down.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
