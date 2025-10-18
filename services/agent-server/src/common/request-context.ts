import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContextValue {
  readonly correlationId: string;
  readonly threadKey?: string;
  readonly idempotencyKey?: string;
}

/**
 * Stores per-request metadata using AsyncLocalStorage to support structured logging.
 */
@Injectable()
export class RequestContext {
  private readonly storage = new AsyncLocalStorage<RequestContextValue>();

  /**
   * Executes the provided callback within the supplied context boundary.
   *
   * @param context Metadata to associate with the async execution chain.
   * @param handler Callback to be run with the bound context.
   * @returns Result of the callback invocation.
   */
  run<T>(context: RequestContextValue, handler: () => T): T {
    return this.storage.run(context, handler);
  }

  /**
   * Retrieves metadata stored for the current async execution chain.
   *
   * @returns Context object or undefined when outside of a managed scope.
   */
  get(): RequestContextValue | undefined {
    return this.storage.getStore();
  }
}
