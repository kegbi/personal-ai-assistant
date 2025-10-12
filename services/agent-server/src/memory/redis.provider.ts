import { Logger, Provider } from '@nestjs/common';
import { createClient } from 'redis';
import { AppConfigService } from '../config/config.service';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
export type RedisClient = ReturnType<typeof createClient>;

export const RedisProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [AppConfigService],
  useFactory: async (
    config: AppConfigService,
  ): Promise<RedisClient> => {
    const logger = new Logger('RedisClient');
    const client = createClient({
      socket: {
        host: config.redis.host,
        port: config.redis.port,
      },
    });

    client.on('error', (error) => {
      logger.error(`Redis client error: ${error instanceof Error ? error.message : error}`);
    });

    await client.connect();

    return client;
  },
};
