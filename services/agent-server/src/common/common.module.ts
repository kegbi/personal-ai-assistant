import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { MemoryModule } from '../memory/memory.module';
import { GlobalExceptionFilter } from './exception.filter';
import { CacheService } from './cache.service';
import { IdempotencyService } from './idempotency.service';
import { LoggingInterceptor } from './logging.interceptor';
import { RequestContext } from './request-context';
import { JsonLogger } from './json-logger.service';

@Module({
  imports: [MemoryModule],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    CacheService,
    IdempotencyService,
    RequestContext,
    JsonLogger,
  ],
  exports: [CacheService, IdempotencyService, RequestContext, JsonLogger],
})
export class CommonModule {}
