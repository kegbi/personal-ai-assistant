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
import { RequestContext } from './request-context';
import { JsonLogger } from './json-logger.service';
import { AppConfigService } from '../config/config.service';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const extractCorrelationId = (
  headerValue: string | readonly string[] | undefined,
): string => {
  if (typeof headerValue === 'string' && headerValue.length > 0) {
    return headerValue;
  }

  if (Array.isArray(headerValue) && headerValue.length > 0) {
    const candidate = headerValue.find(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    if (candidate) {
      return candidate;
    }
  }

  return randomUUID();
};

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
  if (!isRecord(body)) {
    return undefined;
  }

  const connectorId =
    typeof body.connectorId === 'string' && body.connectorId.length > 0
      ? body.connectorId
      : undefined;
  const chatId =
    typeof body.chatId === 'string' && body.chatId.length > 0
      ? body.chatId
      : undefined;

  if (!connectorId || !chatId) {
    return undefined;
  }

  return buildThreadKey(connectorId, chatId);
};

type SafeRequest = Omit<Request, 'body'> & { body: unknown };

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(
    private readonly requestContext: RequestContext,
    private readonly logger: JsonLogger,
    private readonly config: AppConfigService,
  ) {}

  private readonly prettyLogger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest<SafeRequest>();
    const response = httpContext.getResponse<Response>();
    const { method, url } = request;

    const correlationId = extractCorrelationId(
      request.headers['x-correlation-id'],
    );
    const runId = correlationId;
    const startedAt = Date.now();
    const body: unknown = request.body;
    const idempotencyKey = pickIdempotencyKey(body);
    const threadKey = resolveThreadKey(body);
    const useJson = this.config.logging.format === 'json';
    const threadLabel = threadKey ?? 'n/a';
    const idempotencyLabel = idempotencyKey ?? 'n/a';

    response.setHeader('x-correlation-id', correlationId);
    response.setHeader('x-run-id', runId);

    return this.requestContext.run(
      {
        correlationId,
        threadKey,
        idempotencyKey,
      },
      () =>
        next.handle().pipe(
          tap({
            next: () => {
              const durationMs = Date.now() - startedAt;
              if (useJson) {
                this.logger.log(
                  {
                    message: 'HTTP request completed',
                    method,
                    url,
                    statusCode: response.statusCode,
                    durationMs,
                    runId,
                  },
                  'HTTP',
                );
                return;
              }

              this.prettyLogger.log(
                `${method} ${url} status=${response.statusCode} duration=${durationMs}ms runId=${runId} threadKey=${threadLabel} idempotencyKey=${idempotencyLabel}`,
              );
            },
            error: (error: unknown) => {
              const durationMs = Date.now() - startedAt;
              const statusCode =
                error instanceof HttpException
                  ? error.getStatus()
                  : response.statusCode;
              if (useJson) {
                this.logger.error(
                  {
                    message: 'HTTP request failed',
                    method,
                    url,
                    statusCode,
                    durationMs,
                    runId,
                    error: describeError(error),
                  },
                  error instanceof Error ? error.stack : undefined,
                  'HTTP',
                );
                return;
              }

              const reason = describeError(error);
              this.prettyLogger.error(
                `${method} ${url} status=${statusCode} duration=${durationMs}ms runId=${runId} threadKey=${threadLabel} idempotencyKey=${idempotencyLabel} message=${reason}`,
              );
            },
          }),
        ),
    );
  }
}
