import { Provider } from '@nestjs/common';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

export const RedisProvider: Provider = {
  provide: REDIS_CLIENT,
  useValue: null,
};
