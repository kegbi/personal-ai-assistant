import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Request } from 'express';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<Request>();
    const { method, url } = request;
    const startedAt = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = Date.now() - startedAt;
          this.logger.log(`${method} ${url} ${duration}ms`);
        },
        error: (error: unknown) => {
          const duration = Date.now() - startedAt;
          const message =
            error instanceof Error ? error.message : JSON.stringify(error);
          this.logger.warn(
            `${method} ${url} failed after ${duration}ms: ${message}`,
          );
        },
      }),
    );
  }
}
