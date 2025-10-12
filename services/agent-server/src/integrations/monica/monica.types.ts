export interface MonicaRequestOptions<TBody = unknown, TResponse = unknown> {
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  body?: TBody;
  parseResponse?: (payload: unknown) => TResponse;
}

export interface MonicaErrorEnvelope {
  error?: {
    message?: string;
    error_code?: number;
  };
}

export class MonicaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly payload: unknown,
  ) {
    super(message);
  }
}
