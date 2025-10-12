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

  constructor(private readonly config: AppConfigService) {
    const { url, token } = config.monica;
    this.baseUrl = this.normalizeBaseUrl(url);
    this.token = token;
  }

  async get<T>(
    path: string,
    options: MonicaRequestOptions<never> = {},
  ): Promise<T | null> {
    return this.request<T, never>('GET', path, options);
  }

  async post<TResponse, TBody>(
    path: string,
    body: TBody,
    options: MonicaRequestOptions<TBody> = {},
  ): Promise<TResponse | null> {
    return this.request<TResponse, TBody>('POST', path, {
      ...options,
      body,
    });
  }

  async put<TResponse, TBody>(
    path: string,
    body: TBody,
    options: MonicaRequestOptions<TBody> = {},
  ): Promise<TResponse | null> {
    return this.request<TResponse, TBody>('PUT', path, {
      ...options,
      body,
    });
  }

  async delete<T>(
    path: string,
    options: MonicaRequestOptions<never> = {},
  ): Promise<T | null> {
    return this.request<T, never>('DELETE', path, options);
  }

  private async request<TResponse, TBody>(
    method: string,
    path: string,
    options: MonicaRequestOptions<TBody>,
  ): Promise<TResponse | null> {
    const url = this.buildUrl(path, options.query);
    const headers = this.buildHeaders(options.headers);

    const response = await fetch(url, {
      method,
      headers,
      body:
        options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      throw await this.toError(response);
    }

    if (response.status === 204) {
      return null;
    }

    const data: TResponse = await response.json();
    return data;
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
    if (typeof payload === 'object' && payload !== null && 'error' in payload) {
      const envelope = payload as MonicaErrorEnvelope;
      const error = envelope.error;
      if (error && typeof error.message === 'string') {
        return error.message;
      }
    }

    return undefined;
  }
}
