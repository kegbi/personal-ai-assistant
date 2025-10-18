import { Logger, Provider } from '@nestjs/common';
import { createClient } from 'redis';
import type { RedisClientOptions } from 'redis';
import { AppConfigService } from '../config/config.service';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
export type RedisClient = ReturnType<typeof createClient>;

export const RedisProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [AppConfigService],
  useFactory: async (config: AppConfigService): Promise<RedisClient> => {
    const logger = new Logger('RedisClient');

    let socketOptions: NonNullable<RedisClientOptions['socket']>;

    if (config.redis.tls.enabled) {
      socketOptions = {
        host: config.redis.host,
        port: config.redis.port,
        tls: true,
        rejectUnauthorized: config.redis.tls.rejectUnauthorized,
      };
    } else {
      socketOptions = {
        host: config.redis.host,
        port: config.redis.port,
      };
    }

    const client = createClient({
      password: config.redis.password,
      socket: socketOptions,
    });

    client.on('error', (error) => {
      logger.error(
        `Redis client error: ${error instanceof Error ? error.message : error}`,
      );
    });

    await client.connect();

    return client;
  },
};
