import { Injectable, Logger } from '@nestjs/common';
import { URLSearchParams } from 'url';
import { AppConfigService } from '../../config/config.service';
import {
  MonicaApiError,
  MonicaErrorEnvelope,
  MonicaRequestOptions,
} from './monica.types';

@Injectable()
export class MonicaClient {
  private readonly logger = new Logger(MonicaClient.name);
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(private readonly config: AppConfigService) {
    const { url, token } = config.monica;
    this.baseUrl = this.normalizeBaseUrl(url);
    this.token = token;
    this.timeoutMs = Math.max(100, config.monica.timeoutMs);
    this.maxRetries = Math.max(0, config.monica.maxRetries);
    this.retryBaseMs = Math.max(50, config.monica.retryBaseMs);
  }

  async get<T>(
    path: string,
    options?: MonicaRequestOptions<never, T>,
  ): Promise<T | null> {
    return this.request<T, never>('GET', path, options);
  }

  async post<TResponse, TBody>(
    path: string,
    body: TBody,
    options?: MonicaRequestOptions<TBody, TResponse>,
  ): Promise<TResponse | null> {
    return this.request<TResponse, TBody>('POST', path, {
      ...(options ?? {}),
      body,
    });
  }

  async put<TResponse, TBody>(
    path: string,
    body: TBody,
    options?: MonicaRequestOptions<TBody, TResponse>,
  ): Promise<TResponse | null> {
    return this.request<TResponse, TBody>('PUT', path, {
      ...(options ?? {}),
      body,
    });
  }

  async delete<T>(
    path: string,
    options?: MonicaRequestOptions<never, T>,
  ): Promise<T | null> {
    return this.request<T, never>('DELETE', path, options);
  }

  private async request<TResponse, TBody>(
    method: string,
    path: string,
    options?: MonicaRequestOptions<TBody, TResponse>,
  ): Promise<TResponse | null> {
    const effectiveOptions: MonicaRequestOptions<TBody, TResponse> =
      options ?? {};
    const url = this.buildUrl(path, effectiveOptions.query);
    const headers = this.buildHeaders(effectiveOptions.headers);

    const maxRetries = this.maxRetries;
    const baseDelay = this.retryBaseMs;
    let attempt = 0;

    while (true) {
      attempt += 1;
      const signal = AbortSignal.timeout(this.timeoutMs);

      try {
        const response = await fetch(url, {
          method,
          headers,
          body:
            effectiveOptions.body !== undefined
              ? JSON.stringify(effectiveOptions.body)
              : undefined,
          signal,
        });

        if (!response.ok) {
          if (this.isRetryable(response.status) && attempt <= maxRetries) {
            await this.sleepWithJitter(baseDelay, attempt);
            continue;
          }
          throw await this.toError(response);
        }

        if (response.status === 204) {
          return null;
        }

        const payload: unknown = await response.json();
        if (!effectiveOptions.parseResponse) {
          throw new Error(
            `Missing response parser for Monica ${method} ${path} request.`,
          );
        }

        return effectiveOptions.parseResponse(payload);
      } catch (error) {
        if (attempt > maxRetries) {
          throw error;
        }

        if (this.shouldRetryAfterError(error)) {
          await this.sleepWithJitter(baseDelay, attempt);
          continue;
        }

        throw error;
      }
    }
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const searchParams = new URLSearchParams();

    if (query) {
      Object.entries(query).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          searchParams.append(key, String(value));
        }
      });
    }

    const queryString = searchParams.toString();
    return queryString
      ? `${this.baseUrl}${normalizedPath}?${queryString}`
      : `${this.baseUrl}${normalizedPath}`;
  }

  private buildHeaders(
    extraHeaders?: Record<string, string>,
  ): Record<string, string> {
    return {
      Accept: 'application/json',
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    };
  }

  private normalizeBaseUrl(url: string): string {
    return url.replace(/\/+$/, '');
  }

  private isRetryable(status: number): boolean {
    return status === 429 || (status >= 500 && status < 600);
  }

  private shouldRetryAfterError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return true;
    }

    const message = typeof error.message === 'string' ? error.message : '';
    const normalized = message.toLowerCase();
    return (
      normalized.includes('fetch') ||
      normalized.includes('network') ||
      normalized.includes('request failed')
    );
  }

  private async sleepWithJitter(
    baseMs: number,
    attempt: number,
  ): Promise<void> {
    const backoff = baseMs * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * Math.min(250, backoff * 0.1));
    await new Promise((resolve) => setTimeout(resolve, backoff + jitter));
  }

  private async toError(response: Response): Promise<Error> {
    let payload: unknown;

    try {
      payload = await response.json();
    } catch (error) {
      this.logger.warn(
        `Failed to parse Monica API error: ${error instanceof Error ? error.message : error}`,
      );
    }

    const message =
      response.statusText ||
      this.extractErrorMessage(payload) ||
      'Monica API error';

    const error = new MonicaApiError(message, response.status, payload);
    this.logger.error(
      `Monica API request failed with ${response.status}: ${message}`,
    );
    return error;
  }

  private extractErrorMessage(payload: unknown): string | undefined {
    if (!this.isMonicaErrorEnvelope(payload)) {
      return undefined;
    }

    const error = payload.error;
    if (!error || typeof error.message !== 'string') {
      return undefined;
    }

    return error.message;
  }

  /**
   * Determines whether the payload matches the Monica error envelope structure.
   *
   * @param payload Response payload to inspect.
   * @returns True when the payload includes a valid error envelope.
   */
  private isMonicaErrorEnvelope(
    payload: unknown,
  ): payload is MonicaErrorEnvelope {
    if (!this.isRecord(payload) || !('error' in payload)) {
      return false;
    }

    const errorValue = payload.error;
    if (errorValue === undefined) {
      return true;
    }

    if (!this.isRecord(errorValue)) {
      return false;
    }

    const message = errorValue.message;
    if (message !== undefined && typeof message !== 'string') {
      return false;
    }

    const code = errorValue.error_code;
    return code === undefined || code === null || typeof code === 'number';
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
