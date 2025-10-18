import { ConsoleLogger, Injectable } from '@nestjs/common';
import { RequestContext } from './request-context';

type LogLevel = 'info' | 'warn' | 'error' | 'debug' | 'verbose';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Outputs structured JSON log lines enriched with request context metadata.
 */
@Injectable()
export class JsonLogger extends ConsoleLogger {
  constructor(private readonly requestContext: RequestContext) {
    super();
  }

  override log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }

  override warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  override error(message: unknown, stack?: string, context?: string): void {
    this.write('error', message, context, stack);
  }

  override debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  override verbose(message: unknown, context?: string): void {
    this.write('verbose', message, context);
  }

  private write(
    level: LogLevel,
    message: unknown,
    context?: string,
    stack?: string,
  ): void {
    const target = level === 'error' ? process.stderr : process.stdout;
    const payload = this.preparePayload(level, message, context, stack);
    target.write(`${JSON.stringify(payload)}\n`);
  }

  private preparePayload(
    level: LogLevel,
    message: unknown,
    context?: string,
    stack?: string,
  ): Record<string, unknown> {
    const requestContext = this.requestContext.get();
    const extracted = this.extractMessageParts(message);
    const base: Record<string, unknown> = {
      level,
      timestamp: new Date().toISOString(),
      message: extracted.message,
    };

    if (context) {
      base.context = context;
    }

    if (stack) {
      base.stack = stack;
    }

    if (extracted.extra) {
      for (const [key, value] of Object.entries(extracted.extra)) {
        base[key] = value;
      }
    }

    if (requestContext) {
      if (requestContext.correlationId) {
        base.correlationId = requestContext.correlationId;
      }
      if (requestContext.threadKey) {
        base.threadKey = requestContext.threadKey;
      }
      if (requestContext.idempotencyKey) {
        base.idempotencyKey = requestContext.idempotencyKey;
      }
    }

    return base;
  }

  private extractMessageParts(value: unknown): {
    message: string;
    extra?: Record<string, unknown>;
  } {
    if (typeof value === 'string') {
      return { message: value };
    }

    if (value instanceof Error) {
      return {
        message: value.message,
        extra: {
          name: value.name,
        },
      };
    }

    if (isRecord(value)) {
      const extra: Record<string, unknown> = {};
      let resolvedMessage = '[structured_log]';

      for (const [key, entry] of Object.entries(value)) {
        if (key === 'message' && typeof entry === 'string') {
          resolvedMessage = entry;
        } else {
          extra[key] = entry;
        }
      }

      return {
        message: resolvedMessage,
        extra: Object.keys(extra).length > 0 ? extra : undefined,
      };
    }

    return { message: String(value) };
  }
}
