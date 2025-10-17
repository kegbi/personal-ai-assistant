import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { buildThreadKey, pickIdempotencyKey } from './keys.util';

const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const resolveThreadKey = (body: unknown): string | undefined => {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }

  const connectorId: unknown = Reflect.get(body, 'connectorId');
  const chatId: unknown = Reflect.get(body, 'chatId');

  if (
    typeof connectorId === 'string' &&
    connectorId.length > 0 &&
    typeof chatId === 'string' &&
    chatId.length > 0
  ) {
    return buildThreadKey(connectorId, chatId);
  }

  return undefined;
};

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest<Request>();
    const response = httpContext.getResponse<Response>();
    const { method, url } = request;

    const startedAt = Date.now();
    const correlationHeader = request.headers['x-correlation-id'];
    const correlationId =
      typeof correlationHeader === 'string' && correlationHeader.length > 0
        ? correlationHeader
        : randomUUID();
    const runId = correlationId;

    response.setHeader('x-correlation-id', correlationId);
    response.setHeader('x-run-id', runId);
    Reflect.set(request, 'correlationId', correlationId);
    Reflect.set(request, 'runId', runId);

    const body: unknown = request.body;
    const idempotencyKey = pickIdempotencyKey(body);
    const threadKey = resolveThreadKey(body);

    const formatMeta = (): string => {
      const idempotencyLabel = idempotencyKey ?? 'n/a';
      const threadLabel = threadKey ?? 'n/a';

      return [
        `runId=${runId}`,
        `correlationId=${correlationId}`,
        `idempotencyKey=${idempotencyLabel}`,
        `threadKey=${threadLabel}`,
      ].join(' ');
    };

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = Date.now() - startedAt;
          const statusCode = response.statusCode;
          this.logger.log(
            `${method} ${url} status=${statusCode} duration=${duration}ms ${formatMeta()}`,
          );
        },
        error: (error: unknown) => {
          const duration = Date.now() - startedAt;
          const statusCode =
            error instanceof HttpException
              ? error.getStatus()
              : response.statusCode;
          this.logger.error(
            `${method} ${url} status=${statusCode} duration=${duration}ms ${formatMeta()} message=${describeError(error)}`,
          );
        },
      }),
    );
  }
}
